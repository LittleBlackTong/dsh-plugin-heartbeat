/**
 * Proactive speech-right arbitration (v0.7): the shared
 * `${DSH_HOME}/proactive-cooldown.json` protocol heartbeat implements locally
 * (zero imports) and must agree with dsh-plugin-memory.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claimProactiveLock,
  defaultProactiveLockPath,
  readProactiveLock,
  DEFAULT_PROACTIVE_COOLDOWN_SECONDS,
  PROACTIVE_LOCK_FILENAME,
  PROACTIVE_LOCK_VERSION,
} from '../lib/proactive-lock.js'

const NOW = 1_000_000_000

const tmpLock = () => join(mkdtempSync(join(tmpdir(), 'hb-lock-')), PROACTIVE_LOCK_FILENAME)

const writeLock = (path, value) => writeFileSync(path, JSON.stringify(value))

const readLock = (path) => JSON.parse(readFileSync(path, 'utf8'))

test('claiming an empty slot writes the shared schema and wins', () => {
  const path = tmpLock()
  const result = claimProactiveLock({ path, speaker: 'heartbeat', cooldownSeconds: 180, now: NOW })
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(readLock(path), { version: PROACTIVE_LOCK_VERSION, speaker: 'heartbeat', at: NOW })
})

test('a recent memory claim makes heartbeat yield without overwriting it', () => {
  const path = tmpLock()
  writeLock(path, { version: 1, speaker: 'memory', at: NOW - 60_000 })
  const result = claimProactiveLock({ path, speaker: 'heartbeat', cooldownSeconds: 180, now: NOW })
  assert.equal(result.ok, false)
  assert.equal(result.deferredBy, 'memory')
  assert.equal(readLock(path).speaker, 'memory', 'the yielding speaker leaves the claim untouched')
  assert.equal(readLock(path).at, NOW - 60_000)
})

test('an expired foreign claim can be taken over', () => {
  const path = tmpLock()
  // Exactly at the cooldown boundary the lock is stale (strict `>` comparison).
  writeLock(path, { version: 1, speaker: 'memory', at: NOW - 180_000 })
  const result = claimProactiveLock({ path, speaker: 'heartbeat', cooldownSeconds: 180, now: NOW })
  assert.deepEqual(result, { ok: true })
  assert.equal(readLock(path).speaker, 'heartbeat')
  assert.equal(readLock(path).at, NOW)
})

test('heartbeat refreshes its own recent claim instead of deferring to itself', () => {
  const path = tmpLock()
  writeLock(path, { version: 1, speaker: 'heartbeat', at: NOW - 1_000 })
  const result = claimProactiveLock({ path, speaker: 'heartbeat', cooldownSeconds: 180, now: NOW })
  assert.deepEqual(result, { ok: true })
  assert.equal(readLock(path).at, NOW)
})

test('missing or corrupt lock files degrade to "no lock"', () => {
  const missing = tmpLock()
  assert.equal(claimProactiveLock({ path: missing, speaker: 'heartbeat', now: NOW }).ok, true)

  const corrupt = tmpLock()
  writeFileSync(corrupt, 'not json at all')
  assert.equal(claimProactiveLock({ path: corrupt, speaker: 'heartbeat', now: NOW }).ok, true)
  assert.equal(readLock(corrupt).speaker, 'heartbeat')

  const shapeless = tmpLock()
  writeLock(shapeless, { speaker: 'memory' })
  assert.equal(claimProactiveLock({ path: shapeless, speaker: 'heartbeat', cooldownSeconds: 180, now: NOW }).ok, true)

  // An unreadable/unwritable target (a directory) must not throw either.
  const directory = mkdtempSync(join(tmpdir(), 'hb-lock-dir-'))
  assert.doesNotThrow(() => claimProactiveLock({ path: directory, speaker: 'heartbeat', now: NOW }))
  assert.equal(claimProactiveLock({ path: directory, speaker: 'heartbeat', now: NOW }).ok, true)
})

test('cooldownSeconds: 0 disables arbitration (claim ok, file untouched)', () => {
  const path = tmpLock()
  writeLock(path, { version: 1, speaker: 'memory', at: NOW })
  const result = claimProactiveLock({ path, speaker: 'heartbeat', cooldownSeconds: 0, now: NOW })
  assert.deepEqual(result, { ok: true })
  assert.equal(readLock(path).speaker, 'memory', 'a disabled heartbeat never blocks the other speaker')
})

test('readProactiveLock exposes a valid claim (round-trip with claimProactiveLock)', () => {
  const path = tmpLock()
  claimProactiveLock({ path, speaker: 'memory', cooldownSeconds: 180, now: NOW })
  assert.deepEqual(readProactiveLock(path), { speaker: 'memory', at: NOW })
})

test('readProactiveLock degrades every unreadable/invalid file to no lock', () => {
  const missing = tmpLock()
  assert.equal(readProactiveLock(missing), undefined)

  const corrupt = tmpLock()
  writeFileSync(corrupt, 'not json at all')
  assert.equal(readProactiveLock(corrupt), undefined)

  const shapeless = tmpLock()
  writeLock(shapeless, { speaker: 'memory' })
  assert.equal(readProactiveLock(shapeless), undefined)

  const zeroAt = tmpLock()
  writeLock(zeroAt, { speaker: 'memory', at: 0 })
  assert.equal(readProactiveLock(zeroAt), undefined)

  const emptySpeaker = tmpLock()
  writeLock(emptySpeaker, { speaker: '', at: NOW })
  assert.equal(readProactiveLock(emptySpeaker), undefined)

  const array = tmpLock()
  writeLock(array, [])
  assert.equal(readProactiveLock(array), undefined)

  // An unreadable target (a directory) must not throw either.
  const directory = mkdtempSync(join(tmpdir(), 'hb-lock-read-dir-'))
  assert.doesNotThrow(() => readProactiveLock(directory))
  assert.equal(readProactiveLock(directory), undefined)
})

test('the default lock lives next to the other dsh state files', () => {
  assert.equal(PROACTIVE_LOCK_FILENAME, 'proactive-cooldown.json')
  assert.ok(defaultProactiveLockPath().endsWith(PROACTIVE_LOCK_FILENAME))
  assert.equal(DEFAULT_PROACTIVE_COOLDOWN_SECONDS, 180)
  assert.equal(PROACTIVE_LOCK_VERSION, 1)
})
