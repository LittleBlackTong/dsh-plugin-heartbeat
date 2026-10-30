import type { Context } from '@deepseek-ai/cordis'

export interface HeartbeatConfig {
  /** Master switch for every session. Default `true`. */
  enabled?: boolean
  /** Heartbeat period in seconds, clamped to 30–86400. Default `600`. */
  intervalSeconds?: number
  /** Instruction template delivered on each beat; `{{time}}` / `{{tasks}}` are substituted. */
  prompt?: string
  /** Pause after this many unanswered beats; a real user message resumes. 0 disables. Default `3`. */
  pauseAfterMissed?: number
  /** Absolute path of the user config file (default `<dshHome>/heartbeat.json`). */
  configFile?: string
  /** v0.5.0: inspect the session's task projections on every beat and ask before acting. Default `true`. */
  taskNudge?: boolean
  /** v0.5.0: per-bucket item cap in the injected task snapshot (1–20). Default `5`. */
  taskNudgeMaxItems?: number
}

export const name: 'heartbeat'
export const inject: ['agents']

/** Schemastery schema applied to the plugin config before startup. */
export const Config: import('@deepseek-ai/schemastery').default<HeartbeatConfig>

export function apply(ctx: Context, config?: HeartbeatConfig): () => void

export default apply
