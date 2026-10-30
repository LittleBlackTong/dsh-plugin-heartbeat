/**
 * Runtime state ("vitals") store — the heartbeat's memory of its own pulses.
 *
 * Config (`heartbeat.json`) answers "what should the plugin do"; vitals answer
 * "what has it done". They live in separate files on purpose: users edit config
 * by hand, and runtime bookkeeping must not rewrite (or corrupt) their intent.
 *
 * Persisted per session:
 * - `lastPulseAt` / `lastDeliveredAt` — cooldown + restart-cooldown inputs;
 * - `lastUserMessageAt` / `lastTurnEndAt` / `busyMsToday` — the physiology
 *   signature (v0.7): when the user last spoke, when their last turn ended and
 *   how much wall-clock time the agent was busy today (`busyDay` guards the
 *   daily rollover). Missing fields in an old file simply read as 0;
 * - `missedCount` — habituation/backoff and L4 escalation;
 * - `paused` / `pausedReason` / `snoozeUntil` — manual and automatic stops;
 * - `seen` — last projection signatures, so a pulse can tell what *changed*;
 * - `asked` — dedupe ledger `{ [key]: { lastAt, count } }` with LRU trim;
 * - `history` — last N pulses with their level/reason (the observability view).
 *
 * Writes are atomic (tmp + rename) and debounced; read failures degrade to an
 * empty state so a corrupt file can never stop the plugin from loading.
 *
 * @module dsh-plugin-heartbeat/vitals
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const VITALS_VERSION = 1

export const VITALS_FILENAME = 'heartbeat-vitals.json'

export function defaultVitalsPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), VITALS_FILENAME)
}

/** Fresh per-session state. */
export function emptySessionState() {
  return {
    lastPulseAt: 0,
    lastDeliveredAt: 0,
    // v0.7 physiology signature (old files load these as 0/'').
    lastUserMessageAt: 0,
    lastTurnEndAt: 0,
    busyMsToday: 0,
    busyDay: '',
    missedCount: 0,
    paused: false,
    pausedReason: null,
    snoozeUntil: 0,
    seen: {},
    asked: {},
    history: [],
  }
}

/** Fresh whole-file state. */
export function emptyVitalsState() {
  return {
    version: VITALS_VERSION,
    global: { lastPulseAt: 0, budget: { day: '', beats: 0 } },
    sessions: {},
  }
}

/** Local calendar day key (`YYYY-MM-DD`). */
export function dayKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * @param {object} options
 * @param {string} [options.path] absolute vitals file path
 * @param {() => number} [options.now] clock injection (tests)
 * @param {number} [options.debounceMs] write debounce (default 2000)
 * @param {number} [options.historyLimit] history rows per session (default 10)
 * @param {number} [options.askedLimit] dedupe ledger rows per session (default 200)
 * @param {number} [options.restartCooldownSeconds] post-restart silence (default 300)
 */
export class VitalsStore {
  constructor(options = {}) {
    this.path = options.path ?? defaultVitalsPath()
    this.now = options.now ?? (() => Date.now())
    this.debounceMs = Math.max(0, Number(options.debounceMs ?? 2000))
    this.historyLimit = Math.max(1, Number(options.historyLimit ?? 10))
    this.askedLimit = Math.max(1, Number(options.askedLimit ?? 200))
    this.restartCooldownSeconds = Math.max(0, Number(options.restartCooldownSeconds ?? 300))
    this.state = emptyVitalsState()
    this.writeTimer = undefined
    this.disposed = false
    this.load()
    // Any session that was speaking right before this process started gets a
    // forced silent window, so a restart can never cause an immediate burst.
    this.loadedAt = this.now()
    this.recordStartup()
  }

  /** Read the file; corrupt/missing → empty state. */
  load() {
    try {
      if (!existsSync(this.path)) return
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
      const sessions = {}
      if (raw.sessions !== null && typeof raw.sessions === 'object') {
        for (const [sessionId, value] of Object.entries(raw.sessions)) {
          if (value === null || typeof value !== 'object') continue
          sessions[sessionId] = {
            ...emptySessionState(),
            ...value,
            // v0.7 fields: a pre-v0.7 file has none of these → 0/''.
            lastUserMessageAt: Number(value.lastUserMessageAt ?? 0) || 0,
            lastTurnEndAt: Number(value.lastTurnEndAt ?? 0) || 0,
            busyMsToday: Math.max(0, Number(value.busyMsToday ?? 0) || 0),
            busyDay: typeof value.busyDay === 'string' ? value.busyDay : '',
            seen: value.seen !== null && typeof value.seen === 'object' ? value.seen : {},
            asked: value.asked !== null && typeof value.asked === 'object' ? value.asked : {},
            history: Array.isArray(value.history) ? value.history.slice(-this.historyLimit) : [],
          }
        }
      }
      const budget = raw.global?.budget ?? { day: '', beats: 0 }
      this.state = {
        version: VITALS_VERSION,
        global: {
          lastPulseAt: Number(raw.global?.lastPulseAt ?? 0),
          budget: { day: String(budget.day ?? ''), beats: Number(budget.beats ?? 0) },
        },
        sessions,
      }
    } catch {
      this.state = emptyVitalsState()
    }
  }

  /** Per-session state, created on first access. Live reference — do not mutate externally. */
  get(sessionId) {
    let session = this.state.sessions[sessionId]
    if (session === undefined) {
      session = emptySessionState()
      this.state.sessions[sessionId] = session
    }
    return session
  }

  /** Record one pulse attempt (silent or delivered). */
  recordPulse(sessionId, { level, reason, delivered }) {
    const at = this.now()
    const session = this.get(sessionId)
    session.lastPulseAt = at
    if (delivered) session.lastDeliveredAt = at
    session.history.push({ at, level, reason: String(reason ?? ''), delivered: delivered === true })
    if (session.history.length > this.historyLimit) session.history.splice(0, session.history.length - this.historyLimit)
    this.state.global.lastPulseAt = at
    this.scheduleWrite()
  }

  /** Mark dedupe keys as asked now (bumps their counters). */
  markDelivered(sessionId, keys) {
    if (!Array.isArray(keys) || keys.length === 0) return
    const at = this.now()
    const session = this.get(sessionId)
    for (const key of keys) {
      const previous = session.asked[key]
      session.asked[key] = { lastAt: at, count: Number(previous?.count ?? 0) + 1 }
    }
    const entries = Object.entries(session.asked)
    if (entries.length > this.askedLimit) {
      entries.sort((left, right) => Number(left[1]?.lastAt ?? 0) - Number(right[1]?.lastAt ?? 0))
      const drop = entries.length - this.askedLimit
      for (let index = 0; index < drop; index += 1) delete session.asked[entries[index][0]]
    }
    this.scheduleWrite()
  }

  /** Persist the last-seen projection signatures for change detection. */
  setSeen(sessionId, seen) {
    if (seen === null || typeof seen !== 'object') return
    const session = this.get(sessionId)
    session.seen = { ...session.seen, ...seen }
    this.scheduleWrite()
  }

  setPaused(sessionId, paused, reason) {
    const session = this.get(sessionId)
    session.paused = paused === true
    session.pausedReason = paused === true ? String(reason ?? 'manual') : null
    this.scheduleWrite()
  }

  snooze(sessionId, untilMs) {
    const session = this.get(sessionId)
    session.snoozeUntil = Number(untilMs ?? 0)
    this.scheduleWrite()
  }

  /** Remember when the user last sent a real message (physiology anchor). */
  setLastUserMessageAt(sessionId, atMs = this.now()) {
    const session = this.get(sessionId)
    session.lastUserMessageAt = Math.max(0, Number(atMs ?? 0) || 0)
    this.scheduleWrite()
  }

  /** Remember when the agent's last turn ended (fallback physiology anchor). */
  noteTurnEnd(sessionId, atMs = this.now()) {
    const session = this.get(sessionId)
    session.lastTurnEndAt = Math.max(0, Number(atMs ?? 0) || 0)
    this.scheduleWrite()
  }

  /**
   * Accumulate busy wall-clock time for today (daily rollover by local day).
   * Cheap by design: callers sample `agent.status` on their existing ticks.
   */
  noteBusy(sessionId, deltaMs, nowMs = this.now()) {
    const delta = Math.max(0, Number(deltaMs ?? 0) || 0)
    if (delta === 0) return
    const session = this.get(sessionId)
    const day = dayKey(new Date(nowMs))
    if (session.busyDay !== day) {
      session.busyDay = day
      session.busyMsToday = 0
    }
    session.busyMsToday += delta
    this.scheduleWrite()
  }

  /** Proactive beats already delivered today (`0` once the day rolls over). */
  deliveredToday(nowMs = this.now()) {
    const budget = this.state.global.budget
    return budget.day === dayKey(new Date(nowMs)) ? Number(budget.beats ?? 0) : 0
  }

  /** Count one delivered beat against today's budget; resets on day rollover. */
  bumpBudget(nowMs = this.now()) {
    const day = dayKey(new Date(nowMs))
    const budget = this.state.global.budget
    if (budget.day !== day) {
      budget.day = day
      budget.beats = 0
    }
    budget.beats += 1
    this.scheduleWrite()
    return { ...budget }
  }

  /** Beats left today (`maxBeatsPerDay: 0` means unlimited). */
  budgetLeft(config, nowMs = this.now()) {
    const max = Math.max(0, Number(config?.maxBeatsPerDay ?? 0))
    if (max === 0) return Number.POSITIVE_INFINITY
    const day = dayKey(new Date(nowMs))
    const budget = this.state.global.budget
    if (budget.day !== day) return max
    return Math.max(0, max - budget.beats)
  }

  /** True while the post-restart silent window has not elapsed. */
  restartCooldownActive(sessionId, nowMs = this.now()) {
    if (this.restartCooldownSeconds === 0) return false
    const session = this.get(sessionId)
    const last = Number(session.lastDeliveredAt ?? 0)
    if (last === 0) return false
    return nowMs - last < this.restartCooldownSeconds * 1000
  }

  /** Remember the process start so callers can reason about restart safety. */
  recordStartup() {
    this.state.global.startedAt = this.loadedAt
    this.scheduleWrite()
  }

  scheduleWrite() {
    if (this.disposed) return
    if (this.debounceMs === 0) {
      this.write()
      return
    }
    if (this.writeTimer !== undefined) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined
      this.write()
    }, this.debounceMs)
    this.writeTimer.unref?.()
  }

  /** Write now (atomic). Failures are swallowed: vitals are best-effort. */
  write() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`)
      renameSync(tmp, this.path)
    } catch {
      // Best-effort: state stays in memory and the next write retries.
    }
  }

  /** Flush pending writes (call on dispose). */
  flush() {
    if (this.writeTimer !== undefined) {
      clearTimeout(this.writeTimer)
      this.writeTimer = undefined
    }
    this.write()
  }

  /** Flush and stop accepting writes. */
  dispose() {
    this.flush()
    this.disposed = true
  }
}
