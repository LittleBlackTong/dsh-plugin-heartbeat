/**
 * Heartbeat configuration store: one JSON file as the single user-facing
 * config source, layered over the composition defaults.
 *
 * Why not the `settings` service? The Web settings wire only serves a
 * hard-coded allowlist (`WEB_SETTINGS_NAMESPACES` in dsh-host-apiproxy) and
 * rejects every other namespace with `settings-not-exposed`; a plugin cannot
 * add itself to that list yet. This store keeps the same "base + user layer"
 * semantics with a private JSON file and an in-process watch, and the plugin
 * serves it over its own HTTP route for the browser UI.
 *
 * @module dsh-plugin-heartbeat/store
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { SettingsSchema } from './schema.js'

export const HEARTBEAT_CONFIG_FILENAME = 'heartbeat.json'

export function defaultConfigPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), HEARTBEAT_CONFIG_FILENAME)
}

/**
 * @typedef {object} HeartbeatConfig
 * @property {boolean} enabled
 * @property {number} intervalSeconds
 * @property {number} pauseAfterMissed
 * @property {boolean} taskNudge
 * @property {number} taskNudgeMaxItems
 */

/**
 * @param {object} options
 * @param {string} [options.path] absolute config-file path (defaults to `<dshHome>/heartbeat.json`)
 * @param {object} [options.base] composition defaults ({enabled, intervalSeconds, pauseAfterMissed, taskNudge, taskNudgeMaxItems})
 */
export class HeartbeatConfigStore {
  constructor(options = {}) {
    this.path = options.path ?? defaultConfigPath()
    this.base = {
      enabled: options.base?.enabled !== false,
      intervalSeconds: Number(options.base?.intervalSeconds ?? 600),
      pauseAfterMissed: Number(options.base?.pauseAfterMissed ?? 3),
      taskNudge: options.base?.taskNudge !== false,
      taskNudgeMaxItems: Number(options.base?.taskNudgeMaxItems ?? 5),
    }
    this.config = { ...this.base }
    this.watchers = new Set()
    this.load()
  }

  /** Read the user file if present; invalid files are ignored, not fatal. */
  load() {
    let raw
    try {
      if (!existsSync(this.path)) return
      raw = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      return // corrupt file: keep last good config
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
    try {
      const resolved = SettingsSchema({ ...this.base, ...pickFields(raw) })
      this.config = normalize(resolved)
    } catch {
      // schema validation failed: keep last good config
    }
  }

  /** Current effective config (stable reference until the next update). */
  get() {
    return this.config
  }

  /**
   * Apply a partial update, persist it, and notify watchers.
   * @param {{ enabled?: boolean, intervalSeconds?: number, pauseAfterMissed?: number, taskNudge?: boolean, taskNudgeMaxItems?: number }} patch
   * @returns {HeartbeatConfig} the new effective config
   * @throws {Error} on invalid fields or values
   */
  update(patch) {
    if (typeof patch !== 'object' || patch === null) throw new Error('config patch must be an object')
    const next = SettingsSchema({
      ...this.base,
      ...this.config,
      ...pickFields(patch),
    })
    this.config = normalize(next)
    this.persist()
    for (const watcher of this.watchers) {
      try {
        watcher(this.config)
      } catch {
        // best-effort notification
      }
    }
    return this.config
  }

  /** Subscribe to config changes; returns the disposer. */
  watch(callback) {
    this.watchers.add(callback)
    return () => this.watchers.delete(callback)
  }

  persist() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.config, null, 2)}\n`)
      renameSync(tmp, this.path)
    } catch (error) {
      // Persistence is best-effort; the in-memory config is already applied.
      // Surface the failure so the route can report it.
      throw new Error(`config persisted in memory but not to disk: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function pickFields(input) {
  const picked = {}
  for (const key of ['enabled', 'intervalSeconds', 'pauseAfterMissed', 'taskNudge', 'taskNudgeMaxItems']) {
    if (input[key] !== undefined) picked[key] = input[key]
  }
  return picked
}

/** Reduce a validated schema value to the stored field set. */
function normalize(resolved) {
  return {
    enabled: resolved.enabled,
    intervalSeconds: resolved.intervalSeconds,
    pauseAfterMissed: resolved.pauseAfterMissed,
    taskNudge: resolved.taskNudge !== false,
    taskNudgeMaxItems: Number(resolved.taskNudgeMaxItems ?? 5),
  }
}
