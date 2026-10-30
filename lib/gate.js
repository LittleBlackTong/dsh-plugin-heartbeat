/**
 * Gate — the decision layer: should this pulse speak, and at which level?
 *
 * Inputs are the sensor signals plus rhythm context; outputs are one of
 * L0 (silent), L1 (report), L2 (ask), L4 (escalated ask). The gate owns all
 * "is it polite to speak right now" policy so the runtime stays mechanical:
 *
 * - hard preconditions: disabled / snoozed / paused / quiet hours / context
 *   pressure / user just spoke;
 * - dedupe: a signal key already asked inside `dedupeWindowMinutes` is dropped;
 * - priority: decision-bearing signals (ready/blocked/goal/question) → L2,
 *   progress-only → L1; a repeated decision signal with `missed >= 2` → L4;
 * - budgets: daily delivered-beat cap;
 * - `manual` (panel "Beat now") bypasses politeness but not level selection.
 *
 * @module dsh-plugin-heartbeat/gate
 */

import { inQuietHours } from './rhythm.js'

/** Signal kinds that need a human decision (L2), not just a report (L1). */
export const DECISION_KINDS = new Set(['team-ready', 'team-blocked', 'goal', 'question'])

/** User activity closer than this suppresses an unrequested beat. */
export const USER_ACTIVE_SUPPRESS_MS = 2 * 60_000

/** Context pressure above this suppresses an unrequested beat. */
export const CONTEXT_PRESSURE_LIMIT = 0.9

/** Compose a one-line reason for the message's "why now" line. */
export function reasonOf(signals, fallback) {
  if (!Array.isArray(signals) || signals.length === 0) return fallback
  const head = signals[0]?.text ?? String(signals[0]?.key ?? 'signal')
  return signals.length > 1 ? `${head}（等 ${signals.length} 条信号）` : head
}

/**
 * Decide the activation level for one pulse.
 *
 * @param {object} options
 * @param {object} options.config effective v2 config
 * @param {object} options.vitals vitals store (`get(sessionId)`)
 * @param {string} options.sessionId
 * @param {Array<object>} [options.signals] sensor signals
 * @param {number} [options.pressure] context pressure 0..1
 * @param {number} [options.missed] unanswered beat count
 * @param {number} [options.now] epoch ms
 * @param {number} [options.lastUserActivityAt] epoch ms of last real user message
 * @param {boolean} [options.manual] panel-triggered beat (bypasses politeness)
 * @returns {{level: 'L0'|'L1'|'L2'|'L4', reason: string, keys: string[], suppressedBy?: string}}
 */
export function decide({
  config = {},
  vitals,
  sessionId,
  signals = [],
  pressure,
  missed = 0,
  now = Date.now(),
  lastUserActivityAt = 0,
  manual = false,
} = {}) {
  const silent = (suppressedBy, reason = suppressedBy) => ({ level: 'L0', reason, keys: [], suppressedBy })

  const levelFor = (list) => (list.some((signal) => DECISION_KINDS.has(signal.kind)) ? 'L2' : 'L1')

  if (manual) {
    const keys = signals.map((signal) => signal.key)
    return { level: levelFor(signals), reason: reasonOf(signals, '手动触发（Beat now）'), keys }
  }

  if (config.enabled === false) return silent('disabled')
  const session = vitals?.get(sessionId)
  if (session !== undefined) {
    if (Number(session.snoozeUntil ?? 0) > now) return silent('snoozed', '已打盹（snooze）')
    if (session.paused === true) return silent('paused', session.pausedReason ?? '已暂停')
  }
  if (inQuietHours(config.quietHours, new Date(now))) return silent('quiet', '静默时段')
  if (typeof pressure === 'number' && pressure > CONTEXT_PRESSURE_LIMIT) {
    return silent('context-pressure', '上下文接近上限，本拍静默')
  }
  if (lastUserActivityAt > 0 && now - lastUserActivityAt < USER_ACTIVE_SUPPRESS_MS) {
    return silent('user-active', '你刚说过话，本拍静默')
  }

  // Dedupe: drop signals already asked inside the window.
  const windowMs = Math.max(0, Number(config.dedupeWindowMinutes ?? 0)) * 60_000
  const asked = session?.asked ?? {}
  const fresh = signals.filter((signal) => {
    const entry = asked[signal.key]
    if (entry === undefined || windowMs === 0) return true
    return now - Number(entry.lastAt ?? 0) >= windowMs
  })
  if (fresh.length === 0) {
    return silent(signals.length === 0 ? 'no-signal' : 'dedupe', signals.length === 0 ? '没有新信号' : '同一事项在去重窗口内已提醒过')
  }

  if (config.mode === 'silent') return silent('mode-silent', '静默模式（只检查不开口）')

  // Budgets: a delivered beat has already been counted at delivery time, so we
  // compare against what is left *now*.
  if (vitals !== undefined && typeof vitals.budgetLeft === 'function') {
    const left = vitals.budgetLeft(config, now)
    if (left <= 0) return silent('budget', '今日主动消息预算已用完')
  }

  const keys = fresh.map((signal) => signal.key)
  const hasDecision = fresh.some((signal) => DECISION_KINDS.has(signal.kind))
  const level = hasDecision ? (missed >= 2 ? 'L4' : 'L2') : 'L1'
  return { level, reason: reasonOf(fresh), keys }
}
