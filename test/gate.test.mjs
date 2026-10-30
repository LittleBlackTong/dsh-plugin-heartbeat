/**
 * Gate: level selection, dedupe, budgets, quiet/snooze/pressure/user-active.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { decide, DECISION_KINDS } from '../lib/gate.js'

const NOW = new Date('2026-10-30T14:00:00').getTime()
const baseConfig = {
  enabled: true,
  mode: 'assist',
  quietHours: null,
  dedupeWindowMinutes: 90,
  maxBeatsPerDay: 12,
}

const fakeVitals = ({ session = {}, budget = Infinity } = {}) => ({
  get: () => ({ paused: false, pausedReason: null, snoozeUntil: 0, asked: {}, ...session }),
  budgetLeft: () => budget,
})

const ready = { kind: 'team-ready', key: 'team:task-3:ready', weight: 5, text: '团队任务 task-3 可开始了：发布' }
const progress = { kind: 'todos', key: 'todos:abc', weight: 2, text: '会话待办有变化（2 项未完成）' }

test('decision signals ask (L2), progress only reports (L1)', () => {
  assert.ok(DECISION_KINDS.has('team-ready'))
  const decision = decide({ config: baseConfig, vitals: fakeVitals(), sessionId: 's', signals: [ready], now: NOW })
  assert.equal(decision.level, 'L2')
  assert.deepEqual(decision.keys, ['team:task-3:ready'])
  assert.match(decision.reason, /可开始/)
  const report = decide({ config: baseConfig, vitals: fakeVitals(), sessionId: 's', signals: [progress], now: NOW })
  assert.equal(report.level, 'L1')
})

test('no signals stays silent', () => {
  const result = decide({ config: baseConfig, vitals: fakeVitals(), sessionId: 's', signals: [], now: NOW })
  assert.equal(result.level, 'L0')
  assert.equal(result.suppressedBy, 'no-signal')
})

test('silent mode never opens a turn', () => {
  const result = decide({ config: { ...baseConfig, mode: 'silent' }, vitals: fakeVitals(), sessionId: 's', signals: [ready], now: NOW })
  assert.equal(result.level, 'L0')
  assert.equal(result.suppressedBy, 'mode-silent')
})

test('dedupe window drops recently asked keys', () => {
  const vitals = fakeVitals({ session: { asked: { 'team:task-3:ready': { lastAt: NOW - 10 * 60_000, count: 1 } } } })
  const result = decide({ config: baseConfig, vitals, sessionId: 's', signals: [ready], now: NOW })
  assert.equal(result.level, 'L0')
  assert.equal(result.suppressedBy, 'dedupe')
  // Outside the window it is eligible again.
  const later = decide({ config: baseConfig, vitals, sessionId: 's', signals: [ready], now: NOW + 91 * 60_000 })
  assert.equal(later.level, 'L2')
})

test('daily budget exhaustion stays silent', () => {
  const result = decide({ config: baseConfig, vitals: fakeVitals({ budget: 0 }), sessionId: 's', signals: [ready], now: NOW })
  assert.equal(result.level, 'L0')
  assert.equal(result.suppressedBy, 'budget')
})

test('snooze, pause and disabled all short-circuit', () => {
  assert.equal(decide({ config: baseConfig, vitals: fakeVitals({ session: { snoozeUntil: NOW + 60_000 } }), sessionId: 's', signals: [ready], now: NOW }).suppressedBy, 'snoozed')
  assert.equal(decide({ config: baseConfig, vitals: fakeVitals({ session: { paused: true, pausedReason: 'manual' } }), sessionId: 's', signals: [ready], now: NOW }).suppressedBy, 'paused')
  assert.equal(decide({ config: { ...baseConfig, enabled: false }, vitals: fakeVitals(), sessionId: 's', signals: [ready], now: NOW }).suppressedBy, 'disabled')
})

test('quiet hours, context pressure and recent user activity suppress', () => {
  const quiet = decide({ config: { ...baseConfig, quietHours: { start: '23:00', end: '08:00' } }, vitals: fakeVitals(), sessionId: 's', signals: [ready], now: new Date('2026-10-30T01:00:00').getTime() })
  assert.equal(quiet.suppressedBy, 'quiet')
  const pressure = decide({ config: baseConfig, vitals: fakeVitals(), sessionId: 's', signals: [ready], pressure: 0.95, now: NOW })
  assert.equal(pressure.suppressedBy, 'context-pressure')
  const active = decide({ config: baseConfig, vitals: fakeVitals(), sessionId: 's', signals: [ready], lastUserActivityAt: NOW - 30_000, now: NOW })
  assert.equal(active.suppressedBy, 'user-active')
})

test('repeated decision signal escalates to L4', () => {
  const result = decide({ config: baseConfig, vitals: fakeVitals(), sessionId: 's', signals: [ready], missed: 2, now: NOW })
  assert.equal(result.level, 'L4')
})

test('manual beat bypasses politeness gates if the user asks for it', () => {
  const result = decide({
    config: { ...baseConfig, enabled: false },
    vitals: fakeVitals({ session: { paused: true } }),
    sessionId: 's',
    signals: [ready],
    now: NOW,
    manual: true,
  })
  assert.equal(result.level, 'L2')
  const empty = decide({ config: baseConfig, vitals: fakeVitals(), sessionId: 's', signals: [], now: NOW, manual: true })
  assert.equal(empty.level, 'L1')
})

test('user-activity suppression window is configurable (v0.7)', () => {
  const lastUserActivityAt = NOW - 60_000
  const defaults = decide({ config: baseConfig, vitals: fakeVitals(), sessionId: 's', signals: [ready], lastUserActivityAt, now: NOW })
  assert.equal(defaults.suppressedBy, 'user-active', 'default 120s keeps the old behaviour')
  const shorter = decide({
    config: { ...baseConfig, userActiveSuppressSeconds: 30 },
    vitals: fakeVitals(),
    sessionId: 's',
    signals: [ready],
    lastUserActivityAt,
    now: NOW,
  })
  assert.equal(shorter.level, 'L2', '60s of silence is already polite with a 30s window')
  const longer = decide({
    config: { ...baseConfig, userActiveSuppressSeconds: 300 },
    vitals: fakeVitals(),
    sessionId: 's',
    signals: [ready],
    lastUserActivityAt,
    now: NOW,
  })
  assert.equal(longer.suppressedBy, 'user-active')
  const off = decide({
    config: { ...baseConfig, userActiveSuppressSeconds: 0 },
    vitals: fakeVitals(),
    sessionId: 's',
    signals: [ready],
    lastUserActivityAt,
    now: NOW,
  })
  assert.equal(off.level, 'L2', '0 disables the suppression entirely')
})

test('persisted lastUserMessageAt keeps the suppress window across a restart', () => {
  const vitals = fakeVitals({ session: { lastUserMessageAt: NOW - 30_000 } })
  const suppressed = decide({ config: baseConfig, vitals, sessionId: 's', signals: [ready], now: NOW })
  assert.equal(suppressed.suppressedBy, 'user-active')
  const off = decide({ config: { ...baseConfig, userActiveSuppressSeconds: 0 }, vitals, sessionId: 's', signals: [ready], now: NOW })
  assert.equal(off.level, 'L2')
})
