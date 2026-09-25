/**
 * dsh-plugin-heartbeat unit tests.
 *
 * Run with `node --test test/`.
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, name, inject, CONFIG_ROUTE_PATH } from '../lib/index.js'
import { SettingsSchema } from '../lib/schema.js'
import { HeartbeatRuntime, buildHeartbeatMessage, clampIntervalSeconds, buildSchedule } from '../lib/runtime.js'
import { renderPrompt, DEFAULT_PROMPT } from '../lib/prompt.js'

// ── fakes ──────────────────────────────────────────────────────────────────

class FakeInbox {
  constructor() {
    this.state = { 'next-turn': [], 'next-step': [] }
  }
  locate(id) {
    for (const target of ['next-turn', 'next-step']) {
      const index = this.state[target].findIndex((message) => message.id === id)
      if (index >= 0) return { target, index }
    }
    return undefined
  }
  replace(id, message) {
    const location = this.locate(id)
    if (location === undefined) return false
    this.state[location.target][location.index] = message
    return true
  }
  claim(target) {
    return this.state[target].splice(0, this.state[target].length)
  }
}

class FakeAgent {
  constructor(id = 'test-agent') {
    this.id = id
    this.status = 'idle'
    this.inbox = new FakeInbox()
    this.followed = []
    this._cleanups = []
    this._listeners = new Map()
    this.ctx = {
      effect: (callback) => {
        const raw = callback()
        const cleanup = () => {
          raw?.()
          this._cleanups = this._cleanups.filter((entry) => entry !== cleanup)
        }
        this._cleanups.push(cleanup)
        return cleanup
      },
      on: (event, callback) => {
        const key = Symbol()
        this._listeners.set(key, { event, callback })
        return () => this._listeners.delete(key)
      },
    }
  }
  followup(message) {
    this.followed.push(message)
    this.inbox.state['next-turn'].push(message)
    this.status = 'running'
  }
  /** Fire a synthetic agent/inbox/inserted payload into the agent listeners. */
  emitInserted(message) {
    for (const { event, callback } of [...this._listeners.values()]) {
      if (event === 'agent/inbox/inserted') callback({ message })
    }
  }
  disposeCtx() {
    for (const cleanup of this._cleanups.splice(0)) cleanup?.()
  }
}

const agentRegistry = () => {
  const live = new Map()
  return {
    live,
    roots: () => [...live.values()],
    get: (id) => live.get(id),
    add: (agent) => live.set(agent.id, agent),
    remove: (id) => live.delete(id),
  }
}

// ── schema / helpers ───────────────────────────────────────────────────────

test('plugin metadata survives the loader unwrap', () => {
  assert.equal(apply.name, name)
  assert.deepEqual(apply.inject, inject)
  assert.equal(typeof apply.Config, 'function')
})

test('Config schema applies defaults and bounds', () => {
  const resolved = Config({})
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.intervalSeconds, 600)
  assert.equal(resolved.prompt, DEFAULT_PROMPT)
  assert.equal(resolved.pauseAfterMissed, 3)
  assert.equal(resolved.compactBeforeBeat, true)
  assert.equal(resolved.maxBeatsPerHour, 0)
  assert.equal(resolved.backoffSeconds, undefined)
  assert.throws(() => Config({ intervalSeconds: 5 }))
  assert.throws(() => Config({ intervalSeconds: 90000 }))
})

test('buildSchedule: derived tiers from intervalSeconds × pauseAfterMissed', () => {
  assert.deepEqual(buildSchedule({ intervalSeconds: 600, pauseAfterMissed: 3 }), [600, 1200, 1800])
  assert.deepEqual(buildSchedule({ intervalSeconds: 600, pauseAfterMissed: 0 }), [600])
})

test('buildSchedule: explicit backoffSeconds wins and is made monotonic', () => {
  assert.deepEqual(
    buildSchedule({ intervalSeconds: 600, backoffSeconds: [600, 900, 1800] }),
    [600, 900, 1800],
  )
  assert.deepEqual(
    buildSchedule({ intervalSeconds: 600, backoffSeconds: [900, 600, 1200] }),
    [900, 900, 1200],
  )
})

test('SettingsSchema shares the bounds', () => {
  assert.equal(SettingsSchema({}).intervalSeconds, 600)
  assert.throws(() => SettingsSchema({ intervalSeconds: 0 }))
})

test('clampIntervalSeconds enforces 30–86400', () => {
  assert.equal(clampIntervalSeconds(undefined, 600), 600)
  assert.equal(clampIntervalSeconds(5, 600), 30)
  assert.equal(clampIntervalSeconds(999999, 600), 86400)
  assert.equal(clampIntervalSeconds(120.9, 600), 120)
  assert.equal(clampIntervalSeconds('90', 600), 90)
})

test('renderPrompt substitutes {{time}}', () => {
  const text = renderPrompt('now: {{time}}', new Date('2026-08-18T12:00:00'))
  assert.equal(text, 'now: 2026/8/18 12:00:00')
})

test('buildHeartbeatMessage has the harness shape', () => {
  const message = buildHeartbeatMessage('hi')
  assert.equal(message.role, 'user')
  // Session format v4 refuses the retired `plugin` wrapper: third-party
  // producers must use a producer-owned kind (`plugin:<name>`).
  assert.equal(message.source.kind, 'plugin:heartbeat')
  assert.deepEqual(message.content, [{ type: 'text', text: 'hi' }])
  assert.match(message.id, /^hb-/)
})

// ── runtime: delivery semantics ────────────────────────────────────────────

const config = (overrides = {}) => ({
  enabled: true,
  intervalSeconds: 600,
  prompt: 'beat {{time}}',
  pauseAfterMissed: 3,
  ...overrides,
})

test('idle tick opens a turn via followup', () => {
  const agent = new FakeAgent()
  const runtime = new HeartbeatRuntime(agent, { readConfig: () => config() })
  runtime.tick()
  assert.equal(agent.followed.length, 1)
  const message = agent.followed[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'plugin:heartbeat')
  assert.match(message.content[0].text, /beat /)
})

test('busy ticks coalesce: replace, never pile up', () => {
  const agent = new FakeAgent()
  const runtime = new HeartbeatRuntime(agent, { readConfig: () => config() })
  runtime.tick() // queued; agent busy
  runtime.tick() // still pending → replace
  runtime.tick()
  assert.equal(agent.followed.length, 1)
  assert.equal(agent.inbox.state['next-turn'].length, 1)
  assert.equal(agent.inbox.state['next-turn'][0].id, runtime.pendingId)
})

test('once claimed, the next tick sends a fresh heartbeat', () => {
  const agent = new FakeAgent()
  const runtime = new HeartbeatRuntime(agent, { readConfig: () => config() })
  runtime.tick()
  agent.inbox.claim('next-turn') // the loop consumed it
  runtime.tick()
  assert.equal(agent.followed.length, 2)
  assert.notEqual(agent.followed[0].id, agent.followed[1].id)
})

test('disabled config stays silent', () => {
  const agent = new FakeAgent()
  const runtime = new HeartbeatRuntime(agent, { readConfig: () => config({ enabled: false }) })
  runtime.tick()
  assert.equal(agent.followed.length, 0)
})

// ── unattended guard ────────────────────────────────────────────────────────

test('pauses after pauseAfterMissed unanswered beats', () => {
  const agent = new FakeAgent()
  const runtime = new HeartbeatRuntime(agent, { readConfig: () => config({ pauseAfterMissed: 3 }) })
  runtime.tick()
  agent.inbox.claim('next-turn')
  runtime.tick()
  agent.inbox.claim('next-turn')
  runtime.tick() // third beat delivered, still no reply
  assert.equal(agent.followed.length, 3)
  agent.inbox.claim('next-turn')
  runtime.tick() // fourth tick: guard trips, stays silent
  assert.equal(agent.followed.length, 3)
  assert.equal(runtime.paused, true)
  runtime.tick()
  assert.equal(agent.followed.length, 3)
})

test('a real user message resumes a paused runtime', () => {
  const agent = new FakeAgent()
  const runtime = new HeartbeatRuntime(agent, { readConfig: () => config({ pauseAfterMissed: 2 }) })
  runtime.start()
  runtime.tick()
  agent.inbox.claim('next-turn')
  runtime.tick() // missedCount = 2
  agent.inbox.claim('next-turn')
  runtime.tick() // paused
  assert.equal(agent.followed.length, 2)
  assert.equal(runtime.paused, true)
  agent.emitInserted({ id: 'user-1', source: { kind: 'user' } })
  assert.equal(runtime.paused, false)
  assert.equal(runtime.missedCount, 0)
  runtime.tick()
  assert.equal(agent.followed.length, 3)
  runtime.dispose()
})

test('non-user inbox messages do not reset the guard', () => {
  const agent = new FakeAgent()
  const runtime = new HeartbeatRuntime(agent, { readConfig: () => config({ pauseAfterMissed: 2 }) })
  runtime.start()
  runtime.tick()
  agent.inbox.claim('next-turn')
  runtime.tick()
  agent.inbox.claim('next-turn')
  agent.emitInserted({ id: 'hb-1', source: { kind: 'plugin:heartbeat' } })
  runtime.tick() // still trips despite the plugin message
  assert.equal(runtime.paused, true)
  assert.equal(agent.followed.length, 2)
  runtime.dispose()
})

test('a user message before the threshold resets the counter', () => {
  const agent = new FakeAgent()
  const runtime = new HeartbeatRuntime(agent, { readConfig: () => config({ pauseAfterMissed: 3 }) })
  runtime.start()
  for (let i = 0; i < 5; i += 1) {
    runtime.tick()
    agent.inbox.claim('next-turn')
    if (i % 2 === 1) agent.emitInserted({ id: `user-${i}`, source: { kind: 'user' } })
  }
  assert.equal(runtime.paused, false)
  assert.equal(agent.followed.length, 5)
  runtime.dispose()
})

test('pauseAfterMissed: 0 disables the guard entirely', () => {
  const agent = new FakeAgent()
  const runtime = new HeartbeatRuntime(agent, { readConfig: () => config({ pauseAfterMissed: 0 }) })
  for (let i = 0; i < 8; i += 1) {
    runtime.tick()
    agent.inbox.claim('next-turn')
  }
  assert.equal(runtime.paused, false)
  assert.equal(agent.followed.length, 8)
})

test('tick re-reads config every time (hot reload)', () => {
  const agent = new FakeAgent()
  const state = { enabled: true }
  const runtime = new HeartbeatRuntime(agent, { readConfig: () => config(state) })
  runtime.tick()
  state.enabled = false
  runtime.tick()
  assert.equal(agent.followed.length, 1)
})

test('dead agent stops the runtime', () => {
  const registry = agentRegistry()
  const agent = new FakeAgent()
  registry.add(agent)
  const runtime = new HeartbeatRuntime(agent, {
    readConfig: () => config(),
    agents: registry,
  })
  registry.remove(agent.id)
  runtime.tick()
  assert.equal(agent.followed.length, 0)
  assert.equal(runtime.disposed, true)
})

test('timer chain re-arms with backoff from the latest config', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agent = new FakeAgent()
  const state = { enabled: true, intervalSeconds: 600 }
  const runtime = new HeartbeatRuntime(agent, { readConfig: () => config(state) })
  runtime.start() // t=0, armed for 600s (tier 0)
  state.intervalSeconds = 1200 // change before the first fire
  t.mock.timers.tick(600_000) // t=600: fire #1, re-arm tier 1 = 2×1200s
  assert.equal(agent.followed.length, 1)
  agent.inbox.claim('next-turn')
  t.mock.timers.tick(600_000) // t=1200: silent (inside the 2400s tier)
  assert.equal(agent.followed.length, 1)
  t.mock.timers.tick(1800_000) // t=3000: fire #2
  assert.equal(agent.followed.length, 2)
  runtime.dispose()
  t.mock.timers.tick(24 * 3600_000)
  assert.equal(agent.followed.length, 2)
})

test('reschedule re-arms immediately from the latest config', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agent = new FakeAgent()
  const state = { enabled: true, intervalSeconds: 600 }
  const runtime = new HeartbeatRuntime(agent, { readConfig: () => config(state) })
  runtime.start() // fire at t=600s
  t.mock.timers.tick(100_000) // t=100s
  state.intervalSeconds = 120
  runtime.reschedule() // next fire moves to t=220s
  t.mock.timers.tick(120_000)
  assert.equal(agent.followed.length, 1)
  runtime.dispose()
})

test('dispose cancels the armed timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agent = new FakeAgent()
  const runtime = new HeartbeatRuntime(agent, { readConfig: () => config() })
  runtime.start()
  runtime.dispose()
  t.mock.timers.tick(10 * 3600_000)
  assert.equal(agent.followed.length, 0)
})

// ── plugin wiring ──────────────────────────────────────────────────────────

test('apply attaches a runtime to each root agent and cleans up', async () => {
  const listeners = new Map()
  const effects = []
  const registry = agentRegistry()
  const logger = { info: () => {}, warn: () => {} }
  const ctx = {
    logger,
    agents: registry,
    on: (event, callback) => {
      const key = Symbol()
      listeners.set(key, { event, callback })
      return () => listeners.delete(key)
    },
    effect: (callback) => {
      const cleanup = callback()
      effects.push(cleanup)
      return cleanup
    },
    inject: () => {},
  }
  const dispose = apply(ctx, { intervalSeconds: 600, configFile: join(tmpdir(), `hb-iso-${Date.now()}.json`) })

  const agent = new FakeAgent('root-1')
  registry.add(agent)
  for (const { event, callback } of [...listeners.values()]) {
    if (event !== 'agent/created') continue
    callback({ agent })
  }
  // runtime attached through the agent ctx effect
  assert.equal(agent._cleanups.length, 1)

  // a subagent (not a root) must be ignored — simulated by adding a second
  // agent but marking roots to exclude it:
  const sub = new FakeAgent('sub-1')
  registry.add(sub)
  registry.roots = () => [agent]
  for (const { event, callback } of [...listeners.values()]) {
    if (event !== 'agent/created') continue
    callback({ agent: sub })
  }
  assert.equal(sub._cleanups.length, 0)

  const undone = await dispose()
  assert.equal(undone, undefined)
  assert.equal(agent._cleanups.length, 0)
  assert.equal(listeners.size, 0)
})

test('apply registers the config route on the web server', () => {
  const routes = new Map()
  const injected = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    agents: agentRegistry(),
    on: () => () => {},
    effect: () => () => {},
    inject: (deps, callback) => injected.push({ deps, callback }),
  }
  const dispose = apply(ctx, { intervalSeconds: 900, configFile: join(tmpdir(), `hb-iso-route-${Date.now()}.json`) })
  const web = injected.find(({ deps }) => deps[0] === 'webServer')
  assert.ok(web, 'webServer injection registered')
  const { deps, callback } = web
  assert.deepEqual(deps, ['webServer'])
  const injectedCtx = {
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    effect: () => () => {},
  }
  callback(injectedCtx)
  assert.equal(routes.has(CONFIG_ROUTE_PATH), true)
  const route = routes.get(CONFIG_ROUTE_PATH)
  assert.equal(route.kind, 'exact')
  dispose()
})

test('config route: GET serves the store, POST updates it, bad input rejects', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const file = path.join(os.tmpdir(), `hb-test-${Date.now()}.json`)
  const { HeartbeatConfigStore } = await import('../lib/store.js')
  const store = new HeartbeatConfigStore({ path: file, base: { intervalSeconds: 900 } })
  const route = {
    kind: 'exact',
    path: CONFIG_ROUTE_PATH,
    handler: async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString('utf8')
      try {
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(store.get()))
          return
        }
        if (req.method === 'POST') {
          const patch = JSON.parse(body)
          const next = store.update(patch)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(next))
          return
        }
        res.writeHead(405)
        res.end()
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
      }
    },
  }
  const collect = (response) => new Promise((resolve) => {
    const chunks = []
    response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
  })
  const get = async () => {
    const response = new EventEmitter()
    response.writeHead = function (code) { this.statusCode = code }
    response.end = function (data) { this.emit('data', data); this.emit('end') }
    const done = collect(response)
    await route.handler({ method: 'GET', [Symbol.asyncIterator]: async function* () {} }, response)
    return done
  }
  const post = async (body) => {
    const response = new EventEmitter()
    response.writeHead = function (code) { this.statusCode = code }
    response.end = function (data) { this.emit('data', data); this.emit('end') }
    const done = collect(response)
    await route.handler({ method: 'POST', body, [Symbol.asyncIterator]: async function* () { yield Buffer.from(body) } }, response)
    return done
  }
  const EventEmitter = (await import('node:events')).EventEmitter

  const initial = await get()
  assert.equal(initial.status, 200)
  assert.deepEqual(JSON.parse(initial.body), { enabled: true, intervalSeconds: 900, pauseAfterMissed: 3, report: { enabled: false, retention: 200 } })

  const updated = await post(JSON.stringify({ intervalSeconds: 120 }))
  assert.equal(updated.status, 200)
  assert.deepEqual(JSON.parse(updated.body), { enabled: true, intervalSeconds: 120, pauseAfterMissed: 3, report: { enabled: false, retention: 200 } })

  const bad = await post(JSON.stringify({ intervalSeconds: 1 }))
  assert.equal(bad.status, 400)
  assert.match(JSON.parse(bad.body).error, /expected number/)

  fs.rmSync(file, { force: true })
})

// store 单测：文件层 + 校验 + watch
test('HeartbeatConfigStore persists and validates', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const file = path.join(os.tmpdir(), `hb-store-${Date.now()}.json`)
  const { HeartbeatConfigStore } = await import('../lib/store.js')

  const store = new HeartbeatConfigStore({ path: file, base: { intervalSeconds: 600 } })
  assert.equal(store.get().intervalSeconds, 600)
  store.update({ intervalSeconds: 180 })
  assert.equal(store.get().intervalSeconds, 180)
  assert.equal(fs.existsSync(file), true)
  assert.throws(() => store.update({ intervalSeconds: 1 }))

  // 重新加载：文件层生效
  const reloaded = new HeartbeatConfigStore({ path: file, base: { intervalSeconds: 600 } })
  assert.equal(reloaded.get().intervalSeconds, 180)

  const seen = []
  const unwatch = reloaded.watch((config) => seen.push(config.intervalSeconds))
  reloaded.update({ enabled: false })
  assert.deepEqual(seen, [180])
  unwatch()
  fs.rmSync(file, { force: true })
})

// ── v0.4.0: backoff, hard stop, lightweight wake-ups ────────────────────────

test('backoff chain: 10min → 20min → 30min, then hard stop with no further beats', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agent = new FakeAgent()
  const runtime = new HeartbeatRuntime(agent, { readConfig: () => config() }) // 600s, pauseAfterMissed 3
  runtime.start() // t=0: tier 0 = 600s
  t.mock.timers.tick(600_000) // t=600: beat #1, missed=1, re-arm tier 1 = 1200s
  assert.equal(agent.followed.length, 1)
  agent.inbox.claim('next-turn')
  t.mock.timers.tick(1200_000) // t=1800: beat #2, missed=2, re-arm tier 2 = 1800s
  assert.equal(agent.followed.length, 2)
  agent.inbox.claim('next-turn')
  t.mock.timers.tick(1800_000) // t=3600: beat #3, missed=3
  assert.equal(agent.followed.length, 3)
  agent.inbox.claim('next-turn')
  t.mock.timers.tick(1800_000) // t=5400: hard stop — no beat, timer dropped
  assert.equal(agent.followed.length, 3)
  assert.equal(runtime.paused, true)
  assert.equal(runtime.timer, undefined)
  t.mock.timers.tick(10 * 3600_000) // stays stopped without a user message
  assert.equal(agent.followed.length, 3)
  runtime.dispose()
})

test('hard stop drops the timer (token guard) even at pauseAfterMissed: 1', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agent = new FakeAgent()
  const runtime = new HeartbeatRuntime(agent, { readConfig: () => config({ pauseAfterMissed: 1 }) })
  runtime.start()
  t.mock.timers.tick(600_000) // beat #1, missed=1
  assert.equal(agent.followed.length, 1)
  agent.inbox.claim('next-turn')
  t.mock.timers.tick(600_000) // gate trips: pause, timer cleared
  assert.equal(agent.followed.length, 1)
  assert.equal(runtime.paused, true)
  assert.equal(runtime.timer, undefined)
  t.mock.timers.tick(3600_000)
  assert.equal(agent.followed.length, 1)
  runtime.dispose()
})

test('a user message mid-backoff resets to tier 0 and re-arms from that moment', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agent = new FakeAgent()
  const runtime = new HeartbeatRuntime(agent, { readConfig: () => config() })
  runtime.start() // t=0: beat at t=600
  t.mock.timers.tick(600_000) // beat #1, missed=1 → next at t=1800
  assert.equal(agent.followed.length, 1)
  agent.inbox.claim('next-turn')
  t.mock.timers.tick(300_000) // t=900
  agent.emitInserted({ id: 'user-1', source: { kind: 'user' } }) // full reset
  assert.equal(runtime.missedCount, 0)
  t.mock.timers.tick(600_000) // t=1500: beat #2 (600s after the user message)
  assert.equal(agent.followed.length, 2)
  runtime.dispose()
})

test('hourly cap skips beats beyond the budget without pausing', () => {
  const agent = new FakeAgent()
  const runtime = new HeartbeatRuntime(agent, {
    readConfig: () => config({ maxBeatsPerHour: 2, pauseAfterMissed: 0 }),
  })
  runtime.tick()
  agent.inbox.claim('next-turn')
  runtime.tick()
  agent.inbox.claim('next-turn')
  runtime.tick() // third beat within the window: skipped, not counted
  assert.equal(agent.followed.length, 2)
  assert.equal(runtime.paused, false)
  assert.equal(runtime.beatTimes.length, 2)
})

test('pre-beat compaction runs for an idle agent when available', async () => {
  const agent = new FakeAgent()
  const calls = []
  const compaction = { compactNow: async () => { calls.push('compact'); return { ok: true } } }
  const runtime = new HeartbeatRuntime(agent, {
    readConfig: () => config(),
    getCompaction: () => compaction,
  })
  await runtime.tick()
  assert.deepEqual(calls, ['compact'])
  assert.equal(agent.followed.length, 1)
})

test('pre-beat compaction is skipped when disabled', async () => {
  const agent = new FakeAgent()
  const calls = []
  const compaction = { compactNow: async () => { calls.push('compact'); return {} } }
  const runtime = new HeartbeatRuntime(agent, {
    readConfig: () => config({ compactBeforeBeat: false }),
    getCompaction: () => compaction,
  })
  await runtime.tick()
  assert.equal(calls.length, 0)
  assert.equal(agent.followed.length, 1)
})

test('pre-beat compaction failure never blocks the beat', async () => {
  const agent = new FakeAgent()
  const compaction = { compactNow: async () => { throw new Error('boom') } }
  const runtime = new HeartbeatRuntime(agent, {
    readConfig: () => config(),
    getCompaction: () => compaction,
    logger: { info: () => {}, warn: () => {} },
  })
  await runtime.tick()
  assert.equal(agent.followed.length, 1)
})
