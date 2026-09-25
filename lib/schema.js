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
  report: z.object({
    enabled: z.boolean().default(false),
    retention: z.number().min(10).max(1000).default(200),
    model: z.union([z.object({
      provider: z.string(),
      model: z.string(),
    }), z.const(null), z.const(undefined)]),
  }).default({ enabled: false, retention: 200 }),
})
