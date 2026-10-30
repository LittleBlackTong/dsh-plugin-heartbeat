import type { Context } from '@deepseek-ai/cordis'

/** One quiet-hours window (`HH:MM`), supports overnight ranges. */
export interface QuietHours {
  start: string
  end: string
}

/** Per-workspace config override (matched by session cwd). */
export interface WorkspaceOverride {
  enabled?: boolean
  mode?: 'silent' | 'assist'
  baseIntervalSeconds?: number
  quietHours?: QuietHours | null
  maxBeatsPerDay?: number
  l3Allow?: Array<'read' | 'test' | 'notes' | 'continue'>
}

/** Composition-level config (the user layer lives in `<dshHome>/heartbeat.json`). */
export interface HeartbeatConfig {
  /** Absolute path of the user config file (default `<dshHome>/heartbeat.json`). */
  configFile?: string
  /** Absolute path of the runtime-state file (default `<dshHome>/heartbeat-vitals.json`). */
  vitalsFile?: string
  /**
   * Absolute path of the shared cross-plugin proactive-cooldown file
   * (default `<dshHome>/proactive-cooldown.json`, shared with dsh-plugin-memory).
   */
  proactiveLockFile?: string
  /** Master switch for every session. Default `true`. */
  enabled?: boolean
  /** `silent` = pulses only check (L0), never open a turn; `assist` may ask. Default `assist`. */
  mode?: 'silent' | 'assist'
  /** Base interval in seconds, clamped to 30–86400. Default `600`. */
  baseIntervalSeconds?: number
  /** Deprecated v1 alias of `baseIntervalSeconds` (still accepted in patches). */
  intervalSeconds?: number
  /** Pause after this many unanswered pulses; a real user message resumes. 0 disables. Default `3`. */
  pauseAfterMissed?: number
  /** Instruction template (`{{time}}` / `{{tasks}}` / `{{reason}}`); null = built-in level templates. */
  prompt?: string | null
  /** Explicit backoff tiers in seconds (composition only). */
  backoffSeconds?: number[]
  /** Fold long history into a checkpoint before a pulse. Default `true`. */
  compactBeforeBeat?: boolean
  /** Sliding hourly cap; 0 = off. Default `0`. */
  maxBeatsPerHour?: number
  /** Delivered proactive messages per day; 0 = unlimited. Default `12`. */
  maxBeatsPerDay?: number
  /** Do not repeat the same signal key inside this window. Default `90`. */
  dedupeWindowMinutes?: number
  /** Minimum silence after a delivery. Default `300`. */
  refractorySeconds?: number
  /** Silence forced after a process restart. Default `300`. */
  restartCooldownSeconds?: number
  /** Scheduling jitter in seconds. Default `60`. */
  jitterSeconds?: number
  /** Quiet window (no proactive messages). `null` disables it. Default 23:00–08:00. */
  quietHours?: QuietHours | null
  /**
   * Cross-plugin speech-right arbitration window, in seconds: after another
   * proactive plugin (memory) spoke, heartbeat yields for this long. `0` disables
   * arbitration. Default `180`.
   */
  proactiveCooldownSeconds?: number
  /** Silence after a real user message, in seconds. `0` never suppresses. Default `120`. */
  userActiveSuppressSeconds?: number
  /** Render the one-line physiology signature into L1/L2/L4 messages. Default `true`. */
  physiologyLine?: boolean
  /** Inspect the session's task projections on every pulse. Default `true`. */
  taskNudge?: boolean
  /** Per-bucket item cap in the injected snapshot (1–20). Default `5`. */
  taskNudgeMaxItems?: number
  /** L3 auto-execute grants (instruction-level; approval still guards). Default `[]`. */
  l3Allow?: Array<'read' | 'test' | 'notes' | 'continue'>
  /** Per-workspace overrides keyed by absolute session cwd. */
  workspaces?: Record<string, WorkspaceOverride>
}

export const name: 'heartbeat'
export const inject: ['agents']

/** Schemastery schema applied to the plugin config before startup. */
export const Config: import('@deepseek-ai/schemastery').default<HeartbeatConfig>

export function apply(ctx: Context, config?: HeartbeatConfig): () => void

export default apply
