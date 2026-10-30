/**
 * Rhythm — how often the heartbeat beats.
 *
 * Human hearts speed up with arousal and rest when idle; this module does the
 * same for interval length:
 *
 * ```
 * interval = clamp(base × (1 + missed) × mood, 30_000, 86_400_000)
 * mood     = 1 / (1 + clamp(arousal, 0, 4) / 2)     // arousal 4 → one third
 * ```
 *
 * On top of that:
 * - quiet hours suspend all beats (the gate also refuses, this is belt+braces);
 * - a refractory window after the last delivery defers the next beat;
 * - small deterministic jitter avoids several sessions firing on the same tick.
 *
 * @module dsh-plugin-heartbeat/rhythm
 */

export const MIN_INTERVAL_MS = 30_000
export const MAX_INTERVAL_MS = 86_400_000

/** Parse `HH:MM` into minutes of day; invalid input → undefined. */
export function parseClock(text) {
  if (typeof text !== 'string') return undefined
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

/**
 * Whether `date` falls inside the configured quiet window.
 * Supports overnight windows (`23:00–08:00`) and `null` (disabled).
 * @param {{start?: string, end?: string} | null} quietHours
 * @param {Date} date
 * @returns {boolean}
 */
export function inQuietHours(quietHours, date) {
  if (quietHours === null || quietHours === undefined) return false
  const start = parseClock(quietHours.start)
  const end = parseClock(quietHours.end)
  if (start === undefined || end === undefined || start === end) return false
  const now = date.getHours() * 60 + date.getMinutes()
  if (start < end) return now >= start && now < end
  return now >= start || now < end
}

/** Small deterministic jitter (0..jitterMs) so sessions do not fire in lockstep. */
export function jitterFor(sessionId, nowMs, jitterMs = 60_000) {
  if (jitterMs <= 0) return 0
  const seed = `${sessionId ?? ''}:${Math.trunc(nowMs / 60_000)}`
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = (Math.imul(hash, 31) + seed.charCodeAt(index)) >>> 0
  }
  return hash % jitterMs
}

/**
 * Compute the next interval in milliseconds.
 *
 * @param {object} options
 * @param {object} options.config effective config (`baseIntervalSeconds`, `refractorySeconds`)
 * @param {number} options.missed unanswered beats
 * @param {number} options.arousal 0..8 signal arousal
 * @param {number} options.now epoch ms
 * @param {number} [options.lastDeliveredAt] epoch ms of the last delivery
 * @param {string} [options.sessionId] seed for jitter
 * @returns {number} interval ms
 */
export function computeIntervalMs({ config, missed = 0, arousal = 0, now = 0, lastDeliveredAt = 0, sessionId = '' } = {}) {
  const baseSeconds = Math.max(30, Number(config?.baseIntervalSeconds ?? 600))
  const tiers = Array.isArray(config?.backoffSeconds) && config.backoffSeconds.length > 0
    ? config.backoffSeconds
    : Array.from(
      { length: Math.max(1, Math.trunc(Number(config?.pauseAfterMissed ?? 3))) },
      (_unused, index) => baseSeconds * (index + 1),
    )
  const tierIndex = Math.min(Math.max(0, Math.trunc(missed)), tiers.length - 1)
  const tierSeconds = Math.max(30, Number(tiers[tierIndex] ?? baseSeconds))
  const mood = 1 / (1 + Math.min(4, Math.max(0, Number(arousal) || 0)) / 2)
  let intervalMs = tierSeconds * 1000 * mood
  intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, intervalMs))
  // Refractory: never schedule inside the silence window after a delivery.
  const refractoryMs = Math.max(0, Number(config?.refractorySeconds ?? 0)) * 1000
  if (refractoryMs > 0 && lastDeliveredAt > 0) {
    const readyAt = lastDeliveredAt + refractoryMs
    intervalMs = Math.max(intervalMs, readyAt - now)
  }
  const jitterMs = Math.round(Math.max(0, Number(config?.jitterSeconds ?? 60)) * 1000)
  return Math.round(intervalMs + jitterFor(sessionId, now, jitterMs))
}

/** Milliseconds until the quiet window ends (0 when not quiet). */
export function quietRemainingMs(quietHours, date) {
  if (!inQuietHours(quietHours, date)) return 0
  const end = parseClock(quietHours.end)
  if (end === undefined) return 0
  const nowMs = date.getHours() * 3600_000 + date.getMinutes() * 60_000 + date.getSeconds() * 1000
  let remaining = end * 60_000 - nowMs
  if (remaining <= 0) remaining += 24 * 3600_000
  return remaining
}
