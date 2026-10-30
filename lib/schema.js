/**
 * Shared schemas for dsh-plugin-heartbeat — **config v2**.
 *
 * v2 把「用户意图」收成一份可校验的配置：节律参数、静默时段、去重窗口、
 * 预算、工作区覆盖、L3 授权类别。运行态（lastPulse、history、asked 集合）
 * 不进这里，见 `lib/vitals.js`（配置与状态分离，手改配置不会污染运行态）。
 *
 * ## v1 → v2 迁移
 *
 * v1 的 `intervalSeconds` 已改名为 `baseIntervalSeconds`；其余字段语义不变。
 * `migrateConfigV1toV2()` 接受任意旧/新形态，产出**校验后的 v2 对象**：
 * 未知字段丢弃（前向兼容靠 store 的合并策略，不靠 schema 放行）。
 *
 * @module dsh-plugin-heartbeat/schema
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_PROACTIVE_COOLDOWN_SECONDS } from './proactive-lock.js'
import { DEFAULT_USER_ACTIVE_SUPPRESS_SECONDS } from './gate.js'

/** Config file schema version written by this build. */
export const CONFIG_VERSION = 2

/** L3 可授权的动作类别（默认空 = 全不授权）。 */
export const L3_CATEGORIES = ['read', 'test', 'notes', 'continue']

/** 默认静默时段：23:00–08:00（跨午夜）。 */
export const DEFAULT_QUIET_HOURS = { start: '23:00', end: '08:00' }

const QuietHoursSchema = z.object({
  start: z.string().default(DEFAULT_QUIET_HOURS.start),
  end: z.string().default(DEFAULT_QUIET_HOURS.end),
})

const WorkspaceOverrideSchema = z.object({
  enabled: z.boolean(),
  mode: z.union([z.const('silent'), z.const('assist')]),
  baseIntervalSeconds: z.number().min(30).max(86400),
  quietHours: z.union([QuietHoursSchema, z.const(null)]),
  maxBeatsPerDay: z.number().min(0).max(1000),
  l3Allow: z.array(z.union(L3_CATEGORIES.map((category) => z.const(category)))),
})

/** The user-facing settings schema: composition config is the base layer. */
export const SettingsSchema = z.object({
  version: z.number().default(CONFIG_VERSION),
  enabled: z.boolean().default(true),
  /** `silent` = 只做静默检查（L0），永不主动开轮。 */
  mode: z.union([z.const('silent'), z.const('assist')]).default('assist'),
  baseIntervalSeconds: z.number().min(30).max(86400).default(600),
  pauseAfterMissed: z.number().min(0).max(100).default(3),
  backoffSeconds: z.union([z.array(z.number().min(30).max(86400)), z.const(null)]),
  compactBeforeBeat: z.boolean().default(true),
  maxBeatsPerHour: z.number().min(0).max(100).default(0),
  maxBeatsPerDay: z.number().min(0).max(1000).default(12),
  dedupeWindowMinutes: z.number().min(0).max(1440).default(90),
  refractorySeconds: z.number().min(0).max(86400).default(300),
  /** Deterministic scheduling jitter so several sessions do not fire in lockstep. */
  jitterSeconds: z.number().min(0).max(600).default(60),
  restartCooldownSeconds: z.number().min(0).max(86400).default(300),
  quietHours: z.union([QuietHoursSchema, z.const(null)]).default(DEFAULT_QUIET_HOURS),
  /** v0.6.1: never pulse while a child subagent/teammate is still working. */
  quietWhileChildrenActive: z.boolean().default(true),
  /**
   * v0.7 cross-plugin speech-right arbitration window in seconds (shared
   * `proactive-cooldown.json` protocol with dsh-plugin-memory). `0` disables it.
   */
  proactiveCooldownSeconds: z.number().min(0).max(86400).default(DEFAULT_PROACTIVE_COOLDOWN_SECONDS),
  /** v0.7: silence after a real user message, in seconds. `0` never suppresses. */
  userActiveSuppressSeconds: z.number().min(0).max(86400).default(DEFAULT_USER_ACTIVE_SUPPRESS_SECONDS),
  /** v0.7: render the one-line physiology signature into L1/L2/L4 messages. */
  physiologyLine: z.boolean().default(true),
  taskNudge: z.boolean().default(true),
  taskNudgeMaxItems: z.number().min(1).max(20).default(5),
  /** L3 授权类别；默认空数组表示不授权任何自动执行。 */
  l3Allow: z.array(z.union(L3_CATEGORIES.map((category) => z.const(category)))).default([]),
  prompt: z.union([z.string(), z.const(null)]),
  workspaces: z.dict(WorkspaceOverrideSchema).default({}),
})

/** The plain field set persisted to `heartbeat.json`. */
const PERSISTED_KEYS = [
  'version',
  'enabled',
  'mode',
  'baseIntervalSeconds',
  'pauseAfterMissed',
  'backoffSeconds',
  'compactBeforeBeat',
  'maxBeatsPerHour',
  'maxBeatsPerDay',
  'dedupeWindowMinutes',
  'refractorySeconds',
  'jitterSeconds',
  'restartCooldownSeconds',
  'quietHours',
  'quietWhileChildrenActive',
  // v0.7: speech-right arbitration + physiology / social rhythm.
  'proactiveCooldownSeconds',
  'userActiveSuppressSeconds',
  'physiologyLine',
  'taskNudge',
  'taskNudgeMaxItems',
  'l3Allow',
  'prompt',
  'workspaces',
]

/** Strip undefined so schema defaults still apply during merges. */
export function stripUndefined(input) {
  const output = {}
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value !== undefined) output[key] = value
  }
  return output
}


/** Config keys a user file or patch may set (v2 keys; legacy alias handled separately). */
export const USER_CONFIG_KEYS = PERSISTED_KEYS.filter((key) => key !== 'version')

/**
 * Extract only the explicitly provided config keys, converting the v1
 * `intervalSeconds` alias. Used to layer the user file/patch over the
 * composition base without letting schema defaults masquerade as user intent.
 *
 * @param {unknown} raw
 * @returns {object} partial v2 config
 */
export function userLayerOf(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const layer = {}
  for (const key of USER_CONFIG_KEYS) {
    if (raw[key] !== undefined) layer[key] = raw[key]
  }
  if (raw.baseIntervalSeconds === undefined && raw.intervalSeconds !== undefined) {
    layer.baseIntervalSeconds = raw.intervalSeconds
  }
  return layer
}

/**
 * Reduce a validated schema value to the persisted field set.
 * @param {object} resolved result of `SettingsSchema(...)`
 * @returns {object} plain v2 config
 */
export function normalizeConfig(resolved) {
  const output = {}
  for (const key of PERSISTED_KEYS) {
    if (resolved[key] !== undefined) output[key] = resolved[key]
  }
  output.version = CONFIG_VERSION
  if (output.backoffSeconds === undefined) output.backoffSeconds = null
  if (output.prompt === undefined) output.prompt = null
  if (output.workspaces === undefined) output.workspaces = {}
  return output
}

/**
 * Accept any v1/v2/partial config and return a validated v2 config.
 * Unknown keys are dropped; missing keys fall back to schema defaults.
 * @param {unknown} raw
 * @returns {object} v2 config
 */
export function migrateConfigV1toV2(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const mapped = {
    version: CONFIG_VERSION,
    enabled: source.enabled,
    mode: source.mode,
    // v1 named this `intervalSeconds`; v2 renamed it.
    baseIntervalSeconds: source.baseIntervalSeconds ?? source.intervalSeconds,
    pauseAfterMissed: source.pauseAfterMissed,
    backoffSeconds: source.backoffSeconds,
    compactBeforeBeat: source.compactBeforeBeat,
    maxBeatsPerHour: source.maxBeatsPerHour,
    maxBeatsPerDay: source.maxBeatsPerDay,
    dedupeWindowMinutes: source.dedupeWindowMinutes,
    refractorySeconds: source.refractorySeconds,
    restartCooldownSeconds: source.restartCooldownSeconds,
    quietHours: source.quietHours,
    proactiveCooldownSeconds: source.proactiveCooldownSeconds,
    userActiveSuppressSeconds: source.userActiveSuppressSeconds,
    physiologyLine: source.physiologyLine,
    taskNudge: source.taskNudge,
    taskNudgeMaxItems: source.taskNudgeMaxItems,
    l3Allow: source.l3Allow,
    prompt: source.prompt,
    workspaces: source.workspaces,
  }
  return normalizeConfig(SettingsSchema(stripUndefined(mapped)))
}

/**
 * Resolve the effective config for one workspace: global values, overridden by
 * the matched `workspaces[cwd]` entry when present.
 *
 * @param {object} config validated v2 config
 * @param {string | undefined} cwd absolute session working directory
 * @returns {object} effective config (same shape, `workspaces` preserved)
 */
export function resolveEffectiveConfig(config, cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return config
  const override = config.workspaces?.[cwd]
  if (override === undefined) return config
  const merged = { ...config }
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) merged[key] = value
  }
  return merged
}
