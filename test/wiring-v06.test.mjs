/**
 * v0.6 plugin wiring: attach/catch-up, config v2 routes, status, control,
 * projection-driven wake-ups, disposal (hot-plug contract).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, CONFIG_ROUTE_PATH, STATUS_ROUTE_PATH, CONTROL_ROUTE_PATH } from '../lib/index.js'

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
}

class FakeAgent {
  constructor(id) {
    this.id = id
    this.status = 'idle'
    this.session = { id: `session-${id}`, header: { cwd: '/w' } }
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
  }
  disposeCtx() {
    for (const cleanup of this._cleanups.splice(0)) cleanup?.()
  }
}

const registry = () => {
  const live = new Map()
  return {
    live,
    roots: () => [...live.values()],
    get: (id) => live.get(id),
    add: (agent) => live.set(agent.id, agent),
    remove: (id) => live.delete(id),
  }
}

const makeWebServer = () => {
  const routes = new Map()
  return {
    routes,
    register: (route) => {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
}

function makeCtx({ agents, services = {} } = {}) {
  const listeners = new Map()
  const effects = []
  const injected = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    agents,
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
    inject: (deps, callback) => {
      injected.push(deps[0])
      const name = deps[0]
      const service = services[name]
      if (service === undefined) return
      callback({
        [name]: service,
        effect: (inner) => {
          const cleanup = inner()
          effects.push(cleanup)
          return cleanup
        },
      })
    },
  }
  return { ctx, listeners, effects, injected }
}

const tmpFiles = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-wiring-'))
  return { configFile: join(dir, 'heartbeat.json'), vitalsFile: join(dir, 'heartbeat-vitals.json') }
}

async function callRoute(handler, { method = 'GET', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  let status = 0
  let payload = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(data) {
      payload = data ?? ''
    },
  }
  const req = {
    method,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  await handler(req, res)
  return { status, body: payload.length > 0 ? JSON.parse(payload) : undefined }
}

const fireCreated = (listeners, agent) => {
  for (const { event, callback } of [...listeners.values()]) {
    if (event === 'agent/created') callback({ agent })
  }
}

// ── tests ──────────────────────────────────────────────────────────────────

test('apply catches up with root agents that already exist (hot mount)', async () => {
  const agents = registry()
  const live = new FakeAgent('live-before-mount')
  agents.add(live)
  const { ctx } = makeCtx({ agents, services: { webServer: makeWebServer() } })
  const dispose = apply(ctx, { ...tmpFiles(), baseIntervalSeconds: 600, jitterSeconds: 0 })
  assert.equal(live._cleanups.length, 1, 'existing root agent got a runtime')
  await dispose()
  assert.equal(live._cleanups.length, 0)
})

test('apply never attaches to a subagent conversation', async () => {
  const agents = registry()
  const child = new FakeAgent('child-session')
  agents.add(child)
  const sessionProjections = {
    stateOf: (_session, key) => (key === 'subagent' ? { mode: 'continuable', label: 'worker', seq: 1 } : undefined),
  }
  const { ctx, listeners } = makeCtx({ agents, services: { webServer: makeWebServer(), sessionProjections } })
  const dispose = apply(ctx, { ...tmpFiles(), jitterSeconds: 0 })
  assert.equal(child._cleanups.length, 0, 'subagent session skipped at hot mount')
  fireCreated(listeners, child)
  assert.equal(child._cleanups.length, 0, 'subagent session skipped on agent/created')
  await dispose()
})

test('apply ignores non-root agents and attaches on agent/created', async () => {
  const agents = registry()
  const root = new FakeAgent('root')
  const sub = new FakeAgent('sub')
  agents.add(root)
  agents.add(sub)
  agents.roots = () => [root]
  const { ctx, listeners } = makeCtx({ agents, services: { webServer: makeWebServer() } })
  const dispose = apply(ctx, { ...tmpFiles(), jitterSeconds: 0 })
  assert.equal(root._cleanups.length, 1)
  assert.equal(sub._cleanups.length, 0)
  const late = new FakeAgent('late')
  agents.add(late)
  agents.roots = () => [root, late]
  fireCreated(listeners, late)
  assert.equal(late._cleanups.length, 1)
  await dispose()
})

test('config route serves v2 and accepts patches', async () => {
  const agents = registry()
  agents.add(new FakeAgent('a'))
  const web = makeWebServer()
  const { ctx } = makeCtx({ agents, services: { webServer: web } })
  const dispose = apply(ctx, { ...tmpFiles(), jitterSeconds: 0 })
  const handler = web.routes.get(CONFIG_ROUTE_PATH)
  const initial = await callRoute(handler)
  assert.equal(initial.status, 200)
  assert.equal(initial.body.version, 2)
  assert.equal(initial.body.mode, 'assist')
  const updated = await callRoute(handler, { method: 'POST', body: { mode: 'silent', maxBeatsPerDay: 3 } })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.mode, 'silent')
  assert.equal(updated.body.maxBeatsPerDay, 3)
  const bad = await callRoute(handler, { method: 'POST', body: { mode: 'autopilot' } })
  assert.equal(bad.status, 400)
  await dispose()
})

test('status route reports sessions, next ETA and budget', async () => {
  const agents = registry()
  agents.add(new FakeAgent('a'))
  const web = makeWebServer()
  const { ctx } = makeCtx({ agents, services: { webServer: web } })
  const dispose = apply(ctx, { ...tmpFiles(), jitterSeconds: 0 })
  const handler = web.routes.get(STATUS_ROUTE_PATH)
  const status = await callRoute(handler)
  assert.equal(status.status, 200)
  assert.equal(status.body.sessions.length, 1)
  const session = status.body.sessions[0]
  assert.equal(session.sessionId, 'session-a')
  assert.ok(session.nextBeatAt > 0)
  assert.equal(session.budget.max, 12)
  assert.deepEqual(session.history, [])
  await dispose()
})

test('control route supports beat-now, snooze and rejects unknown actions', async () => {
  const agents = registry()
  const agent = new FakeAgent('a')
  agents.add(agent)
  const web = makeWebServer()
  const { ctx } = makeCtx({ agents, services: { webServer: web } })
  const dispose = apply(ctx, { ...tmpFiles(), jitterSeconds: 0, taskNudge: false })
  const control = web.routes.get(CONTROL_ROUTE_PATH)
  const beat = await callRoute(control, { method: 'POST', body: { action: 'beat-now' } })
  assert.equal(beat.status, 200)
  assert.equal(agent.followed.length, 1)
  const snooze = await callRoute(control, { method: 'POST', body: { action: 'snooze', minutes: 30 } })
  assert.equal(snooze.status, 200)
  assert.ok(snooze.body.sessions[0].snoozeUntil > Date.now())
  const unknown = await callRoute(control, { method: 'POST', body: { action: 'explode' } })
  assert.equal(unknown.status, 400)
  const missing = await callRoute(control, { method: 'POST', body: { action: 'beat-now', sessionId: 'nope' } })
  assert.equal(missing.status, 404)
  await dispose()
})

test('projection changes wake a runtime through noteSignal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agents = registry()
  const agent = new FakeAgent('a')
  agents.add(agent)
  const listeners = []
  const sessionProjections = {
    stateOf: (_session, key) => (key === 'agentTeam'
      ? { tasks: [{ id: 'task-1', subject: 'ready', status: 'pending', blockedBy: [] }] }
      : undefined),
    onChanged: (callback) => {
      listeners.push(callback)
      return () => {}
    },
  }
  const web = makeWebServer()
  const { ctx } = makeCtx({ agents, services: { webServer: web, sessionProjections } })
  const dispose = apply(ctx, { ...tmpFiles(), jitterSeconds: 0, taskNudge: false, baseIntervalSeconds: 3600 })
  assert.equal(listeners.length, 1)
  listeners[0](agent.session, 'agentTeam')
  t.mock.timers.tick(2_000)
  assert.equal(agent.followed.length, 1, 'projection change produced a pulse')
  await dispose()
})

test('applies without optional services and disposes cleanly', async () => {
  const agents = registry()
  agents.add(new FakeAgent('a'))
  const { ctx } = makeCtx({ agents })
  const dispose = apply(ctx, { ...tmpFiles(), jitterSeconds: 0 })
  await dispose()
})
