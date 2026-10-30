/**
 * Shared schemas for dsh-plugin-heartbeat.
 *
 * Split out so the config store can validate without importing the plugin
 * entry (which imports the store).
 *
 * @module dsh-plugin-heartbeat/schema
 */

import z from '@deepseek-ai/schemastery'

/** The user-facing settings schema: composition config is the base layer. */
export const SettingsSchema = z.object({
  enabled: z.boolean().default(true),
  intervalSeconds: z.number().min(30).max(86400).default(600),
  pauseAfterMissed: z.number().min(0).max(100).default(3),
  /** v0.5.0: inspect the session's task projections on every beat. */
  taskNudge: z.boolean().default(true),
  /** v0.5.0: per-bucket item cap in the injected task snapshot. */
  taskNudgeMaxItems: z.number().min(1).max(20).default(5),
})
