/**
 * dsh-plugin-heartbeat — proactive wake-ups for DeepSeek Harness agents.
 *
 * Two modes share one plugin:
 *
 * ## Mode A (default, upstream behavior)
 * A host-plane Cordis plugin that listens for `agent/created` and attaches a
 * per-session timer to every ROOT agent (subagents are skipped). On each tick
 * the agent receives a synthetic user-role message (source kind
 * `plugin:heartbeat`, the producer-owned form session format v4 requires)
 * through `agent.followup()`:
 * - idle → a fresh turn opens immediately, so the agent proactively reports;
 * - busy → the heartbeat parks in the `next-turn` inbox and is delivered
 *   right after the current turn ends — it never interrupts running work;
 * - consecutive busy ticks replace the queued heartbeat in place.
 *
 * ## Mode B (`report.enabled`, opt-in)
 * Source sessions stay SILENT: no message is injected, no model token is
 * spent in them. One engine runs the four-stage pipeline instead:
 *
 *   拍点 → ①采集(机械摘要，0 token) → ②判定(机械规则 + 仅可疑时一次模型调用)
 *        → ③分发(报告条目/红绿点/策略唤醒) → ④记账(无人应答硬停·退避·每小时上限)
 *
 * Reports live in the settings UI ("心跳报告" page), not in a session.
 * `report.judgment.model` selects the model for the judgment call — the
 * Harness default model unless overridden; the model picker in the settings
 * UI flags the cheapest priced model as recommended.
 *
 * ## Config
 * | key | default | meaning |
 * |---|---|---|
 * | `enabled` | `true` | master switch |
 * | `intervalSeconds` | `600` | heartbeat period (30–86400) |
 * | `prompt` | built-in | mode A instruction template (`{{time}}` substituted) |
 * | `pauseAfterMissed` | `3` | hard stop after N unanswered beats (0 = off) |
 * | `backoffSeconds` | unset | explicit backoff tiers, e.g. `[600, 900, 1800]` |
 * | `compactBeforeBeat` | `true` | mode A only: compact before the beat |
 * | `maxBeatsPerHour` | `0` | hourly beat budget (0 = off) |
 * | `report.enabled` | `false` | switch to report mode (engine) |
 * | `report.retention` | `200` | report entries kept |
 * | `report.judgment.enabled` | `true` | model judgment on suspicion |
 * | `report.judgment.model` | unset | `{provider, model}` override; default = Harness default model |
 * | `report.strategies` | `[]` | follow-the-beat sensors (file changed/exists/missing) |
 * | `configFile` | `<dshHome>/heartbeat.json` | user-facing settings file |
 *
 * @module dsh-plugin-heartbeat
 */

import z from '@deepseek-ai/schemastery'
import { HeartbeatRuntime, buildHeartbeatMessage, clampIntervalSeconds } from './runtime.js'
import { HeartbeatConfigStore } from './store.js'
import { DEFAULT_PROMPT } from './prompt.js'
import { HeartbeatEngine } from './engine.js'
import { HeartbeatReportStore, REPORT_FILENAME } from './report-store.js'
import { annotateModels, priceFor, costPerCall } from './model-pricing.js'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'heartbeat'

/** Services required before the plugin can start observing agents. */
export const inject = ['agents']

export const REPORT_MD_FILENAME = 'heartbeat-report.md'

/** Absolute path of the .md report document (opened from the settings UI). */
export function defaultReportMdPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), REPORT_MD_FILENAME)
}

/** Reveal the .md report in the OS file manager (Explorer / Finder). */
export function openInFileManager(path) {
  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', [`/select,${path}`], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', ['-R', path], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [dirname(path)], { detached: true, stdio: 'ignore' }).unref()
    }
    return true
  } catch {
    return false
  }
}

/** Schemastery schema applied to the plugin config before startup. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  intervalSeconds: z.number().min(30).max(86400).default(600),
  prompt: z.string().default(DEFAULT_PROMPT),
  pauseAfterMissed: z.number().min(0).max(100).default(3),
  configFile: z.union([z.string(), z.const(undefined)]),
  backoffSeconds: z.union([z.array(z.number().min(30).max(86400)), z.const(undefined)]),
  compactBeforeBeat: z.boolean().default(true),
  maxBeatsPerHour: z.number().min(0).max(100).default(0),
  report: z.object({
    enabled: z.boolean().default(false),
    retention: z.number().min(10).max(1000).default(200),
    judgment: z.object({
      enabled: z.boolean().default(true),
      model: z.union([z.object({
        provider: z.string(),
        model: z.string(),
      }), z.const(undefined)]),
    }).default({ enabled: true }),
    strategies: z.array(z.object({
      id: z.string(),
      label: z.string().default(''),
      every: z.number().min(1).max(10000).default(1),
      level: z.union([z.const('info'), z.const('warn'), z.const('decide')]).default('warn'),
      message: z.string().default(''),
      sensor: z.object({
        kind: z.const('file'),
        path: z.string(),
        mode: z.union([z.const('changed'), z.const('exists'), z.const('missing')]).default('changed'),
      }),
      wake: z.union([z.object({ sessionId: z.string() }), z.const(undefined)]),
      wakePrompt: z.union([z.string(), z.const(undefined)]),
    })).default([]),
  }).default({
    enabled: false,
    retention: 200,
    judgment: { enabled: true },
    strategies: [],
  }),
})

export const CONFIG_ROUTE_PATH = '/api/heartbeat/config'
export const REPORTS_ROUTE_PATH = '/api/heartbeat/reports'
export const MODELS_ROUTE_PATH = '/api/heartbeat/models'
export const REPORTS_OPEN_ROUTE_PATH = '/api/heartbeat/reports/open'

/**
 * Cordis plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 * @returns {() => void} disposer
 */
export function apply(ctx, config = {}) {
  const runtimes = new Map()
  let stopping = false
  const reportOptions = config.report ?? {}

  // ----- user-facing config: composition base + <dshHome>/heartbeat.json -----
  const store = new HeartbeatConfigStore({
    path: typeof config.configFile === 'string' && config.configFile.length > 0 ? config.configFile : undefined,
    base: {
      enabled: config.enabled !== false,
      intervalSeconds: clampIntervalSeconds(config.intervalSeconds, 600),
      pauseAfterMissed: Math.max(0, Math.trunc(Number(config.pauseAfterMissed ?? 3))),
      report: {
        enabled: reportOptions.enabled === true,
        retention: Math.max(10, Math.trunc(Number(reportOptions.retention ?? 200))),
      },
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
    }
  }

  const readReportConfig = () => {
    const resolved = store.get()
    return {
      enabled: resolved.report?.enabled === true,
      retention: Math.max(10, Math.trunc(Number(resolved.report?.retention ?? 200))),
      judgment: {
        enabled: reportOptions.judgment?.enabled !== false,
        model: resolved.report?.model ?? reportOptions.judgment?.model,
      },
      strategies: Array.isArray(reportOptions.strategies) ? reportOptions.strategies : [],
    }
  }

  // ----- optional host services (missing in some profiles → graceful degradation) -----
  let compaction
  ctx.inject(['compaction'], (c) => {
    compaction = c.compaction
  })
  let fsService
  ctx.inject(['fs'], (c) => {
    fsService = c.fs
  })
  let llmService
  ctx.inject(['llm'], (c) => {
    llmService = c.llm
  })
  let defaultModelService
  ctx.inject(['agentDefaultModel'], (c) => {
    defaultModelService = c.agentDefaultModel
  })
  let sessionTitleService
  ctx.inject(['sessionTitle'], (c) => {
    sessionTitleService = c.sessionTitle
  })
  let sessionsService
  ctx.inject(['sessions'], (c) => {
    sessionsService = c.sessions
  })

  const defaultModel = () => {
    const selection = defaultModelService?.currentSelection?.()
    if (selection?.provider && selection.model) return { provider: selection.provider, model: selection.model }
    return undefined
  }

  /** Judgment route: explicit override wins, then the Harness default model. */
  const judgmentRoute = () => {
    const override = readReportConfig().judgment?.model
    if (override?.provider && override.model) return { provider: override.provider, model: override.model }
    return defaultModel()
  }

  // ----- report store + engine -----
  const reportStore = new HeartbeatReportStore({ retention: readReportConfig().retention })
  const reportMdPath = defaultReportMdPath()
  let engine

  const attachRuntime = (agent) => {
    if (stopping || runtimes.has(agent) || !ctx.agents.roots().includes(agent)) return
    const runtime = new HeartbeatRuntime(agent, {
      readConfig,
      getCompaction: () => compaction,
      logger: ctx.logger,
      agents: ctx.agents,
    })
    const cleanup = agent.ctx.effect(() => {
      runtime.start()
      return () => {
        runtime.dispose()
      }
    }, 'heartbeat.runtime()')
    runtimes.set(agent, { runtime, cleanup })
    ctx.logger?.info(`heartbeat: attached to root agent "${agent.id}" (interval ${readConfig().intervalSeconds}s)`)
  }

  const detachRuntimes = () => {
    const entries = [...runtimes.values()]
    runtimes.clear()
    for (const entry of entries) {
      try {
        entry.cleanup()
      } catch {
        // best-effort
      }
    }
  }

  const startEngine = () => {
    if (engine) return
    reportStore.retention = readReportConfig().retention
    engine = new HeartbeatEngine(ctx, {
      readConfig,
      readReportConfig,
      reportStore,
      getFs: () => fsService,
      getLlm: () => llmService,
      getDefaultModel: () => judgmentRoute(),
      getSessions: () => sessionsService,
      getTitle: (session) => {
        try {
          return sessionTitleService?.get?.(session)?.title
        } catch {
          return undefined
        }
      },
      getReportMdPath: () => reportMdPath,
      logger: ctx.logger,
    })
    engine.start()
    ctx.logger?.info('heartbeat: report engine started (mode B)')
  }

  const stopEngine = () => {
    engine?.dispose?.()
    engine = undefined
  }

  /** Mode switch: report on → engine only; off → per-agent runtimes. */
  const applyMode = () => {
    if (stopping) return
    // Retention changes apply immediately (prunes now, no restart needed).
    reportStore.setRetention?.(readReportConfig().retention)
    if (readReportConfig().enabled) {
      detachRuntimes()
      startEngine()
    } else {
      stopEngine()
      for (const agent of ctx.agents.roots()) attachRuntime(agent)
    }
  }

  // ----- config hot-apply -----
  ctx.effect(() => {
    const unwatch = store.watch(() => {
      for (const entry of runtimes.values()) entry.runtime.reschedule()
      engine?.reschedule?.()
      applyMode()
    })
    return () => {
      unwatch()
    }
  }, 'heartbeat.store-watch()')

  // ----- browser routes -----
  ctx.inject(['webServer'], (webCtx) => {
    const disposeConfig = webCtx.webServer.register({
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

    const disposeReports = webCtx.webServer.register({
      kind: 'exact',
      path: REPORTS_ROUTE_PATH,
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const entries = reportStore.snapshot()
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({
              entries,
              reportEnabled: readReportConfig().enabled,
              engine: engine ? engine.status() : { status: 'disabled' },
            }))
            return
          }
          if (req.method === 'POST') {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            let body = {}
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            } catch {
              // empty body is fine
            }
            // 打开报告页 = 人类在场（硬停锚点）；不再有"未读/已读"概念。
            if (body?.action === 'touch') engine?.touch?.()
            if (body?.action === 'clear') {
              reportStore.clear()
              engine?.writeMarkdown?.()
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: true }))
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

    const disposeModels = webCtx.webServer.register({
      kind: 'exact',
      path: MODELS_ROUTE_PATH,
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'method not allowed' }))
            return
          }
          const current = defaultModel()
          /** @type {Array<{ provider: string, model: string, name: string }>} */
          const models = []
          if (llmService?.listProviders && llmService?.listModels) {
            const providers = llmService.listProviders()
            for (const providerInfo of providers.slice(0, 12)) {
              try {
                const listed = await llmService.listModels(providerInfo.id)
                for (const info of listed.slice(0, 16)) {
                  models.push({ provider: providerInfo.id, model: info.id, name: info.name ?? info.id })
                }
              } catch {
                // provider listing failure: skip
              }
            }
          }
          const annotated = annotateModels(models.map(({ provider, model }) => ({ provider, model })))
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({
            default: current ?? null,
            selected: readReportConfig().judgment?.model ?? null,
            recommended: annotated.cheapest ?? current ?? null,
            models: models.map(({ provider, model, name }) => {
              const price = annotated.models.find((entry) => entry.provider === provider && entry.model === model)?.price
              return { provider, model, name, price: price ?? null }
            }),
          }))
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    })

    const disposeOpen = webCtx.webServer.register({
      kind: 'exact',
      path: REPORTS_OPEN_ROUTE_PATH,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'method not allowed' }))
            return
          }
          // Refresh the .md from the latest store state, then reveal it in
          // the OS file manager (Explorer / Finder).
          reportStore.writeMarkdown(reportMdPath, {
            title: 'HeartBeat Report',
            status: engine ? engine.status() : { status: 'disabled' },
            reportEnabled: readReportConfig().enabled,
          })
          const opened = openInFileManager(reportMdPath)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: opened, path: reportMdPath }))
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    })

    webCtx.effect(() => () => {
      disposeConfig()
      disposeReports()
      disposeModels()
      disposeOpen()
    }, 'heartbeat.routes()')
  })

  // ----- lifecycle: mode A runtimes + mode B engine -----
  return ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (readReportConfig().enabled) return // the engine owns everything in report mode
      attachRuntime(agent)
    })
    applyMode()
    return async () => {
      stopping = true
      stopCreated()
      detachRuntimes()
      stopEngine()
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

export { HeartbeatRuntime, buildHeartbeatMessage, clampIntervalSeconds, HeartbeatConfigStore, DEFAULT_PROMPT }
export { HeartbeatEngine }
export { HeartbeatReportStore, REPORT_FILENAME }
export { annotateModels, priceFor, costPerCall }
