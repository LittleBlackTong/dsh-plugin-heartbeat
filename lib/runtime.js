/**
 * Per-agent heartbeat runtime: a re-arming, backoff-based timer per live
 * root agent, with a hard unattended stop and optional pre-beat compaction.
 *
 * Mirrors the `dsh-schedule` design — a host-plane plugin listens for
 * `agent/created`, builds one runtime per root agent, and hangs that
 * runtime's lifecycle off the agent's own context so it dies with the
 * session.
 *
 * ## Delivery semantics (verified against `dsh-agent-loop`)
 *
 * - agent idle  → `followup()` opens a new turn immediately;
 * - agent busy  → the message parks in the `next-turn` inbox and is claimed
 *   right after the current turn ends (never interrupts, never gets lost);
 * - busy ticks  → at most ONE heartbeat stays pending: the previous one is
 *   replaced in place via `inbox.replace`, so no backlog piles up.
 *
 * ## Backoff schedule (v0.4.0)
 *
 * The interval grows with every unanswered beat: `[base, 2×base, 3×base]`
 * derived from `intervalSeconds` (10 → 20 → 30 minutes by default), or an
 * explicit `backoffSeconds` array. A real user message resets the counter
 * AND re-arms the first tier from that moment, so active conversations
 * never get interrupted and the phase always restarts after human speech.
 *
 * ## Hard unattended stop (token guard)
 *
 * After `pauseAfterMissed` unanswered beats the runtime pauses for good:
 * the armed timer is dropped and no new beat is ever delivered — only a
 * real user message (`source.kind === 'user'`) can resume it. This is the
 * guarantee that a silent session cannot keep burning tokens.
 *
 * ## Lightweight wake-ups
 *
 * `compactBeforeBeat` (default on) asks the host's `ctx.compaction` service
 * to run `compactNow` before delivering a beat to an idle agent, folding
 * long history into a checkpoint summary so the wake-up turn reads far less
 * context. Failures are swallowed: compaction is an optimization, never a
 * reason to drop the beat. `maxBeatsPerHour` (0 = off) caps beats in any
 * 60-minute sliding window for users who answer sporadically and would
 * otherwise reset the backoff forever.
 *
 * @module dsh-plugin-heartbeat/runtime
 */

import { randomUUID } from 'node:crypto'
import { renderPrompt } from './prompt.js'

const MIN_INTERVAL_SECONDS = 30
const MAX_INTERVAL_SECONDS = 86400

/** Normalize a possibly-undefined numeric input into a valid interval. */
export function clampIntervalSeconds(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.trunc(number)))
}

/**
 * Build the backoff schedule for a config: an explicit array when provided,
 * otherwise `[base, 2×base, …, pauseAfterMissed×base]` derived tiers.
 * NOTE: this is the original upstream design — do not alter the backoff or
 * pause semantics.
 * @param {object} config
 * @returns {number[]} monotonically increasing seconds-per-tier
 */
export function buildSchedule(config) {
  const base = clampIntervalSeconds(config.intervalSeconds, 600)
  if (Array.isArray(config.backoffSeconds) && config.backoffSeconds.length > 0) {
    const tiers = config.backoffSeconds.map((value) => clampIntervalSeconds(value, base))
    for (let i = 1; i < tiers.length; i += 1) {
      if (tiers[i] < tiers[i - 1]) tiers[i] = tiers[i - 1]
    }
    return tiers
  }
  const pauseAfter = Math.max(1, Math.trunc(Number(config.pauseAfterMissed ?? 3)))
  const tiers = [base]
  for (let i = 1; i < pauseAfter; i += 1) {
    tiers.push(Math.min(MAX_INTERVAL_SECONDS, base * (i + 1)))
  }
  return tiers
}

/**
 * Build one heartbeat message in the exact shape `dsh-agent-loop` expects
 * for `followup()` — the same shape the harness itself uses in
 * `injectUserContext` (createUserMessage + a producer-owned source kind).
 * The kind must be producer-owned: session format v4 refuses the retired
 * `kind: 'plugin'` wrapper ("format v4 message requires a producer-owned
 * source kind"), so a third-party producer uses `plugin:<name>`.
 * @param {string} text
 * @returns {{ id: string, role: 'user', content: [{type:'text', text:string}], source: {kind:'plugin:heartbeat'} }}
 */
export function buildHeartbeatMessage(text) {
  return {
    id: `hb-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:heartbeat' },
  }
}

/**
 * @typedef {object} HeartbeatOptions
 * @property {() => { enabled: boolean, intervalSeconds: number, prompt: string, pauseAfterMissed: number, backoffSeconds?: number[], compactBeforeBeat: boolean, maxBeatsPerHour: number }} readConfig
 *   Resolve the effective config on every tick (settings layer wins over
 *   composition config; hot reload takes effect at the next tick).
 * @property {() => unknown} [getCompaction] Optional host compaction service provider.
 * @property {unknown} logger Optional logger with info/warn methods.
 * @property {object} [agents] Optional live-agent registry for liveness checks.
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
    this.logger = options.logger
    this.agents = options.agents
    this.timer = undefined
    this.pendingId = undefined
    this.disposed = false
    this.missedCount = 0
    this.paused = false
    this.beatTimes = []
    this.stopInserted = undefined
  }

  /** Begin the timer chain and subscribe to the agent's inbox feed. */
  start() {
    if (this.disposed) return
    this.stopInserted = this.agent.ctx.on?.('agent/inbox/inserted', ({ message }) => {
      if (message?.source?.kind === 'user') this.onUserInteraction()
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

  /** Drop the armed timer without changing paused state. */
  clearTimer() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** Interval for the next beat: backoff tier selected by missedCount. */
  currentIntervalMs(config) {
    const schedule = buildSchedule(config)
    const tier = Math.min(this.missedCount, schedule.length - 1)
    return schedule[tier] * 1000
  }

  /** Arm the next beat from the latest config; no-op while paused/disposed. */
  arm() {
    if (this.disposed || this.paused) return
    this.clearTimer()
    const intervalMs = this.currentIntervalMs(this.readConfig())
    this.timer = setTimeout(() => {
      this.timer = undefined
      try {
        this.tick()
      } catch (error) {
        this.logger?.warn?.(`heartbeat: tick failed for agent "${this.agent.id}": ${error instanceof Error ? error.message : String(error)}`)
      }
    }, intervalMs)
    // Node timers refuse values above 2^31-1 ms; the clamps keep us far below it.
    this.timer.unref?.()
  }

  /** Re-arm immediately from the latest config (settings hot-reload). */
  reschedule() {
    if (this.disposed || this.paused) return
    this.arm()
  }

  /**
   * A real user message arrived: fully reset — missed counter to zero, the
   * hourly window cleared, pause lifted, and the first tier re-armed from
   * THIS moment, so the heartbeat only speaks after fresh human activity.
   */
  onUserInteraction() {
    if (this.disposed) return
    const wasPaused = this.paused
    this.missedCount = 0
    this.beatTimes = []
    this.paused = false
    if (wasPaused) {
      this.logger?.info?.(`heartbeat: resumed after user interaction for agent "${this.agent.id}"`)
    }
    this.arm()
  }

  /** Hard unattended stop: drop the timer; only a real user message revives. */
  pause() {
    this.clearTimer()
    if (!this.paused) {
      this.paused = true
      this.logger?.info?.(`heartbeat: paused (unattended) for agent "${this.agent.id}"`)
    }
  }

  /**
   * One beat attempt — synchronous for the no-compaction path (timer-safe,
   * test-friendly). When a compaction service is available and the agent is
   * idle, delivery is deferred onto the compaction promise (fire-and-forget,
   * never rejects) and that promise is returned so callers may await it.
   * @returns {Promise<void> | undefined}
   */
  tick() {
    if (this.disposed) return undefined
    if (this.agents && this.agents.get(this.agent.id) !== this.agent) {
      this.dispose()
      return undefined
    }
    const config = this.readConfig()
    if (config.enabled === false) return undefined

    // Hard stop gate: enough unanswered beats → pause and never tick again.
    const pauseAfter = Math.max(0, Math.trunc(Number(config.pauseAfterMissed ?? 3)))
    if (pauseAfter > 0 && this.missedCount >= pauseAfter) {
      this.pause()
      return undefined
    }

    // Sliding hourly cap: skip (not count) beats beyond the budget.
    const maxPerHour = Math.max(0, Math.trunc(Number(config.maxBeatsPerHour ?? 0)))
    if (maxPerHour > 0) {
      const now = Date.now()
      this.beatTimes = this.beatTimes.filter((time) => now - time < 3600_000)
      if (this.beatTimes.length >= maxPerHour) {
        this.logger?.info?.(`heartbeat: hourly cap (${maxPerHour}) reached, skipping beat for agent "${this.agent.id}"`)
        this.rearm()
        return undefined
      }
      this.beatTimes.push(now)
    }

    // Lightweight wake-up: fold long history into a checkpoint first so the
    // beat's turn reads less context. Best-effort — never blocks a beat.
    const compaction = typeof this.getCompaction === 'function' ? this.getCompaction() : undefined
    if (config.compactBeforeBeat !== false && this.agent.status === 'idle'
      && compaction && typeof compaction.compactNow === 'function') {
      this.rearm()
      return this.compactThenDeliver(compaction)
    }

    this.deliverBeat(config)
    this.rearm()
    return undefined
  }

  /** Build and deliver one beat; re-checks liveness after any async gap. */
  deliverBeat(config) {
    if (this.disposed) return
    if (this.agents && this.agents.get(this.agent.id) !== this.agent) {
      this.dispose()
      return
    }
    const text = renderPrompt(config.prompt || '【心跳】', new Date())
    const message = buildHeartbeatMessage(text)

    const inbox = this.agent.inbox
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
    this.logger?.info?.(`heartbeat: ${this.agent.status === 'idle' ? 'woke' : 'queued for'} agent "${this.agent.id}" (missed ${this.missedCount})`)
  }

  /** Compact the idle session, then deliver the beat. Never rejects. */
  async compactThenDeliver(compaction) {
    try {
      const result = await compaction.compactNow(this.agent, undefined, 'heartbeat')
      if (result) {
        this.logger?.info?.(`heartbeat: compacted before beat for agent "${this.agent.id}"`)
      }
    } catch (error) {
      this.logger?.warn?.(`heartbeat: pre-beat compaction skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.deliverBeat(this.readConfig())
  }

  /** Re-arm the next beat unless paused/disposed/armed already. */
  rearm() {
    if (!this.disposed && !this.paused && this.timer === undefined) this.arm()
  }
}
