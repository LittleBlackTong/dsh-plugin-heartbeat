/**
 * Rhythm: interval math, quiet hours, refractory, jitter.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeIntervalMs,
  inQuietHours,
  jitterFor,
  parseClock,
  quietRemainingMs,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
} from '../lib/rhythm.js'

test('parseClock validates HH:MM', () => {
  assert.equal(parseClock('23:00'), 1380)
  assert.equal(parseClock('00:00'), 0)
  assert.equal(parseClock('24:00'), undefined)
  assert.equal(parseClock('7:5'), undefined)
  assert.equal(parseClock(undefined), undefined)
})

test('overnight quiet hours detect both sides of midnight', () => {
  const window = { start: '23:00', end: '08:00' }
  assert.equal(inQuietHours(window, new Date('2026-10-30T01:00:00')), true)
  assert.equal(inQuietHours(window, new Date('2026-10-30T07:59:00')), true)
  assert.equal(inQuietHours(window, new Date('2026-10-30T08:00:00')), false)
  assert.equal(inQuietHours(window, new Date('2026-10-30T12:00:00')), false)
  assert.equal(inQuietHours(window, new Date('2026-10-30T23:30:00')), true)
  assert.equal(inQuietHours(null, new Date('2026-10-30T01:00:00')), false)
})

test('quietRemainingMs counts to the window end', () => {
  const window = { start: '23:00', end: '08:00' }
  const remaining = quietRemainingMs(window, new Date('2026-10-30T07:00:00'))
  assert.equal(remaining, 3600_000)
  assert.equal(quietRemainingMs(window, new Date('2026-10-30T12:00:00')), 0)
})

test('base interval is the rest interval', () => {
  const interval = computeIntervalMs({ config: { baseIntervalSeconds: 600 }, arousal: 0, missed: 0, now: 0 })
  assert.ok(interval >= 600_000)
  assert.ok(interval <= 660_000, 'jitter is bounded')
})

test('arousal shortens and missed beats lengthen the interval', () => {
  const config = { baseIntervalSeconds: 600 }
  const rest = computeIntervalMs({ config, arousal: 0, missed: 0, now: 0 })
  const excited = computeIntervalMs({ config, arousal: 4, missed: 0, now: 0 })
  const tired = computeIntervalMs({ config, arousal: 0, missed: 2, now: 0 })
  assert.ok(excited < rest / 2, 'high arousal at least halves the rest interval')
  assert.ok(tired > rest, 'unanswered beats back off')
})

test('explicit backoff tiers are respected', () => {
  const config = { baseIntervalSeconds: 600, backoffSeconds: [600, 1800] }
  const tierOne = computeIntervalMs({ config, missed: 1, arousal: 0, now: 0 })
  assert.ok(tierOne >= 1_800_000)
  const clamped = computeIntervalMs({ config: { baseIntervalSeconds: 60 }, arousal: 0, missed: 9, now: 0 })
  assert.ok(clamped >= MIN_INTERVAL_MS)
  assert.ok(clamped <= MAX_INTERVAL_MS)
})

test('refractory window defers the next beat', () => {
  const config = { baseIntervalSeconds: 60, refractorySeconds: 300 }
  const now = 1_000_000
  const interval = computeIntervalMs({ config, arousal: 0, missed: 0, now, lastDeliveredAt: now - 60_000 })
  assert.ok(now + interval >= now - 60_000 + 300_000 - 60_000, 'next beat waits out the refractory window')
})

test('jitter is deterministic per session and bounded', () => {
  const a = jitterFor('session-a', 1_000_000, 60_000)
  const b = jitterFor('session-a', 1_000_000, 60_000)
  assert.equal(a, b)
  assert.ok(a >= 0 && a < 60_000)
  assert.notEqual(jitterFor('session-a', 1_000_000, 60_000), jitterFor('session-b', 1_000_000, 60_000))
})
