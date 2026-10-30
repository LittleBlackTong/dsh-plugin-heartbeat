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
 * ## v2 (v0.6.0)
 *
 * - The file carries `version: 2` and the full autonomy config (see
 *   `lib/schema.js`). A v1 file (`intervalSeconds`, no version) is migrated on
 *   load and written back as v2, so upgrading the plugin never loses settings.
 * - Runtime state (pulses, history, dedupe set) does **not** live here; it is
 *   `heartbeat-vitals.json` (see `lib/vitals.js`).
 *
 * @module dsh-plugin-heartbeat/store
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  CONFIG_VERSION,
  SettingsSchema,
  normalizeConfig,
  userLayerOf,
} from './schema.js'

export const HEARTBEAT_CONFIG_FILENAME = 'heartbeat.json'

export function defaultConfigPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), HEARTBEAT_CONFIG_FILENAME)
}

/**
 * @typedef {object} HeartbeatConfig
 * @property {number} version
 * @property {boolean} enabled
 * @property {'silent'|'assist'} mode
 * @property {number} baseIntervalSeconds
 * @property {number} pauseAfterMissed
 * @property {number} maxBeatsPerDay
 * @property {object|null} quietHours
 * @property {string[]} l3Allow
 * @property {number} proactiveCooldownSeconds v0.7 shared speech-right window (0 = off)
 * @property {number} userActiveSuppressSeconds v0.7 post-user-message silence (0 = off)
 * @property {boolean} physiologyLine v0.7 physiology signature switch
 */

/**
 * @param {object} options
 * @param {string} [options.path] absolute config-file path (defaults to `<dshHome>/heartbeat.json`)
 * @param {object} [options.base] composition defaults (v2 keys or v1 `intervalSeconds`)
 */
export class HeartbeatConfigStore {
  constructor(options = {}) {
    this.path = options.path ?? defaultConfigPath()
    // Composition config is the base layer; normalize it through the v2 schema
    // so a v1-style `intervalSeconds` in a profile patch still works.
    this.base = normalizeConfig(SettingsSchema(userLayerOf(options.base ?? {})))
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
      const layer = userLayerOf(raw)
      this.config = normalizeConfig(SettingsSchema({ ...this.base, ...layer }))
      if (raw.version !== CONFIG_VERSION) this.persist()
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
   * @param {object} patch
   * @returns {HeartbeatConfig} the new effective config
   * @throws {Error} on invalid fields or values
   */
  update(patch) {
    if (typeof patch !== 'object' || patch === null) throw new Error('config patch must be an object')
    const picked = userLayerOf(patch)
    const next = normalizeConfig(SettingsSchema({
      ...this.base,
      ...this.config,
      ...picked,
    }))
    this.config = next
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

