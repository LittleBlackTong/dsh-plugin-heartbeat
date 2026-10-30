/**
 * Config v2 + migration tests.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONFIG_VERSION,
  migrateConfigV1toV2,
  resolveEffectiveConfig,
  SettingsSchema,
} from '../lib/schema.js'
import { HeartbeatConfigStore } from '../lib/store.js'

const tmpConfig = () => join(mkdtempSync(join(tmpdir(), 'hb-v2-')), 'heartbeat.json')

test('v2 schema defaults cover autonomy, rhythm, budgets and quiet hours', () => {
  const resolved = SettingsSchema({})
  assert.equal(resolved.version, CONFIG_VERSION)
  assert.equal(resolved.mode, 'assist')
  assert.equal(resolved.baseIntervalSeconds, 600)
  assert.equal(resolved.maxBeatsPerDay, 12)
  assert.equal(resolved.dedupeWindowMinutes, 90)
  assert.equal(resolved.refractorySeconds, 300)
  assert.equal(resolved.restartCooldownSeconds, 300)
  assert.deepEqual(resolved.quietHours, { start: '23:00', end: '08:00' })
  assert.deepEqual(resolved.l3Allow, [])
  assert.deepEqual(resolved.workspaces, {})
})

test('schema rejects unknown l3 categories and out-of-range rhythm values', () => {
  assert.throws(() => SettingsSchema({ l3Allow: ['deploy'] }))
  assert.throws(() => SettingsSchema({ baseIntervalSeconds: 5 }))
  assert.throws(() => SettingsSchema({ dedupeWindowMinutes: 9999 }))
  assert.throws(() => SettingsSchema({ mode: 'autopilot' }))
})

test('migrateConfigV1toV2 maps intervalSeconds and keeps v1 user values', () => {
  const config = migrateConfigV1toV2({
    enabled: false,
    intervalSeconds: 180,
    pauseAfterMissed: 5,
    taskNudge: false,
    taskNudgeMaxItems: 3,
  })
  assert.equal(config.version, 2)
  assert.equal(config.enabled, false)
  assert.equal(config.baseIntervalSeconds, 180)
  assert.equal(config.pauseAfterMissed, 5)
  assert.equal(config.taskNudge, false)
  assert.equal(config.taskNudgeMaxItems, 3)
  assert.equal(config.mode, 'assist')
})

test('migrateConfigV1toV2 tolerates garbage', () => {
  for (const value of [null, undefined, 'nope', 42, []]) {
    const config = migrateConfigV1toV2(value)
    assert.equal(config.version, 2)
    assert.equal(config.enabled, true)
  }
})

test('store migrates a v1 file on load and writes v2 back', () => {
  const file = tmpConfig()
  writeFileSync(file, JSON.stringify({ enabled: true, intervalSeconds: 300, pauseAfterMissed: 2 }))
  const store = new HeartbeatConfigStore({ path: file })
  assert.equal(store.get().version, 2)
  assert.equal(store.get().baseIntervalSeconds, 300)
  assert.equal(store.get().pauseAfterMissed, 2)
  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(persisted.version, 2)
  assert.equal(persisted.baseIntervalSeconds, 300)
  assert.equal(persisted.intervalSeconds, undefined)
})

test('store update accepts v2 keys and the v1 interval alias', () => {
  const file = tmpConfig()
  const store = new HeartbeatConfigStore({ path: file })
  store.update({ baseIntervalSeconds: 120, maxBeatsPerDay: 4 })
  assert.equal(store.get().baseIntervalSeconds, 120)
  assert.equal(store.get().maxBeatsPerDay, 4)
  store.update({ intervalSeconds: 900 })
  assert.equal(store.get().baseIntervalSeconds, 900)
  assert.throws(() => store.update({ mode: 'autopilot' }))
  assert.throws(() => store.update({ l3Allow: ['deploy'] }))
})

test('store applies composition base then user file then patch', () => {
  const file = tmpConfig()
  writeFileSync(file, JSON.stringify({ dedupeWindowMinutes: 30 }))
  const store = new HeartbeatConfigStore({
    path: file,
    base: { baseIntervalSeconds: 900, mode: 'silent' },
  })
  assert.equal(store.get().baseIntervalSeconds, 900)
  assert.equal(store.get().mode, 'silent')
  assert.equal(store.get().dedupeWindowMinutes, 30)
  store.update({ mode: 'assist' })
  assert.equal(store.get().mode, 'assist')
  const reloaded = new HeartbeatConfigStore({ path: file, base: { baseIntervalSeconds: 300 } })
  assert.equal(reloaded.get().baseIntervalSeconds, 900)
})

test('workspace override wins over global for the matching cwd', () => {
  const global = migrateConfigV1toV2({
    baseIntervalSeconds: 600,
    workspaces: { '/w': { baseIntervalSeconds: 120, maxBeatsPerDay: 3 } },
  })
  const effective = resolveEffectiveConfig(global, '/w')
  assert.equal(effective.baseIntervalSeconds, 120)
  assert.equal(effective.maxBeatsPerDay, 3)
  // Global values survive for keys the override does not mention.
  assert.equal(effective.dedupeWindowMinutes, 90)
  // Unknown cwd / no cwd returns the global config untouched.
  assert.equal(resolveEffectiveConfig(global, '/other'), global)
  assert.equal(resolveEffectiveConfig(global, undefined), global)
})

test('corrupt config file falls back silently', () => {
  const file = tmpConfig()
  writeFileSync(file, '{not json')
  const store = new HeartbeatConfigStore({ path: file, base: { baseIntervalSeconds: 420 } })
  assert.equal(store.get().baseIntervalSeconds, 420)
})

// ── v0.7 keys: speech-right arbitration + physiology/social rhythm ─────────

test('v0.7 keys have defaults, persist and validate', () => {
  const resolved = SettingsSchema({})
  assert.equal(resolved.proactiveCooldownSeconds, 180)
  assert.equal(resolved.userActiveSuppressSeconds, 120)
  assert.equal(resolved.physiologyLine, true)

  const file = tmpConfig()
  const store = new HeartbeatConfigStore({ path: file })
  store.update({ proactiveCooldownSeconds: 0, userActiveSuppressSeconds: 45, physiologyLine: false })
  assert.equal(store.get().proactiveCooldownSeconds, 0)
  assert.equal(store.get().userActiveSuppressSeconds, 45)
  assert.equal(store.get().physiologyLine, false)
  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(persisted.proactiveCooldownSeconds, 0)
  assert.equal(persisted.userActiveSuppressSeconds, 45)
  assert.equal(persisted.physiologyLine, false)
  assert.throws(() => store.update({ proactiveCooldownSeconds: -1 }))
  assert.throws(() => store.update({ userActiveSuppressSeconds: 86401 }))
  assert.throws(() => store.update({ physiologyLine: 'yes' }))
})

test('migration carries and defaults the v0.7 keys', () => {
  const kept = migrateConfigV1toV2({ proactiveCooldownSeconds: 60, userActiveSuppressSeconds: 0, physiologyLine: false })
  assert.equal(kept.proactiveCooldownSeconds, 60)
  assert.equal(kept.userActiveSuppressSeconds, 0)
  assert.equal(kept.physiologyLine, false)
  const old = migrateConfigV1toV2({ intervalSeconds: 300 })
  assert.equal(old.proactiveCooldownSeconds, 180)
  assert.equal(old.userActiveSuppressSeconds, 120)
  assert.equal(old.physiologyLine, true)
})
