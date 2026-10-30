/**
 * Per-agent heartbeat runtime — the autonomic pipeline.
 *
 * One pulse runs: sensors (what changed) → rhythm (when may we speak next) →
 * gate (should we speak, at which level) → delivery (message via
 * `agent.followup`) → vitals (what happened, persisted).
 *
 * ## Delivery semantics (unchanged)
 *
 * - idle agent → `followup()` opens a turn immediately;
 * - busy agent → the message parks in the `next-turn` inbox, delivered right
 *   after the current turn ends;
 * - repeated busy ticks replace the pending beat in place (at most one).
 *
 * ## Silent pulses (v0.6)
 *
 * A pulse with no signal never injects anything: it only records an L0 row in
 * vitals. The token-costing turn is reserved for real signals.
 *
 * ## Safety (unchanged + persisted)
 *
 * - unanswered beats back off and, past `pauseAfterMissed`, hard-stop the timer;
 * - vitals persist missed count / paused / dedupe so a restart cannot reset the
 *   guard and immediately spam the user;
 * - `delivering` prevents overlapping async deliveries (compaction).
 *
 * @module dsh-plugin-heartbeat/runtime
 */

import { randomUUID } from 'node:crypto'
import { renderHeartbeatText } from './prompt.js'
import { collectSessionTasks, clampMaxItems, renderTaskSnapshot } from './tasks.js'
import { collectSignals as collectSignalsDefault } from './sensors.js'
import { computeIntervalMs, quietRemainingMs } from './rhythm.js'
import { decide as decideDefault } from './gate.js'
import { daypartOf, renderPhysiology } from './physiology.js'
import {
  claimProactiveLock as claimProactiveLockDefault,
  DEFAULT_PROACTIVE_COOLDOWN_SECONDS,
  defaultProactiveLockPath,
} from './proactive-lock.js'

const MIN_INTERVAL_SECONDS = 30
const MAX_INTERVAL_SECONDS = 86400
/** Pre-beat compaction budget: past this the beat ships un-compacted instead of waiting. */
const COMPACTION_TIMEOUT_MS = 60_000
/** Event-driven signals debounce before a pulse (avoid a burst on projection churn). */
const EVENT_DEBOUNCE_MS = 2_000

/** Normalize a possibly-undefined numeric input into a valid interval. */
export function clampIntervalSeconds(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.trunc(number)))
}

/**
 * Build one heartbeat message in the exact shape `dsh-agent-loop` expects
 * for `followup()` — the same shape the harness itself uses in
 * `injectUserContext` (createUserMessage + a producer-owned source kind).
 * @param {string} text
 * @returns {{ id: string, role: 'user', content: [{type:'text', text:string}], source: {kind:'plugin:heartbeat'} }}
 */
export function buildHeartbeatMessage(text) {
  return {
    id: `hb-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    // Session format v4 admits only a producer-owned kind. The retired
    // {kind:'plugin', plugin:'heartbeat'} wrapper is rejected at adoption
    // ("format v4 message requires a producer-owned source kind").
    source: { kind: 'plugin:heartbeat' },
  }
}

/**
 * @typedef {object} HeartbeatOptions
 * @property {() => object} readConfig resolve the effective v2 config per tick
 * @property {() => unknown} [getCompaction] host compaction service
 * @property {() => unknown} [getProjections] host sessionProjections service
 * @property {() => object | undefined} [getVitals] vitals store
 * @property {() => number | undefined} [getPressure] context pressure 0..1
 * @property {(options: object) => object} [collectSignals] injectable sensors (tests)
 * @property {(options: object) => object} [decide] injectable gate (tests)
 * @property {(options: object) => object} [claimProactiveLock] injectable lock (tests)
 * @property {string} [proactiveLockPath] shared proactive-cooldown file
 * @property {() => number} [now] clock injection
 * @property {unknown} logger
 * @property {object} [agents] live-agent registry for liveness checks
 */

export class HeartbeatRuntime {
  /**
   * @param {object} agent the live root agent (ReactLoopAgent shape)
   * @param {HeartbeatOptions} options
   */
  constructor(agent, options) {
    this.agent = agent
    this.readConfig = options.readConfig
    this.getCompaction = options.getCompaction
    this.getProjections = options.getProjections
    this.getVitals = options.getVitals
    this.getPressure = options.getPressure
    this.isChildActive = options.isChildActive
    this.isSubagentSession = options.isSubagentSession
    this.collectSignals = options.collectSignals ?? collectSignalsDefault
    this.decide = options.decide ?? decideDefault
    this.claimProactiveLockFn = options.claimProactiveLock ?? claimProactiveLockDefault
    this.proactiveLockPath = options.proactiveLockPath ?? defaultProactiveLockPath()
    this.logger = options.logger
    this.agents = options.agents
    this.now = options.now ?? (() => Date.now())
    this.timer = undefined
    this.eventTimer = undefined
    this.pendingId = undefined
    this.disposed = false
    this.delivering = false
    this.missedCount = 0
    this.paused = false
    this.beatTimes = []
    this.lastArousal = 0
    this.lastUserActivityAt = 0
    this.nextBeatAt = 0
    this.stopInserted = undefined
    // v0.7 physiology: cheap status sampling for busy-time / turn-end bookkeeping.
    this.lastStatus = undefined
    this.lastStatusAt = 0
    this.sessionId = agent.session?.id ?? agent.id
  }

  /** Begin the timer chain, load persisted guard state and subscribe to inbox events. */
  start() {
    if (this.disposed) return
    const session = this.vitalsSession()
    if (session !== undefined) {
      this.missedCount = Number(session.missedCount ?? 0)
      this.paused = session.paused === true
    }
    this.sampleStatus(this.now())
    this.stopInserted = this.agent.ctx.on?.('agent/inbox/inserted', ({ message }) => {
      if (message?.source?.kind !== 'user') return
      this.onUserInteraction()
    })
    this.arm()
  }

  /** Cancel pending work; the timer chain stops at the next boundary. */
  dispose() {
    this.disposed = true
    this.stopInserted?.()
    this.stopInserted = undefined
    this.clearTimer()
  }

  /** Drop the armed timers without changing paused state. */
  clearTimer() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.eventTimer !== undefined) {
      clearTimeout(this.eventTimer)
      this.eventTimer = undefined
    }
  }

  /** Vitals session state (or undefined when no vitals store is wired). */
  vitalsSession() {
    const vitals = typeof this.getVitals === 'function' ? this.getVitals() : undefined
    if (vitals === undefined) return undefined
    try {
      return vitals.get(this.sessionId)
    } catch {
      return undefined
    }
  }

  /** Vitals store (or undefined). */
  vitals() {
    return typeof this.getVitals === 'function' ? this.getVitals() : undefined
  }

  /** Record one pulse attempt in vitals (best-effort, never throws). */
  recordPulse(level, reason, delivered) {
    try {
      this.vitals()?.recordPulse(this.sessionId, { level, reason, delivered })
    } catch (error) {
      this.logger?.warn?.(`heartbeat: vitals write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Persist the projection signatures seen at this pulse. */
  recordSeen(seen) {
    try {
      const vitals = this.vitals()
      if (vitals !== undefined && seen !== undefined) vitals.setSeen(this.sessionId, seen)
    } catch {
      // best-effort
    }
  }

  /**
   * Sample the live agent status (v0.7). Cheap: called from the existing pulse
   * boundaries and from the host `agent/status` transition (index wiring), never
   * from its own timer. A busy→idle transition records the turn end; time spent
   * busy is accumulated per local day.
   *
   * @param {number} [now] epoch ms
   * @param {'idle'|'running'} [statusOverride] event payload status (default: live `agent.status`)
   */
  sampleStatus(now = this.now(), statusOverride) {
    const observed = statusOverride === 'idle' || statusOverride === 'running'
      ? statusOverride
      : this.agent?.status
    const status = observed === 'idle' ? 'idle' : 'busy'
    if (this.lastStatus === undefined || this.lastStatusAt === 0) {
      this.lastStatus = status
      this.lastStatusAt = now
      return
    }
    const elapsed = Math.max(0, now - this.lastStatusAt)
    try {
      const vitals = this.vitals()
      if (this.lastStatus === 'busy' && elapsed > 0) vitals?.noteBusy?.(this.sessionId, elapsed, now)
      if (this.lastStatus === 'busy' && status === 'idle') vitals?.noteTurnEnd?.(this.sessionId, now)
    } catch {
      // best-effort: physiology bookkeeping must never break a pulse
    }
    this.lastStatus = status
    this.lastStatusAt = now
  }

  /**
   * Claim the cross-plugin proactive floor (v0.7). Manual "Beat now" bypasses
   * this by design; `proactiveCooldownSeconds: 0` disables arbitration.
   *
   * @param {object} config effective config
   * @param {number} [now] epoch ms
   * @returns {{ok: boolean, deferredBy?: string}}
   */
  claimProactiveLock(config, now = this.now()) {
    try {
      return this.claimProactiveLockFn({
        path: this.proactiveLockPath,
        speaker: 'heartbeat',
        cooldownSeconds: Number(config?.proactiveCooldownSeconds ?? DEFAULT_PROACTIVE_COOLDOWN_SECONDS),
        now,
      })
    } catch (error) {
      this.logger?.warn?.(`heartbeat: proactive lock check failed: ${error instanceof Error ? error.message : String(error)}`)
      return { ok: true }
    }
  }

  /** Render the physiology line for this beat (`''` when there is nothing to say). */
  readPhysiology(config, now) {
    if (config?.physiologyLine === false) return ''
    const session = this.vitalsSession()
    if (session === undefined) return ''
    try {
      const vitals = this.vitals()
      const deliveredToday = typeof vitals?.deliveredToday === 'function' ? vitals.deliveredToday(now) : undefined
      return renderPhysiology({
        now,
        lastUserMessageAt: Number(session.lastUserMessageAt ?? 0),
        lastDeliveredAt: Number(session.lastDeliveredAt ?? 0),
        lastTurnEndAt: Number(session.lastTurnEndAt ?? 0),
        deliveredToday,
        daypart: daypartOf(new Date(now)),
      })
    } catch {
      return ''
    }
  }

  /** Arm the next pulse from the latest config; no-op while paused/disposed. */
  arm() {
    if (this.disposed || this.paused) return
    this.clearTimer()
    const config = this.readConfig()
    if (config.enabled === false) return
    const now = this.now()
    // Quiet hours: sleep until the window ends instead of polling.
    if (config.quietHours !== null && config.quietHours !== undefined) {
      try {
        const remaining = quietRemainingMs(config.quietHours, new Date(now))
        if (remaining > 0) {
          this.nextBeatAt = now + remaining + 1000
          this.timer = setTimeout(() => {
            this.timer = undefined
            this.safeTick()
          }, remaining + 1000)
          this.timer.unref?.()
          return
        }
      } catch {
        // fall through to a normal interval
      }
    }
    const session = this.vitalsSession()
    const intervalMs = computeIntervalMs({
      config,
      missed: this.missedCount,
      arousal: this.lastArousal,
      now,
      lastDeliveredAt: Number(session?.lastDeliveredAt ?? 0),
      sessionId: this.sessionId,
    })
    this.nextBeatAt = now + intervalMs
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.safeTick()
    }, intervalMs)
    this.timer.unref?.()
  }

  /** Lift a manual snooze/pause and re-arm from the current rhythm. */
  resume() {
    if (this.disposed) return
    this.paused = false
    this.missedCount = 0
    this.beatTimes = []
    try {
      const vitals = this.vitals()
      vitals?.setPaused(this.sessionId, false)
      vitals?.snooze(this.sessionId, 0)
      const session = this.vitalsSession()
      if (session !== undefined) session.missedCount = 0
    } catch {
      // best-effort
    }
    this.arm()
  }

  /** Re-arm immediately from the latest config (settings hot-reload). */
  reschedule() {
    if (this.disposed || this.paused) return
    this.arm()
  }

  /** Run one tick, swallowing errors so a bad pulse can never kill the timer. */
  safeTick() {
    try {
      this.tick()
    } catch (error) {
      this.logger?.warn?.(`heartbeat: tick failed for agent "${this.agent.id}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Event-driven wake-up (projection changed). Debounced, guarded, never throws. */
  noteSignal() {
    if (this.disposed || this.paused || this.delivering) return
    if (this.eventTimer !== undefined) return
    this.eventTimer = setTimeout(() => {
      this.eventTimer = undefined
      this.safeTick()
    }, EVENT_DEBOUNCE_MS)
    this.eventTimer.unref?.()
  }

  /**
   * A real user message arrived: fully reset — missed counter, pause, hourly
   * window — and re-arm from the current rhythm.
   */
  onUserInteraction() {
    if (this.disposed) return
    const wasPaused = this.paused
    const now = this.now()
    this.lastUserActivityAt = now
    this.missedCount = 0
    this.beatTimes = []
    this.paused = false
    try {
      const vitals = this.vitals()
      vitals?.setPaused(this.sessionId, false)
      // v0.7 physiology anchor: the persisted timestamp keeps the user-activity
      // suppression window alive across a restart (see gate.js).
      vitals?.setLastUserMessageAt?.(this.sessionId, now)
      const session = this.vitalsSession()
      if (session !== undefined) session.missedCount = 0
    } catch {
      // best-effort
    }
    if (wasPaused) this.logger?.info?.(`heartbeat: resumed after user interaction for agent "${this.agent.id}"`)
    this.arm()
  }

  /** Hard unattended stop: drop the timer; only a real user message revives. */
  pause(reason = 'unattended') {
    this.clearTimer()
    if (!this.paused) {
      this.paused = true
      try {
        this.vitals()?.setPaused(this.sessionId, true, reason)
      } catch {
        // best-effort
      }
      this.logger?.info?.(`heartbeat: paused (${reason}) for agent "${this.agent.id}"`)
    }
  }

  /** Collect signals for this session, defensively. */
  readSignals() {
    let pressure
    try {
      pressure = typeof this.getPressure === 'function' ? this.getPressure() : undefined
    } catch {
      pressure = undefined
    }
    try {
      const projections = typeof this.getProjections === 'function' ? this.getProjections() : undefined
      const result = this.collectSignals({
        projections,
        session: this.agent.session,
        vitals: this.vitals(),
        sessionId: this.sessionId,
        pressure: typeof pressure === 'number' ? pressure : undefined,
      })
      return result ?? { signals: [], arousal: 0, seen: undefined, pressure }
    } catch (error) {
      this.logger?.warn?.(`heartbeat: signal collection skipped for agent "${this.agent.id}": ${error instanceof Error ? error.message : String(error)}`)
      return { signals: [], arousal: 0, seen: undefined, pressure }
    }
  }

  /**
   * One pulse: sensors → restart cooldown → gate → silent record or delivery.
   * @returns {Promise<void> | undefined}
   */
  tick() {
    if (this.disposed || this.delivering) return undefined
    // Never beat a subagent conversation, even when the client resumes it as a
    // top-level view: heartbeat is for user-owned sessions only.
    if (this.subagentSession()) {
      this.dispose()
      return undefined
    }
    if (this.agents && this.agents.get(this.agent.id) !== this.agent) {
      this.dispose()
      return undefined
    }
    const config = this.readConfig()
    if (config.enabled === false) return undefined

    const now = this.now()
    this.sampleStatus(now)
    // Delegated work in progress: the root is idle only because it is waiting
    // for a child session. Pulsing here would inject a new turn into the middle
    // of that work (and compaction would fold away the live child card), so the
    // pulse stays silent until every child settles.
    if (config.quietWhileChildrenActive !== false && this.childWorkActive()) {
      this.recordPulse('L0', 'child-active', false)
      this.rearm()
      return undefined
    }
    // Hard stop gate: enough unanswered pulses → pause and never tick again.
    const pauseAfter = Math.max(0, Math.trunc(Number(config.pauseAfterMissed ?? 3)))
    if (pauseAfter > 0 && this.missedCount >= pauseAfter) {
      this.pause('unattended')
      return undefined
    }

    // Sliding hourly cap (explicit config; daily budget lives in the gate).
    const maxPerHour = Math.max(0, Math.trunc(Number(config.maxBeatsPerHour ?? 0)))
    if (maxPerHour > 0) {
      this.beatTimes = this.beatTimes.filter((time) => now - time < 3600_000)
      if (this.beatTimes.length >= maxPerHour) {
        this.logger?.info?.(`heartbeat: hourly cap (${maxPerHour}) reached, skipping pulse for agent "${this.agent.id}"`)
        this.rearm()
        return undefined
      }
    }

    const sensors = this.readSignals()
    this.lastArousal = Number(sensors.arousal ?? 0)

    // Restart safety: a process that just came up must not speak immediately.
    // Signals are NOT consumed here: the change stays detectable for the next pulse.
    if (this.restartCooldownActive() && sensors.signals.length > 0) {
      this.recordPulse('L0', 'restart-cooldown', false)
      this.rearm()
      return undefined
    }

    const decision = this.decide({
      config,
      vitals: this.vitals(),
      sessionId: this.sessionId,
      signals: sensors.signals,
      pressure: sensors.pressure,
      missed: this.missedCount,
      now,
      lastUserActivityAt: this.lastUserActivityAt,
      manual: false,
    })

    if (decision.level === 'L0') {
      // Only a definitive evaluation consumes the change set. A suppressed pulse
      // (quiet hours, budget, context pressure, snoozed, user active, silent
      // mode) must leave the signal readable, otherwise the change is lost.
      if (decision.suppressedBy === 'no-signal' || decision.suppressedBy === 'dedupe') {
        this.recordSeen(sensors.seen)
      }
      this.recordPulse('L0', decision.reason, false)
      this.rearm()
      return undefined
    }

    // v0.7 speech-right arbitration: yield to another proactive plugin (memory)
    // that spoke inside the cooldown window. The beat is dropped without
    // consuming the change set, recorded as L0 and retried on the next pulse.
    // Manual "Beat now" never reaches here (forceBeat bypasses the claim).
    const claim = this.claimProactiveLock(config, now)
    if (claim.ok !== true) {
      this.recordPulse('L0', `proactive-cooldown（让位给 ${claim.deferredBy ?? '其他插件'}）`, false)
      this.rearm()
      return undefined
    }

    this.recordSeen(sensors.seen)

    // Lightweight wake-up: fold long history into a checkpoint first so the
    // beat's turn reads less context. Best-effort — never blocks a beat.
    const compaction = typeof this.getCompaction === 'function' ? this.getCompaction() : undefined
    if (config.compactBeforeBeat !== false && this.agent.status === 'idle'
      && compaction && typeof compaction.compactNow === 'function') {
      this.delivering = true
      this.rearm()
      return this.compactThenDeliver(compaction, decision, config)
    }

    this.deliver(decision, config)
    this.rearm()
    return undefined
  }

  /** Whether this session is itself a descriptor-backed subagent conversation. */
  subagentSession() {
    if (typeof this.isSubagentSession !== 'function') return false
    try {
      return this.isSubagentSession() === true
    } catch {
      return false
    }
  }

  /** Whether any direct child session (subagent / teammate) is still running. */
  childWorkActive() {
    if (typeof this.isChildActive !== 'function') return false
    try {
      return this.isChildActive() === true
    } catch {
      return false
    }
  }

  restartCooldownActive() {
    try {
      return this.vitals()?.restartCooldownActive?.(this.sessionId, this.now()) === true
    } catch {
      return false
    }
  }

  /** Render the snapshot block (empty when task nudging is off). */
  readTaskBlock(config) {
    if (config.taskNudge === false) return ''
    try {
      const projections = typeof this.getProjections === 'function' ? this.getProjections() : undefined
      const snapshot = collectSessionTasks({
        projections,
        session: this.agent.session,
        maxItems: clampMaxItems(config.taskNudgeMaxItems),
      })
      return snapshot === undefined ? '' : renderTaskSnapshot(snapshot)
    } catch (error) {
      this.logger?.warn?.(`heartbeat: task snapshot skipped for agent "${this.agent.id}": ${error instanceof Error ? error.message : String(error)}`)
      return ''
    }
  }

  /** Build and deliver one beat; re-checks liveness after any async gap. */
  deliver(decision, config) {
    if (this.disposed) return false
    if (this.agents && this.agents.get(this.agent.id) !== this.agent) {
      this.dispose()
      return false
    }
    // `followup` / `inbox` are the agent-loop driver surface, not a catalogued
    // public API. Guard the calls so a future host rename can only cost one
    // beat (with a warning) instead of throwing inside the timer.
    const inbox = this.agent.inbox
    if (typeof this.agent.followup !== 'function'
      || inbox === undefined || typeof inbox.locate !== 'function' || typeof inbox.replace !== 'function') {
      this.logger?.warn?.(`heartbeat: agent "${this.agent.id}" has no followup/inbox surface, beat skipped`)
      return false
    }
    const now = this.now()
    const text = renderHeartbeatText({
      prompt: typeof config.prompt === 'string' && config.prompt.length > 0 ? config.prompt : null,
      now: new Date(now),
      taskBlock: this.readTaskBlock(config),
      reason: decision.reason,
      level: decision.level,
      l3Allow: Array.isArray(config.l3Allow) ? config.l3Allow : [],
      // v0.7 physiology signature: the switch hides it everywhere (built-in and
      // custom prompts); an empty render is dropped by prompt.js.
      physiology: this.readPhysiology(config, now),
      physiologyLine: config.physiologyLine !== false,
    })
    const message = buildHeartbeatMessage(text)

    const pending = this.pendingId !== undefined ? inbox.locate(this.pendingId) : undefined
    if (pending !== undefined) {
      // Still queued from an earlier tick (agent busy): replace in place so
      // at most one heartbeat is ever pending.
      inbox.replace(this.pendingId, message)
    } else {
      this.agent.followup(message)
    }
    this.pendingId = message.id
    this.missedCount += 1
    this.recordPulse(decision.level, decision.reason, true)
    try {
      const vitals = this.vitals()
      vitals?.markDelivered(this.sessionId, decision.keys ?? [])
      vitals?.bumpBudget(now)
      const session = this.vitalsSession()
      if (session !== undefined) session.missedCount = this.missedCount
    } catch {
      // best-effort
    }
    this.beatTimes.push(now)
    this.logger?.info?.(`heartbeat: ${decision.level} ${this.agent.status === 'idle' ? 'woke' : 'queued for'} agent "${this.agent.id}" (${decision.reason}; missed ${this.missedCount})`)
    return true
  }

  /**
   * Force one pulse from the settings panel ("Beat now"). Bypasses politeness
   * gates (disabled/paused/quiet/budget) but still respects the driver surface.
   * @param {string} [reason]
   * @returns {boolean} whether a message was delivered
   */
  forceBeat(reason = '手动触发（Beat now）') {
    if (this.disposed || this.delivering) return false
    const config = this.readConfig()
    const sensors = this.readSignals()
    this.lastArousal = Number(sensors.arousal ?? 0)
    this.recordSeen(sensors.seen)
    const decision = this.decide({
      config,
      vitals: this.vitals(),
      sessionId: this.sessionId,
      signals: sensors.signals,
      pressure: sensors.pressure,
      missed: this.missedCount,
      now: this.now(),
      lastUserActivityAt: this.lastUserActivityAt,
      manual: true,
    })
    const delivered = this.deliver({ ...decision, reason: decision.reason || reason }, config)
    this.rearm()
    return delivered
  }

  /**
   * Compact the idle session, then deliver the beat. Never rejects.
   *
   * 0.2.x compaction contract: `compactNow(agent, signal, sourceCommandId?)`
   * with a REQUIRED AbortSignal (`compactNow` calls `signal.throwIfAborted()`
   * before its try block). Passing `undefined` there throws on every idle beat,
   * which a try/catch would silently turn into "compaction never runs"; so a
   * real timeout signal is always supplied.
   */
  async compactThenDeliver(compaction, decision, config) {
    try {
      const signal = AbortSignal.timeout(COMPACTION_TIMEOUT_MS)
      const result = await compaction.compactNow(this.agent, signal)
      if (result) {
        this.logger?.info?.(`heartbeat: compacted before beat for agent "${this.agent.id}"`)
      }
    } catch (error) {
      this.logger?.warn?.(`heartbeat: pre-beat compaction skipped: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.delivering = false
    }
    try {
      this.deliver(decision, config ?? this.readConfig())
    } catch (error) {
      this.logger?.warn?.(`heartbeat: beat delivery failed for agent "${this.agent.id}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Re-arm the next beat unless paused/disposed/armed already. */
  rearm() {
    if (!this.disposed && !this.paused && this.timer === undefined) this.arm()
  }
}
