import type { Context } from '@deepseek-ai/cordis'

export interface HeartbeatConfig {
  /** Master switch for every session. Default `true`. */
  enabled?: boolean
  /** Heartbeat period in seconds, clamped to 30–86400. Default `600`. */
  intervalSeconds?: number
  /** Instruction template delivered on each beat; `{{time}}` is substituted. */
  prompt?: string
  /** Pause after this many unanswered beats; a real user message resumes. 0 disables. Default `3`. */
  pauseAfterMissed?: number
  /** Absolute path of the user config file (default `<dshHome>/heartbeat.json`). */
  configFile?: string
  /** Explicit backoff tiers in seconds, e.g. `[600, 900, 1800]`. */
  backoffSeconds?: number[]
  /** Mode A only: fold long history into a checkpoint before each beat. Default `true`. */
  compactBeforeBeat?: boolean
  /** Sliding hourly beat budget (0 = off). Default `0`. */
  maxBeatsPerHour?: number
  /** Report engine (mode B): silent per-session heartbeats collected into the settings "心跳报告" page. */
  report?: {
    /** Switch to report mode. Default `false`. */
    enabled?: boolean
    /** Report entries kept. Default `200`. */
    retention?: number
    /** Model judgment on suspicion. */
    judgment?: {
      /** Whether a model re-judges suspected digests. Default `true`. */
      enabled?: boolean
      /** Fixed judgment route; unset = Harness default model. */
      model?: { provider: string; model: string }
    }
    /** Follow-the-beat strategies (zero-token sensors). */
    strategies?: HeartbeatStrategy[]
  }
}

export interface HeartbeatStrategy {
  id: string
  label?: string
  /** Evaluate every N beats. Default `1`. */
  every?: number
  /** Report dot level on hit: info | warn | error. Default `warn`. */
  level?: 'info' | 'warn' | 'error'
  /** Report summary on hit. */
  message?: string
  sensor: {
    kind: 'file'
    path: string
    /** changed (report only on mtime/size change) | exists | missing. Default `changed`. */
    mode?: 'changed' | 'exists' | 'missing'
  }
  /** Optional: wake this session when the strategy hits. */
  wake?: { sessionId: string }
  /** Optional prompt injected into the woken session. */
  wakePrompt?: string
}

export const name: 'heartbeat'
export const inject: ['agents']

/** Schemastery schema applied to the plugin config before startup. */
export const Config: import('@deepseek-ai/schemastery').default<HeartbeatConfig>

export function apply(ctx: Context, config?: HeartbeatConfig): () => void

export default apply
