/**
 * Physiology line — a one-line sense of the user's rhythm (v0.7).
 *
 * The heartbeat is not a cron job: it has a body. This module renders one short
 * expressive line (≤60 chars) that the L1/L2/L4 prompts may carry, e.g.
 *
 * ```
 * 〔状态：距你上次说话 2h · 今天第 3 次找你〕
 * ```
 *
 * Rules (deliberately conservative — saying nothing is the default):
 * - no data at all → no line;
 * - the user spoke (or a turn ended) less than 20 minutes ago → no line: the
 *   heartbeat would be interrupting, not observing;
 * - `lastUserMessageAt` is the primary anchor, `lastTurnEndAt` a fallback for
 *   sessions that predate v0.7 bookkeeping;
 * - the time of day changes the wording: morning gives a greeting, evening
 *   notes the hour, and **night is quieter and shorter** (no beat counter, no
 *   cutesy particles) because late-night pings should feel lighter.
 *
 * @module dsh-plugin-heartbeat/physiology
 */

/** Hard budget for the rendered line. */
export const MAX_PHYSIOLOGY_LENGTH = 60

/** Beats are hidden while the user was around this recently. */
export const PHYSIOLOGY_FRESH_MS = 20 * 60 * 1000

/**
 * Map a local clock into `morning | afternoon | evening | night`.
 * @param {Date} [date]
 * @returns {'morning'|'afternoon'|'evening'|'night'}
 */
export function daypartOf(date = new Date()) {
  const hour = date.getHours()
  if (hour >= 5 && hour < 11) return 'morning'
  if (hour >= 11 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 23) return 'evening'
  return 'night'
}

/** Compact "how long ago" text: `45min`, `2h`, `3天`. */
function formatAge(ms) {
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}min`
  if (ms < 86_400_000) return `${Math.max(1, Math.round(ms / 3_600_000))}h`
  return `${Math.floor(ms / 86_400_000)}天`
}

/**
 * Render the physiology line.
 *
 * @param {object} [options]
 * @param {number} [options.now] epoch ms
 * @param {number} [options.lastUserMessageAt] epoch ms of the last real user message
 * @param {number} [options.lastDeliveredAt] epoch ms of the last delivered beat (accepted for protocol symmetry)
 * @param {number} [options.lastTurnEndAt] epoch ms of the last finished turn (fallback anchor)
 * @param {number} [options.deliveredToday] beats delivered earlier today (this beat is +1)
 * @param {'morning'|'afternoon'|'evening'|'night'} [options.daypart] override (default: from `now`)
 * @returns {string} `''` when there is nothing kind to say
 */
export function renderPhysiology({
  now = Date.now(),
  lastUserMessageAt = 0,
  lastDeliveredAt = 0,
  lastTurnEndAt = 0,
  deliveredToday,
  daypart,
} = {}) {
  const at = Number(now)
  if (!Number.isFinite(at)) return ''
  const userAt = Number(lastUserMessageAt) > 0 ? Number(lastUserMessageAt) : 0
  const turnAt = Number(lastTurnEndAt) > 0 ? Number(lastTurnEndAt) : 0
  const anchor = userAt > 0 ? userAt : turnAt
  if (anchor <= 0 || anchor > at) return ''
  const age = at - anchor
  if (age < PHYSIOLOGY_FRESH_MS) return ''

  const distance = userAt > 0
    ? `距你上次说话 ${formatAge(age)}`
    : `距你上次收工 ${formatAge(age)}`
  const part = daypart ?? daypartOf(new Date(at))

  // Night: shorter, softer, no beat counter. Late-night company should not
  // feel like a notification dashboard.
  if (part === 'night') {
    const quiet = `〔夜深了，${distance}〕`
    return quiet.length <= MAX_PHYSIOLOGY_LENGTH ? quiet : `${quiet.slice(0, MAX_PHYSIOLOGY_LENGTH - 1)}…`
  }

  const hasCount = deliveredToday !== undefined && deliveredToday !== null
    && Number.isFinite(Number(deliveredToday)) && Number(deliveredToday) >= 0
  const count = hasCount ? `今天第 ${Number(deliveredToday) + 1} 次找你` : ''
  const prefix = part === 'morning' ? '早上好：' : part === 'evening' ? '傍晚了：' : '状态：'
  let line = `〔${prefix}${distance}${count.length > 0 ? ` · ${count}` : ''}〕`
  if (line.length > MAX_PHYSIOLOGY_LENGTH) {
    // Defensive: an absurdly long distance still fits the budget.
    line = `〔${prefix}${distance}〕`
  }
  if (line.length > MAX_PHYSIOLOGY_LENGTH) line = `${line.slice(0, MAX_PHYSIOLOGY_LENGTH - 1)}…`
  return line
}
