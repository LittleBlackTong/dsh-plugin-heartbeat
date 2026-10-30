/**
 * Vitals (runtime state) tests: history, dedupe ledger, persistence,
 * budgets, restart cooldown, atomic/debounced writes.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VitalsStore, emptySessionState } from '../lib/vitals.js'

const tmpVitals = () => join(mkdtempSync(join(tmpdir(), 'hb-vitals-')), 'heartbeat-vitals.json')

test('session state starts empty and is created on demand', () => {
  const store = new VitalsStore({ path: tmpVitals(), debounceMs: 0 })
  const session = store.get('s')
  assert.deepEqual({ ...session }, { ...emptySessionState() })
  assert.equal(store.get('s'), session, 'same session returns the live state')
})

test('recordPulse keeps a bounded history and tracks delivery', () => {
  const store = new VitalsStore({ path: tmpVitals(), historyLimit: 3, debounceMs: 0 })
  for (let index = 0; index < 5; index += 1) {
    store.recordPulse('s', { level: 'L1', reason: `r${index}`, delivered: index % 2 === 0 })
  }
  const session = store.get('s')
  assert.deepEqual(session.history.map((row) => row.reason), ['r2', 'r3', 'r4'])
  assert.equal(session.history[2].delivered, true)
  assert.equal(session.lastDeliveredAt > 0, true)
  assert.equal(store.state.global.lastPulseAt > 0, true)
})

test('asked ledger bumps counters and evicts least recently asked', () => {
  let now = 1000
  const store = new VitalsStore({ path: tmpVitals(), askedLimit: 2, debounceMs: 0, now: () => now })
  store.markDelivered('s', ['a'])
  now = 2000
  store.markDelivered('s', ['b'])
  now = 3000
  store.markDelivered('s', ['a'])
  now = 4000
  store.markDelivered('s', ['c'])
  const asked = store.get('s').asked
  assert.deepEqual(Object.keys(asked).sort(), ['a', 'c'])
  assert.equal(asked.a.count, 2)
  assert.equal(asked.c.count, 1)
})

test('persists and reloads across instances', () => {
  const path = tmpVitals()
  const first = new VitalsStore({ path, debounceMs: 0 })
  first.recordPulse('s', { level: 'L2', reason: 'team:task-3:ready', delivered: true })
  first.markDelivered('s', ['team:task-3:ready'])
  first.flush()
  const second = new VitalsStore({ path, debounceMs: 0 })
  assert.equal(second.get('s').history.length, 1)
  assert.equal(second.get('s').history[0].level, 'L2')
  assert.equal(second.get('s').asked['team:task-3:ready'].count, 1)
})

test('restart cooldown suppresses delivery right after reload', () => {
  const path = tmpVitals()
  const base = 1_000_000
  const first = new VitalsStore({ path, debounceMs: 0, now: () => base })
  first.recordPulse('s', { level: 'L1', reason: 'x', delivered: true })
  first.flush()
  const second = new VitalsStore({ path, debounceMs: 0, now: () => base + 60_000, restartCooldownSeconds: 300 })
  assert.equal(second.restartCooldownActive('s', base + 60_000), true)
  assert.equal(second.restartCooldownActive('s', base + 301_000), false)
  // A session that never spoke has no cooldown.
  assert.equal(second.restartCooldownActive('other', base + 60_000), false)
})

test('budget counts within the day and rolls over at midnight', () => {
  const morning = new Date('2026-10-30T10:00:00')
  const store = new VitalsStore({ path: tmpVitals(), debounceMs: 0, now: () => morning.getTime() })
  assert.equal(store.budgetLeft({ maxBeatsPerDay: 2 }, morning.getTime()), 2)
  store.bumpBudget(morning.getTime())
  assert.equal(store.budgetLeft({ maxBeatsPerDay: 2 }, morning.getTime()), 1)
  store.bumpBudget(morning.getTime())
  assert.equal(store.budgetLeft({ maxBeatsPerDay: 2 }, morning.getTime()), 0)
  // Unlimited when the cap is 0.
  assert.equal(store.budgetLeft({ maxBeatsPerDay: 0 }, morning.getTime()), Infinity)
  const tomorrow = new Date('2026-10-31T09:00:00')
  assert.equal(store.budgetLeft({ maxBeatsPerDay: 2 }, tomorrow.getTime()), 2)
})

test('writes are debounced, atomic in shape, and flushed on demand', () => {
  const path = tmpVitals()
  const store = new VitalsStore({ path, debounceMs: 10_000 })
  store.recordPulse('s', { level: 'L0', reason: 'none', delivered: false })
  assert.equal(existsSync(path), false, 'debounce postpones the write')
  store.flush()
  assert.equal(existsSync(path), true)
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(typeof raw.sessions.s.lastPulseAt, 'number')
})

test('corrupt vitals file degrades to empty state', () => {
  const path = tmpVitals()
  const store = new VitalsStore({ path, debounceMs: 0 })
  store.flush()
  // Overwrite with garbage, then reload.
  writeFileSync(path, 'not json')
  const reloaded = new VitalsStore({ path, debounceMs: 0 })
  assert.deepEqual(reloaded.get('s'), emptySessionState())
})

// ── v0.7 physiology signature ──────────────────────────────────────────────

test('old vitals files load with the physiology fields defaulted to zero', () => {
  const path = tmpVitals()
  writeFileSync(path, JSON.stringify({
    version: 1,
    global: { lastPulseAt: 0, budget: { day: '', beats: 0 } },
    sessions: {
      old: {
        lastPulseAt: 123,
        lastDeliveredAt: 0,
        missedCount: 0,
        paused: false,
        pausedReason: null,
        snoozeUntil: 0,
        seen: {},
        asked: {},
        history: [],
      },
    },
  }))
  const store = new VitalsStore({ path, debounceMs: 0 })
  const session = store.get('old')
  assert.equal(session.lastPulseAt, 123, 'existing fields survive')
  assert.equal(session.lastUserMessageAt, 0)
  assert.equal(session.lastTurnEndAt, 0)
  assert.equal(session.busyMsToday, 0)
  assert.equal(session.busyDay, '')
})

test('user messages, turn ends and busy time are recorded and persisted', () => {
  const path = tmpVitals()
  const start = new Date('2026-10-30T10:00:00').getTime()
  let now = start
  const store = new VitalsStore({ path, debounceMs: 0, now: () => now })
  store.setLastUserMessageAt('s')
  assert.equal(store.get('s').lastUserMessageAt, start)
  now = start + 5 * 60_000
  store.noteBusy('s', 5 * 60_000)
  store.noteTurnEnd('s')
  const session = store.get('s')
  assert.equal(session.busyMsToday, 300_000)
  assert.equal(session.busyDay, '2026-10-30')
  assert.equal(session.lastTurnEndAt, now)
  store.flush()
  const reloaded = new VitalsStore({ path, debounceMs: 0, now: () => now })
  assert.equal(reloaded.get('s').lastUserMessageAt, start)
  assert.equal(reloaded.get('s').lastTurnEndAt, now)
  assert.equal(reloaded.get('s').busyMsToday, 300_000)
  assert.equal(reloaded.get('s').busyDay, '2026-10-30')
})

test('busy time rolls over at midnight and deliveredToday derives from the budget', () => {
  const path = tmpVitals()
  let now = new Date('2026-10-30T23:00:00').getTime()
  const store = new VitalsStore({ path, debounceMs: 0, now: () => now })
  store.noteBusy('s', 60_000)
  now = new Date('2026-10-31T00:01:00').getTime()
  store.noteBusy('s', 30_000)
  assert.equal(store.get('s').busyMsToday, 30_000, 'a new day restarts the counter')
  assert.equal(store.get('s').busyDay, '2026-10-31')
  store.bumpBudget(now)
  store.bumpBudget(now)
  assert.equal(store.deliveredToday(now), 2)
  assert.equal(store.deliveredToday(new Date('2026-11-01T00:00:00').getTime()), 0, 'stale budget day reads as zero')
})
