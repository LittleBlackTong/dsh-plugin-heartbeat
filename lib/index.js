/**
 * dsh-plugin-heartbeat — proactive wake-ups for DeepSeek Harness agents.
 *
 * ## What it does
 *
 * A host-plane Cordis plugin that listens for `agent/created` and attaches a
 * per-session timer to every ROOT agent (subagents are skipped). On each
 * tick the agent receives a synthetic user-role message (source kind
 * `plugin:heartbeat`) through `agent.followup()`:
 *
 * - idle → a fresh turn opens immediately, so the agent proactively reports
 *   progress, risks, blockers, or just says hi;
 * - busy → the heartbeat parks in the `next-turn` inbox and is delivered
 *   right after the current turn ends — it never interrupts running work
 *   and never gets lost;
 * - consecutive busy ticks replace the queued heartbeat in place, so at
 *   most one is ever pending.
 *
 * ## Task inspection (v0.5.0)
 *
 * Before each beat the plugin reads the session's task projections (`todos`,
 * `agentTeam`, `goal`) and injects a compact snapshot plus an instruction to
 * ASK the user before acting on anything it finds. It never starts work on
 * its own. See `lib/tasks.js`; disable with `taskNudge: false`.
 *
 * ## Config
 *
 * | key | default | meaning |
 * |---|---|---|
 * | `enabled` | `true` | master switch for every session |
 * | `intervalSeconds` | `600` | heartbeat period (clamped to 30–86400) |
 * | `prompt` | built-in | instruction template delivered on each beat (`{{time}}` / `{{tasks}}` are substituted) |
 * | `pauseAfterMissed` | `3` | pause after N unanswered beats; a real user message resumes (0 = off) |
 * | `taskNudge` | `true` | inspect the session's tasks on every beat and ask before acting |
 * | `taskNudgeMaxItems` | `5` | per-bucket item cap in the injected snapshot (1–20) |
 *
 * The user-facing fields live in `<dshHome>/heartbeat.json`, served to the
 * browser through the plugin's own HTTP route — the settings wire only
 * serves a hard-coded namespace allowlist, so a plugin namespace is never
 * remotely writable (see `lib/store.js`).
 *
 * ## Install
 *
 * ```sh
 * pnpm add dsh-plugin-heartbeat
 * ```
 *
 * Then add a row to your profile `cordis.patch.yml`:
 *
 * ```yaml
 * - insert:
 *     - id: dsh-heartbeat
 *       name: dsh-plugin-heartbeat
 *       config:
 *         intervalSeconds: 600
 * ```
 *
 * @module dsh-plugin-heartbeat
 */

import z from '@deepseek-ai/schemastery'
import { HeartbeatRuntime, buildHeartbeatMessage, clampIntervalSeconds } from './runtime.js'
import { HeartbeatConfigStore } from './store.js'
import { DEFAULT_PROMPT, renderPrompt } from './prompt.js'
import { collectSessionTasks, clampMaxItems, renderTaskNudge } from './tasks.js'

export const name = 'heartbeat'

/** Services required before the plugin can start observing agents. */
export const inject = ['agents']

/** Schemastery schema applied to the plugin config before startup. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  intervalSeconds: z.number().min(30).max(86400).default(600),
  prompt: z.string().default(DEFAULT_PROMPT),
  pauseAfterMissed: z.number().min(0).max(100).default(3),
  configFile: z.union([z.string(), z.const(undefined)]),
  // v0.4.0: backoff schedule, lightweight wake-ups, hourly budget.
  backoffSeconds: z.union([z.array(z.number().min(30).max(86400)), z.const(undefined)]),
  compactBeforeBeat: z.boolean().default(true),
  maxBeatsPerHour: z.number().min(0).max(100).default(0),
  // v0.5.0: inspect the session's task projections on every beat and ASK the
  // user before doing anything about them.
  taskNudge: z.boolean().default(true),
  taskNudgeMaxItems: z.number().min(1).max(20).default(5),
})

export const CONFIG_ROUTE_PATH = '/api/heartbeat/config'

/**
 * Cordis plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('../types/index.d.ts').HeartbeatConfig} config
 * @returns {() => void} disposer
 */
export function apply(ctx, config = {}) {
  const runtimes = new Map()
  let stopping = false

  // Single user-facing config source: composition defaults + heartbeat.json.
  const store = new HeartbeatConfigStore({
    path: typeof config.configFile === 'string' && config.configFile.length > 0 ? config.configFile : undefined,
    base: {
      enabled: config.enabled !== false,
      intervalSeconds: clampIntervalSeconds(config.intervalSeconds, 600),
      pauseAfterMissed: Math.max(0, Math.trunc(Number(config.pauseAfterMissed ?? 3))),
      taskNudge: config.taskNudge !== false,
      taskNudgeMaxItems: clampMaxItems(config.taskNudgeMaxItems, 5),
    },
  })

  const readConfig = () => {
    const resolved = store.get()
    return {
      enabled: resolved.enabled,
      intervalSeconds: clampIntervalSeconds(resolved.intervalSeconds, 600),
      prompt: typeof config.prompt === 'string' && config.prompt.length > 0 ? config.prompt : DEFAULT_PROMPT,
      pauseAfterMissed: Math.max(0, Math.trunc(Number(resolved.pauseAfterMissed ?? 3))),
      backoffSeconds: config.backoffSeconds,
      compactBeforeBeat: config.compactBeforeBeat !== false,
      maxBeatsPerHour: Math.max(0, Math.trunc(Number(config.maxBeatsPerHour ?? 0))),
      taskNudge: resolved.taskNudge !== false,
      taskNudgeMaxItems: clampMaxItems(resolved.taskNudgeMaxItems, 5),
    }
  }

  // Optional host compaction service: enables the lightweight wake-up path
  // (fold long history into a checkpoint before each beat). Missing in some
  // profiles — the runtime then simply delivers the beat un-compacted.
  let compaction
  ctx.inject(['compaction'], (compactionCtx) => {
    compaction = compactionCtx.compaction
  })

  // Optional projection registry: lets a beat read the session's todos, team
  // board and goal (v0.5.0). Older/headless compositions may not register it;
  // the beat then degrades to the prompt-only inspection instruction.
  let projections
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projections = projectionCtx.sessionProjections
  })

  // Config hot-apply: any store change re-arms every runtime immediately.
  ctx.effect(() => {
    const unwatch = store.watch(() => {
      for (const entry of runtimes.values()) entry.runtime.reschedule()
    })
    return () => {
      unwatch()
    }
  }, 'heartbeat.store-watch()')

  // Browser config route (optional: headless deployments have no webServer).
  ctx.inject(['webServer'], (webCtx) => {
    const disposeRoute = webCtx.webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE_PATH,
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(store.get()))
            return
          }
          if (req.method === 'POST') {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = Buffer.concat(chunks).toString('utf8')
            let patch
            try {
              patch = JSON.parse(body)
            } catch {
              res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: 'body must be JSON' }))
              return
            }
            const next = store.update(patch)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(next))
            return
          }
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    })
    webCtx.effect(() => disposeRoute, 'heartbeat.config-route()')
    ctx.logger?.info(`heartbeat: config route at ${CONFIG_ROUTE_PATH} (store ${store.path})`)
  })

  return ctx.effect(() => {
    /** Attach one heartbeat runtime to a live ROOT agent (idempotent). */
    const attach = (agent) => {
      if (stopping || runtimes.has(agent)) return
      if (!ctx.agents.roots().includes(agent)) return
      const runtime = new HeartbeatRuntime(agent, {
        readConfig,
        getCompaction: () => compaction,
        getProjections: () => projections,
        logger: ctx.logger,
        agents: ctx.agents,
      })
      const entry = { runtime, cleanup: undefined }
      entry.cleanup = agent.ctx.effect(() => {
        runtime.start()
        return () => {
          runtime.dispose()
          // The agent-scoped effect disposes on agent teardown; drop the map
          // entry with it so a long-lived desktop does not accumulate dead
          // agents (and does not treat a resumed id as still attached).
          if (runtimes.get(agent) === entry) runtimes.delete(agent)
        }
      }, 'heartbeat.runtime()')
      runtimes.set(agent, entry)
      ctx.logger?.info(`heartbeat: attached to root agent "${agent.id}" (interval ${readConfig().intervalSeconds}s)`)
    }

    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      attach(agent)
    })
    // Hot-mount path (v0.5.0): a plugin mounted/reloaded while sessions are
    // already live never sees their `agent/created`, so they would silently
    // never beat. Catch up with the live registry once, idempotently.
    for (const agent of ctx.agents.roots()) attach(agent)
    return async () => {
      stopping = true
      stopCreated()
      const entries = [...runtimes.values()]
      runtimes.clear()
      await Promise.allSettled(entries.map((entry) => Promise.resolve(entry.cleanup())))
    }
  }, 'heartbeat.lifecycle()')
}

// DSH's loader unwraps a package's default export before it starts the
// Cordis plugin. Keep the default export callable for direct consumers, but
// attach the Cordis metadata to that function so injected services and the
// config schema survive the unwrap step.
Object.defineProperties(apply, {
  name: { value: name },
  inject: { value: inject },
  Config: { value: Config },
})

export default apply

export { HeartbeatRuntime, buildHeartbeatMessage, clampIntervalSeconds, renderPrompt, HeartbeatConfigStore, DEFAULT_PROMPT }
export { collectSessionTasks, renderTaskNudge, clampMaxItems, readTodos, readTeamTasks, readGoal } from './tasks.js'
