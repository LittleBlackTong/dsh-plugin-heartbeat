/**
 * Speech-right arbitration — the shared proactive cooldown protocol (v0.7).
 *
 * Proactive plugins (heartbeat, memory, …) all want to speak in the same
 * conversation. To keep two of them from talking over each other, every
 * speaker claims a small file before injecting a proactive message:
 *
 * ```
 * ${DSH_HOME:-~/.dsh}/proactive-cooldown.json
 * { version: 1, speaker: 'heartbeat' | 'memory', at: <epoch ms> }
 * ```
 *
 * Protocol: read the file. If the recorded claim is younger than
 * `cooldownSeconds` and belongs to **another** speaker, this beat yields
 * (`{ ok: false, deferredBy }`) and tries again on a later pulse. Otherwise the
 * speaker writes its own claim atomically (tmp + rename) and proceeds.
 *
 * The module is deliberately tiny and **imports nothing** from the memory
 * plugin: the two sides implement the same protocol independently so each can
 * be installed, upgraded or removed alone. Read failures (missing/corrupt/
 * unreadable file) are treated as "no lock"; write failures degrade to
 * "proceed" — arbitration is politeness, never a hard dependency.
 *
 * @module dsh-plugin-heartbeat/proactive-lock
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Schema version written by this build. */
export const PROACTIVE_LOCK_VERSION = 1

/** Shared file name inside the dsh home. */
export const PROACTIVE_LOCK_FILENAME = 'proactive-cooldown.json'

/** Default cooldown between two different proactive speakers. */
export const DEFAULT_PROACTIVE_COOLDOWN_SECONDS = 180

/** Absolute path of the shared claim file (`${DSH_HOME:-~/.dsh}/proactive-cooldown.json`). */
export function defaultProactiveLockPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), PROACTIVE_LOCK_FILENAME)
}

/**
 * Read the current claim; any unreadable/invalid file counts as "no lock".
 * @param {string} path
 * @returns {{speaker: string, at: number} | undefined}
 */
function readClaim(path) {
  try {
    if (!existsSync(path)) return undefined
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    if (typeof raw.speaker !== 'string' || raw.speaker.length === 0) return undefined
    const at = Number(raw.at)
    if (!Number.isFinite(at) || at <= 0) return undefined
    return { speaker: raw.speaker, at }
  } catch {
    return undefined
  }
}

/** Atomically write a claim; returns whether it landed (best-effort). */
function writeClaim(path, speaker, at) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ version: PROACTIVE_LOCK_VERSION, speaker, at })}\n`)
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

/**
 * Read the current claim for display purposes (status route / diagnostics).
 * Strict validation: a corrupt or shapeless file reads as "no claim".
 *
 * @param {string} [path] lock-file path
 * @returns {{speaker: string, at: number} | undefined}
 */
export function readProactiveLock(path = defaultProactiveLockPath()) {
  const current = readClaim(path)
  if (current === undefined) return undefined
  if (typeof current.speaker !== 'string' || current.speaker.length === 0) return undefined
  if (!Number.isFinite(current.at) || current.at <= 0) return undefined
  return { speaker: current.speaker, at: current.at }
}

/**
 * Claim the proactive floor before injecting a message.
 *
 * @param {object} [options]
 * @param {string} [options.path] shared claim file (default `defaultProactiveLockPath()`)
 * @param {'heartbeat'|'memory'|string} [options.speaker] self identity
 * @param {number} [options.cooldownSeconds] arbitration window; `0` disables it
 * @param {number} [options.now] epoch ms (tests)
 * @returns {{ok: true} | {ok: false, deferredBy: string}}
 */
export function claimProactiveLock({
  path = defaultProactiveLockPath(),
  speaker = 'heartbeat',
  cooldownSeconds = DEFAULT_PROACTIVE_COOLDOWN_SECONDS,
  now = Date.now(),
} = {}) {
  const self = typeof speaker === 'string' && speaker.length > 0 ? speaker : 'heartbeat'
  const at = Number(now)
  const cooldown = Number(cooldownSeconds)
  // `0` (or garbage) turns arbitration off: never block the other speaker and
  // leave the file alone, so a disabled heartbeat cannot silence memory.
  if (!Number.isFinite(cooldown) || cooldown <= 0) return { ok: true }

  const stamp = Number.isFinite(at) ? at : Date.now()
  const current = readClaim(path)
  if (current !== undefined && current.speaker !== self && current.at > stamp - cooldown * 1000) {
    return { ok: false, deferredBy: current.speaker }
  }
  writeClaim(path, self, stamp)
  return { ok: true }
}
