/**
 * dsh-plugin-heartbeat — autonomic wake-ups for DeepSeek Harness agents.
 *
 * A host-plane Cordis plugin that turns a timed heartbeat into an autonomic
 * nervous system: cheap silent pulses, signal-triggered activation (L0–L4),
 * persisted vitals, and an observable/controllable panel.
 *
 * ## What it does
 *
 * - `agent/created` → one runtime per ROOT agent (subagents skipped); hot mount
 *   also catch-ups over `ctx.agents.roots()` so already-open sessions beat too;
 * - each pulse: sensors read the session projections and diff them, rhythm picks
 *   the next interval (arousal/missed/quiet/refractory), gate decides the level;
 * - L0 records a silent pulse only; L1/L2/L4 inject one `followup` message whose
 *   text carries a why-now line and a level-appropriate instruction;
 * - `followup` is busy-safe: queued in the next-turn inbox, replaced in place.
 *
 * ## Config (v2)
 *
 * Stored in `<dshHome>/heartbeat.json` (auto-migrated from v1); runtime state in
 * `<dshHome>/heartbeat-vitals.json`. See `lib/schema.js` for the full shape.
 *
 * ## Routes
 *
 * | method | path | purpose |
 * |---|---|---|
 * | GET/POST | `/api/heartbeat/config` | read / patch the v2 config |
 * | GET | `/api/heartbeat/status` | vitals for every live session |
 * | POST | `/api/heartbeat/control` | beat-now / snooze / pause / resume / reset |
 *
 * @module dsh-plugin-heartbeat
 */

import z from '@deepseek-ai/schemastery'
import {
  HeartbeatRuntime,
  buildHeartbeatMessage,
  clampIntervalSeconds,
} from './runtime.js'
import { HeartbeatConfigStore } from './store.js'
import { VitalsStore, defaultVitalsPath } from './vitals.js'
import { DEFAULT_PROMPT, renderHeartbeatText, renderPrompt } from './prompt.js'
import { collectSessionTasks, clampMaxItems, renderTaskNudge } from './tasks.js'
import { resolveEffectiveConfig } from './schema.js'
import { collectSignals } from './sensors.js'
import { decide } from './gate.js'
import { computeIntervalMs } from './rhythm.js'

export const name = 'heartbeat'

/** Services required before the plugin can start observing agents. */
export const inject = ['agents']

/** Composition-level config schema (defaults live in the config store). */
export const Config = z.object({
  configFile: z.union([z.string(), z.const(undefined)]),
  vitalsFile: z.union([z.string(), z.const(undefined)]),
  enabled: z.boolean(),
  mode: z.union([z.const('silent'), z.const('assist')]),
  baseIntervalSeconds: z.number().min(30).max(86400),
  intervalSeconds: z.number().min(30).max(86400),
  pauseAfterMissed: z.number().min(0).max(100),
  prompt: z.string(),
  backoffSeconds: z.array(z.number().min(30).max(86400)),
  compactBeforeBeat: z.boolean(),
  maxBeatsPerHour: z.number().min(0).max(100),
  maxBeatsPerDay: z.number().min(0).max(1000),
  dedupeWindowMinutes: z.number().min(0).max(1440),
  refractorySeconds: z.number().min(0).max(86400),
  jitterSeconds: z.number().min(0).max(600),
  restartCooldownSeconds: z.number().min(0).max(86400),
  quietHours: z.union([z.object({ start: z.string(), end: z.string() }), z.const(null)]),
  quietWhileChildrenActive: z.boolean(),
  taskNudge: z.boolean(),
  taskNudgeMaxItems: z.number().min(1).max(20),
  l3Allow: z.array(z.string()),
  workspaces: z.dict(z.object({
    enabled: z.boolean(),
    mode: z.union([z.const('silent'), z.const('assist')]),
    baseIntervalSeconds: z.number().min(30).max(86400),
    quietHours: z.union([z.object({ start: z.string(), end: z.string() }), z.const(null)]),
    maxBeatsPerDay: z.number().min(0).max(1000),
    l3Allow: z.array(z.string()),
  })),
})

export const CONFIG_ROUTE_PATH = '/api/heartbeat/config'
export const STATUS_ROUTE_PATH = '/api/heartbeat/status'
export const CONTROL_ROUTE_PATH = '/api/heartbeat/control'

const COMPOSITION_KEYS = [
  'enabled',
  'mode',
  'baseIntervalSeconds',
  'intervalSeconds',
  'pauseAfterMissed',
  'prompt',
  'backoffSeconds',
  'compactBeforeBeat',
  'maxBeatsPerHour',
  'maxBeatsPerDay',
  'dedupeWindowMinutes',
  'refractorySeconds',
  'restartCooldownSeconds',
  'quietHours',
  'taskNudge',
  'taskNudgeMaxItems',
  'l3Allow',
  'workspaces',
]

/** Read the context-pressure ratio for one session, defensively. */
export function readPressure(projections, session) {
  if (projections === undefined || typeof projections.stateOf !== 'function' || session === undefined) return undefined
  try {
    const state = projections.stateOf(session, 'contextPressure')
    if (state === null || typeof state !== 'object') return undefined
    const window = Number(state.contextWindow)
    if (!Number.isFinite(window) || window <= 0) return undefined
    const sampled = Number(state.sampledSurfaceTokens)
    const projected = Number.isFinite(Number(state.pressureTokens)) && Number.isFinite(sampled)
      ? Math.max(0, Number(state.pressureTokens) + Number(state.surfaceTokens ?? 0) - sampled)
      : Number(state.surfaceTokens ?? 0)
    return Math.min(1, Math.max(0, projected / window))
  } catch {
    return undefined
  }
}

/** Compose a small JSON response. */
function sendJson(res, status, value) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  } catch {
    // the client may have gone away; nothing to do
  }
}

/** Read a JSON request body with a small size cap. */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

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

  // Composition config is the base layer; the user file/patch overrides it.
  const base = {}
  for (const key of COMPOSITION_KEYS) {
    if (config[key] !== undefined) base[key] = config[key]
  }
  const store = new HeartbeatConfigStore({
    path: typeof config.configFile === 'string' && config.configFile.length > 0 ? config.configFile : undefined,
    base,
  })

  const vitals = new VitalsStore({
    path: typeof config.vitalsFile === 'string' && config.vitalsFile.length > 0
      ? config.vitalsFile
      : defaultVitalsPath(),
    restartCooldownSeconds: Number(store.get().restartCooldownSeconds ?? 300),
  })

  // Optional host services — each degrades independently when missing.
  let compaction
  ctx.inject(['compaction'], (compactionCtx) => {
    compaction = compactionCtx.compaction
  })
  let projections
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projections = projectionCtx.sessionProjections
  })

  /** Effective config for one agent (workspace override by session cwd). */
  const configFor = (agent) => {
    const cwd = agent?.session?.header?.cwd
    return resolveEffectiveConfig(store.get(), cwd)
  }

  /**
   * Whether a session is a descriptor-backed subagent conversation. A resumed
   * child chat can be a "root" by runtime ownership, so root-only attachment is
   * not enough: heartbeat must never inject context into a subagent session.
   */
  const isSubagentSessionOf = (agent) => {
    try {
      const identity = projections?.stateOf?.(agent.session, 'subagent')
      return identity !== null && identity !== undefined
    } catch {
      return false
    }
  }

  /**
   * Whether one root agent still has running child work: child ids come from the
   * session's own `subagentCatalog` / `agentTeam` projections, activity from the
   * live agent registry (agent id === session id).
   */
  const childWorkActiveOf = (agent) => {
    const ids = new Set()
    try {
      const catalog = projections?.stateOf?.(agent.session, 'subagentCatalog')
      if (Array.isArray(catalog)) for (const entry of catalog) if (typeof entry?.id === 'string') ids.add(entry.id)
    } catch {
      // projection unavailable: fall through
    }
    try {
      const team = projections?.stateOf?.(agent.session, 'agentTeam')
      const members = Array.isArray(team?.members) ? team.members : []
      for (const member of members) {
        if (member?.role !== 'lead' && typeof member?.id === 'string') ids.add(member.id)
      }
    } catch {
      // projection unavailable: fall through
    }
    for (const id of ids) {
      const child = ctx.agents.get(id)
      if (child !== undefined && child.status !== 'idle') return true
    }
    return false
  }

  /** Public status for one runtime. */
  const statusOf = (entry) => {
    const sessionId = entry.runtime.sessionId
    const config = entry.runtime.readConfig()
    const session = vitals.get(sessionId)
    const budgetMax = Math.max(0, Number(config.maxBeatsPerDay ?? 0))
    const budgetUsed = budgetMax === 0 ? Number(vitals.state.global.budget.beats ?? 0) : budgetMax - vitals.budgetLeft(config)
    return {
      sessionId,
      cwd: entry.cwd,
      level: session.history.at(-1)?.level ?? 'L0',
      lastPulseAt: session.lastPulseAt,
      lastDeliveredAt: session.lastDeliveredAt,
      nextBeatAt: entry.runtime.nextBeatAt,
      paused: session.paused === true,
      pausedReason: session.pausedReason,
      snoozeUntil: session.snoozeUntil,
      missed: session.missedCount,
      budget: { used: budgetUsed, max: budgetMax },
      history: session.history.slice(-5),
    }
  }

  // Config hot-apply: any store change re-arms every runtime immediately.
  ctx.effect(() => {
    const unwatch = store.watch(() => {
      for (const entry of runtimes.values()) entry.runtime.reschedule()
    })
    return () => unwatch()
  }, 'heartbeat.store-watch()')

  // HTTP routes (optional: headless deployments have no webServer).
  ctx.inject(['webServer'], (webCtx) => {
    const routes = []
    const register = (path, handler) => {
      try {
        routes.push(webCtx.webServer.register({ kind: 'exact', path, handler }))
      } catch (error) {
        ctx.logger?.warn?.(`heartbeat: route ${path} not registered: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    register(CONFIG_ROUTE_PATH, async (req, res) => {
      try {
        if (req.method === 'GET') return sendJson(res, 200, store.get())
        if (req.method === 'POST') {
          let patch
          try {
            patch = await readJsonBody(req)
          } catch {
            return sendJson(res, 400, { error: 'body must be JSON' })
          }
          return sendJson(res, 200, store.update(patch))
        }
        return sendJson(res, 405, { error: 'method not allowed' })
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    })

    register(STATUS_ROUTE_PATH, async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      const sessions = []
      for (const entry of runtimes.values()) sessions.push(statusOf(entry))
      return sendJson(res, 200, {
        config: {
          mode: store.get().mode,
          enabled: store.get().enabled,
          quietHours: store.get().quietHours,
          maxBeatsPerDay: store.get().maxBeatsPerDay,
          l3Allow: store.get().l3Allow,
        },
        budget: { ...vitals.state.global.budget },
        sessions,
      })
    })

    register(CONTROL_ROUTE_PATH, async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        return sendJson(res, 400, { error: 'body must be JSON' })
      }
      const action = String(body?.action ?? '')
      const targetId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
      const targets = targetId !== undefined
        ? [...runtimes.entries()].filter(([sessionId]) => sessionId === targetId)
        : [...runtimes.entries()]
      if (targets.length === 0) return sendJson(res, 404, { error: 'no live heartbeat session' })
      const minutes = Math.max(1, Math.min(1440, Number(body?.minutes ?? 60)))
      try {
        for (const [, entry] of targets) {
          const sessionId = entry.runtime.sessionId
          switch (action) {
            case 'beat-now':
              entry.runtime.forceBeat()
              break
            case 'snooze':
              vitals.snooze(sessionId, Date.now() + minutes * 60_000)
              entry.runtime.reschedule()
              break
            case 'pause':
              entry.runtime.pause('manual')
              break
            case 'resume':
              entry.runtime.resume()
              break
            case 'reset':
              vitals.snooze(sessionId, 0)
              vitals.setPaused(sessionId, false)
              entry.runtime.resume()
              break
            default:
              return sendJson(res, 400, { error: `unknown action ${JSON.stringify(action)}` })
          }
        }
        return sendJson(res, 200, {
          ok: true,
          action,
          sessions: targets.map(([, entry]) => statusOf(entry)),
        })
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    })

    webCtx.effect(() => () => {
      for (const dispose of routes) dispose()
    }, 'heartbeat.routes()')
    ctx.logger?.info(`heartbeat: routes at ${CONFIG_ROUTE_PATH} / ${STATUS_ROUTE_PATH} / ${CONTROL_ROUTE_PATH} (store ${store.path})`)
  })

  // Event-driven beats: projection changes are a signal, debounced per runtime.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const service = projectionCtx.sessionProjections
    if (service === undefined || typeof service.onChanged !== 'function') return
    const watched = new Set(['todos', 'agentTeam', 'goal', 'userQuestions'])
    const off = service.onChanged((session, key) => {
      if (!watched.has(key)) return
      for (const [, entry] of runtimes) {
        if (entry.runtime.agent?.session === session) {
          entry.runtime.noteSignal()
          break
        }
      }
    })
    projectionCtx.effect(() => () => off?.(), 'heartbeat.projection-watch()')
  })

  return ctx.effect(() => {
    /** Attach one runtime to a live ROOT agent (idempotent). */
    const attach = (agent) => {
      if (stopping || runtimes.has(agent.id)) return
      if (!ctx.agents.roots().includes(agent)) return
      // Subagent conversations are never ours to wake.
      if (isSubagentSessionOf(agent)) {
        ctx.logger?.info(`heartbeat: skip subagent session "${agent.id}"`)
        return
      }
      const runtime = new HeartbeatRuntime(agent, {
        readConfig: () => configFor(agent),
        getCompaction: () => compaction,
        getProjections: () => projections,
        getVitals: () => vitals,
        getPressure: () => readPressure(projections, agent.session),
        isChildActive: () => childWorkActiveOf(agent),
        isSubagentSession: () => isSubagentSessionOf(agent),
        logger: ctx.logger,
        agents: ctx.agents,
      })
      const entry = {
        runtime,
        cleanup: undefined,
        cwd: agent.session?.header?.cwd,
      }
      entry.cleanup = agent.ctx.effect(() => {
        runtime.start()
        return () => {
          runtime.dispose()
          if (runtimes.get(agent.id) === entry) runtimes.delete(agent.id)
        }
      }, 'heartbeat.runtime()')
      runtimes.set(agent.id, entry)
      ctx.logger?.info(`heartbeat: attached to root agent "${agent.id}" (interval ${configFor(agent).baseIntervalSeconds}s)`)
    }

    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      attach(agent)
    })
    // Hot-mount path: a plugin mounted/reloaded while sessions are already live
    // never sees their `agent/created`, so catch up once, idempotently.
    for (const agent of ctx.agents.roots()) attach(agent)
    return async () => {
      stopping = true
      stopCreated()
      const entries = [...runtimes.values()]
      runtimes.clear()
      await Promise.allSettled(entries.map((entry) => Promise.resolve(entry.cleanup())))
      vitals.flush()
      vitals.dispose()
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

export { HeartbeatRuntime, buildHeartbeatMessage, clampIntervalSeconds, renderHeartbeatText, renderPrompt, HeartbeatConfigStore, VitalsStore, DEFAULT_PROMPT }
export { collectSessionTasks, renderTaskSnapshot, renderTaskNudge, clampMaxItems, readTodos, readTeamTasks, readGoal } from './tasks.js'
export { collectSignals, signatureOf, teamSnapshotOf, activeQuestionIds } from './sensors.js'
export { decide, reasonOf, DECISION_KINDS } from './gate.js'
export { computeIntervalMs, inQuietHours, quietRemainingMs, jitterFor, parseClock } from './rhythm.js'
