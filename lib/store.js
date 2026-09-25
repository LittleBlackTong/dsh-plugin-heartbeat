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
 * @property {{ enabled: boolean, retention: number }} report
 */

/**
 * @param {object} options
 * @param {string} [options.path] absolute config-file path (defaults to `<dshHome>/heartbeat.json`)
 * @param {object} [options.base] composition defaults ({enabled, intervalSeconds, pauseAfterMissed, report})
 */
export class HeartbeatConfigStore {
  constructor(options = {}) {
    this.path = options.path ?? defaultConfigPath()
    this.base = {
      enabled: options.base?.enabled !== false,
      intervalSeconds: Number(options.base?.intervalSeconds ?? 600),
      pauseAfterMissed: Number(options.base?.pauseAfterMissed ?? 3),
      report: {
        enabled: options.base?.report?.enabled === true,
        retention: Math.max(10, Math.trunc(Number(options.base?.report?.retention ?? 200))),
        model: options.base?.report?.model,
      },
    }
    this.config = { ...this.base, report: { ...this.base.report } }
    this.watchers = new Set()
    this.load()
  }

  /** Read the user file if present; invalid files are ignored, not fatal. */
  load() {
    let raw
    try {
      if (!existsSync(this.path)) return
      // Tolerate a UTF-8 BOM: PowerShell's `Set-Content -Encoding UTF8` writes
      // one, and JSON.parse rejects it.
      raw = JSON.parse(readFileSync(this.path, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      return // corrupt file: keep last good config
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
    try {
      const merged = { ...this.base, ...pickFields(raw) }
      merged.report = { ...(this.base.report ?? {}), ...(merged.report ?? {}) }
      const resolved = SettingsSchema(merged)
      this.config = {
        enabled: resolved.enabled,
        intervalSeconds: resolved.intervalSeconds,
        pauseAfterMissed: resolved.pauseAfterMissed,
        report: {
          enabled: resolved.report.enabled,
          retention: resolved.report.retention,
          model: resolved.report.model ?? undefined,
        },
      }
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
   * @param {{ enabled?: boolean, intervalSeconds?: number, pauseAfterMissed?: number, report?: { enabled?: boolean, retention?: number } }} patch
   * @returns {HeartbeatConfig} the new effective config
   * @throws {Error} on invalid fields or values
   */
  update(patch) {
    if (typeof patch !== 'object' || patch === null) throw new Error('config patch must be an object')
    const merged = { ...this.base, ...this.config, ...pickFields(patch) }
    merged.report = { ...(this.base.report ?? {}), ...(this.config.report ?? {}), ...(merged.report ?? {}) }
    const next = SettingsSchema(merged)
    this.config = {
      enabled: next.enabled,
      intervalSeconds: next.intervalSeconds,
      pauseAfterMissed: next.pauseAfterMissed,
      report: {
        enabled: next.report.enabled,
        retention: next.report.retention,
        model: next.report.model ?? undefined,
      },
    }
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
  for (const key of ['enabled', 'intervalSeconds', 'pauseAfterMissed']) {
    if (input[key] !== undefined) picked[key] = input[key]
  }
  if (input.report !== undefined) {
    if (typeof input.report === 'object' && input.report !== null) {
      picked.report = { ...input.report }
    }
  }
  return picked
}
