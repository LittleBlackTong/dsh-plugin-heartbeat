/**
 * v0.6 runtime pipeline tests: silent pulses, signal activation, dedupe,
 * backoff/hard-stop, compaction, restart cooldown, quiet hours, disposal.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HeartbeatRuntime, clampIntervalSeconds, buildHeartbeatMessage as buildMessage } from '../lib/runtime.js'
import { decide } from '../lib/gate.js'

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
    this.status = 'running'
  }
  emitInserted(message) {
    for (const { event, callback } of [...this._listeners.values()]) {
      if (event === 'agent/inbox/inserted') callback({ message })
    }
  }
  disposeCtx() {
    for (const cleanup of this._cleanups.splice(0)) cleanup?.()
  }
}

class FakeVitals {
  constructor() {
    this.sessions = new Map()
    this.global = { budget: { day: '2026-10-30', beats: 0 } }
    this.budgetRemaining = Infinity
    this.restartCoolingDown = false
  }
  ensure(id) {
    if (!this.sessions.has(id)) {
      this.sessions.set(id, { lastPulseAt: 0, lastDeliveredAt: 0, missedCount: 0, paused: false, pausedReason: null, snoozeUntil: 0, seen: {}, asked: {}, history: [] })
    }
    return this.sessions.get(id)
  }
  get(id) {
    return this.ensure(id)
  }
  recordPulse(id, { level, reason, delivered }) {
    const session = this.ensure(id)
    session.lastPulseAt = 1
    if (delivered) session.lastDeliveredAt = 1
    session.history.push({ level, reason, delivered })
    this.lastPulse = { level, reason, delivered }
  }
  setSeen(id, seen) {
    Object.assign(this.ensure(id).seen, seen)
  }
  markDelivered(id, keys) {
    for (const key of keys) this.ensure(id).asked[key] = { lastAt: 1, count: 1 }
  }
  bumpBudget() {
    return { beats: ++this.global.budget.beats }
  }
  budgetLeft() {
    return this.budgetRemaining
  }
  setPaused(id, paused, reason) {
    const session = this.ensure(id)
    session.paused = paused
    session.pausedReason = paused ? reason : null
  }
  snooze(id, until) {
    this.ensure(id).snoozeUntil = until
  }
  restartCooldownActive() {
    return this.restartCoolingDown
  }
}

const baseConfig = (overrides = {}) => ({
  enabled: true,
  mode: 'assist',
  baseIntervalSeconds: 600,
  pauseAfterMissed: 3,
  quietHours: null,
  dedupeWindowMinutes: 90,
  maxBeatsPerDay: 12,
  maxBeatsPerHour: 0,
  refractorySeconds: 0,
  jitterSeconds: 0,
  compactBeforeBeat: false,
  taskNudge: false,
  l3Allow: [],
  ...overrides,
})

const signal = (key = 'team:task-3:ready', kind = 'team-ready') => ({ key, kind, weight: 5, text: '团队任务 task-3 可开始了' })

const makeRuntime = (agent, {
  config = baseConfig(),
  signals = [],
  gated = { level: 'L1', reason: 'test signal', keys: [] },
  vitals = new FakeVitals(),
  now = () => 1_000_000,
  extra = {},
} = {}) => ({
  vitals,
  runtime: new HeartbeatRuntime(agent, {
    readConfig: () => config,
    getVitals: () => vitals,
    now,
    collectSignals: () => ({ signals, arousal: signals.reduce((sum, item) => sum + (item.weight ?? 0), 0), seen: { todos: 'sig' }, pressure: undefined }),
    decide: () => gated,
    logger: { info: () => {}, warn: () => {} },
    ...extra,
  }),
})

// ── message shape / helpers ────────────────────────────────────────────────

test('buildHeartbeatMessage keeps the session-v4 producer shape', () => {
  const message = buildMessage('hi')
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, { kind: 'plugin:heartbeat' })
  assert.deepEqual(message.content, [{ type: 'text', text: 'hi' }])
  assert.match(message.id, /^hb-/)
})

test('clampIntervalSeconds enforces 30–86400', () => {
  assert.equal(clampIntervalSeconds(undefined, 600), 600)
  assert.equal(clampIntervalSeconds(5, 600), 30)
  assert.equal(clampIntervalSeconds(999999, 600), 86400)
})

// ── silent pulses ──────────────────────────────────────────────────────────

test('no signals: pulse is silent (no followup, L0 recorded)', () => {
  const agent = new FakeAgent()
  const { runtime, vitals } = makeRuntime(agent, { gated: { level: 'L0', reason: '没有新信号', keys: [] } })
  runtime.tick()
  assert.equal(agent.followed.length, 0)
  assert.equal(vitals.lastPulse.level, 'L0')
  assert.equal(vitals.lastPulse.delivered, false)
})

test('signal activates the agent with a why-now message', () => {
  const agent = new FakeAgent()
  const { runtime, vitals } = makeRuntime(agent, {
    signals: [signal()],
    gated: { level: 'L2', reason: '团队任务 task-3 可开始了', keys: ['team:task-3:ready'] },
  })
  runtime.tick()
  assert.equal(agent.followed.length, 1)
  const text = agent.followed[0].content[0].text
  assert.match(text, /为什么现在叫你：团队任务 task-3 可开始了/)
  assert.match(text, /ask_user_question/)
  assert.equal(vitals.lastPulse.level, 'L2')
  assert.equal(vitals.get(agent.session.id).asked['team:task-3:ready'].count, 1)
  assert.equal(vitals.global.budget.beats, 1)
})

test('disabled config stays silent', () => {
  const agent = new FakeAgent()
  const { runtime } = makeRuntime(agent, { config: baseConfig({ enabled: false }), signals: [signal()] })
  runtime.tick()
  assert.equal(agent.followed.length, 0)
})

test('dedupe: the same signal window is suppressed on the next tick', () => {
  const agent = new FakeAgent()
  const vitals = new FakeVitals()
  const config = baseConfig()
  const runtime = new HeartbeatRuntime(agent, {
    readConfig: () => config,
    getVitals: () => vitals,
    now: () => 1_000_000,
    collectSignals: () => ({ signals: [signal()], arousal: 5, seen: {} }),
    // real gate imported lazily below
    logger: { info: () => {}, warn: () => {} },
  })
  runtime.decide = (options) => decide(options)
  runtime.tick()
  assert.equal(agent.followed.length, 1)
  agent.inbox.claim('next-turn')
  runtime.tick()
  assert.equal(agent.followed.length, 1, 'second identical signal is deduped')
  assert.equal(vitals.get(agent.session.id).history.at(-1).reason, '同一事项在去重窗口内已提醒过')
})

test('a suppressed pulse does not consume the change set', () => {
  const agent = new FakeAgent()
  const vitals = new FakeVitals()
  vitals.budgetRemaining = 0
  let seenWrites = 0
  const recordSeen = vitals.setSeen.bind(vitals)
  vitals.setSeen = (...args) => {
    seenWrites += 1
    return recordSeen(...args)
  }
  const runtime = new HeartbeatRuntime(agent, {
    readConfig: () => baseConfig(),
    getVitals: () => vitals,
    now: () => 1_000_000,
    collectSignals: () => ({ signals: [signal()], arousal: 5, seen: { todos: 'v1' } }),
    logger: { info: () => {}, warn: () => {} },
  })
  runtime.tick() // budget exhausted: silent, change stays pending
  assert.equal(agent.followed.length, 0)
  assert.equal(seenWrites, 0, 'suppressed pulses must not mark the change as seen')
  vitals.budgetRemaining = 5
  runtime.tick() // budget available: the same change is delivered
  assert.equal(agent.followed.length, 1)
  assert.equal(seenWrites, 1)
})

// ── inbox semantics ────────────────────────────────────────────────────────

test('busy ticks coalesce into a single pending message', () => {
  const agent = new FakeAgent()
  const { runtime } = makeRuntime(agent, {
    signals: [signal()],
    gated: { level: 'L2', reason: 'r', keys: ['k'] },
  })
  runtime.tick()
  runtime.tick()
  runtime.tick()
  assert.equal(agent.followed.length, 1)
  assert.equal(agent.inbox.state['next-turn'].length, 1)
  assert.equal(agent.inbox.state['next-turn'][0].id, runtime.pendingId)
})

test('once claimed, the next tick sends a fresh message', () => {
  const agent = new FakeAgent()
  const { runtime } = makeRuntime(agent, { signals: [signal()], gated: { level: 'L1', reason: 'r', keys: [] } })
  runtime.tick()
  agent.inbox.claim('next-turn')
  runtime.tick()
  assert.equal(agent.followed.length, 2)
  assert.notEqual(agent.followed[0].id, agent.followed[1].id)
})

test('a host without the followup/inbox surface warns instead of throwing', () => {
  const agent = new FakeAgent()
  agent.followup = undefined
  const warnings = []
  const { runtime } = makeRuntime(agent, {
    signals: [signal()],
    gated: { level: 'L1', reason: 'r', keys: [] },
    extra: { logger: { info: () => {}, warn: (message) => warnings.push(message) } },
  })
  assert.doesNotThrow(() => runtime.tick())
  assert.equal(agent.followed.length, 0)
  assert.match(warnings.join('\n'), /no followup\/inbox surface/)
})

// ── guard rails ────────────────────────────────────────────────────────────

test('hard stop after pauseAfterMissed unanswered deliveries', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agent = new FakeAgent()
  const { runtime, vitals } = makeRuntime(agent, {
    config: baseConfig({ pauseAfterMissed: 2 }),
    signals: [signal()],
    gated: { level: 'L1', reason: 'r', keys: [] },
  })
  runtime.start()
  t.mock.timers.tick(600_000)
  assert.equal(agent.followed.length, 1)
  agent.inbox.claim('next-turn')
  t.mock.timers.tick(1_200_000)
  assert.equal(agent.followed.length, 2)
  agent.inbox.claim('next-turn')
  t.mock.timers.tick(1_800_000)
  assert.equal(agent.followed.length, 2, 'guard trips before the third delivery')
  assert.equal(runtime.paused, true)
  assert.equal(vitals.get(agent.session.id).paused, true)
  t.mock.timers.tick(24 * 3600_000)
  assert.equal(agent.followed.length, 2)
  runtime.dispose()
})

test('a real user message resumes a paused runtime and resets the guard', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agent = new FakeAgent()
  const { runtime, vitals } = makeRuntime(agent, {
    config: baseConfig({ pauseAfterMissed: 1 }),
    signals: [signal()],
    gated: { level: 'L1', reason: 'r', keys: [] },
  })
  runtime.start()
  t.mock.timers.tick(600_000)
  assert.equal(agent.followed.length, 1)
  agent.inbox.claim('next-turn')
  t.mock.timers.tick(600_000) // guard trips
  assert.equal(runtime.paused, true)
  agent.emitInserted({ id: 'user-1', source: { kind: 'user' } })
  assert.equal(runtime.paused, false)
  assert.equal(runtime.missedCount, 0)
  assert.equal(vitals.get(agent.session.id).missedCount, 0)
  t.mock.timers.tick(600_000)
  assert.equal(agent.followed.length, 2)
  runtime.dispose()
})

test('non-user inbox messages do not reset the guard', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agent = new FakeAgent()
  const { runtime } = makeRuntime(agent, {
    config: baseConfig({ pauseAfterMissed: 1 }),
    signals: [signal()],
    gated: { level: 'L1', reason: 'r', keys: [] },
  })
  runtime.start()
  t.mock.timers.tick(600_000)
  agent.inbox.claim('next-turn')
  agent.emitInserted({ id: 'hb-1', source: { kind: 'plugin:heartbeat' } })
  t.mock.timers.tick(600_000)
  assert.equal(runtime.paused, true)
  runtime.dispose()
})

test('restart cooldown suppresses delivery but still records a pulse', () => {
  const agent = new FakeAgent()
  const vitals = new FakeVitals()
  vitals.restartCoolingDown = true
  const { runtime } = makeRuntime(agent, {
    vitals,
    signals: [signal()],
    gated: { level: 'L2', reason: 'r', keys: ['k'] },
  })
  runtime.tick()
  assert.equal(agent.followed.length, 0)
  assert.equal(vitals.lastPulse.reason, 'restart-cooldown')
})

// ── rhythm / timers ────────────────────────────────────────────────────────

test('backoff tiers: base → 2× → 3× with no jitter', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agent = new FakeAgent()
  const { runtime } = makeRuntime(agent, {
    signals: [signal()],
    gated: { level: 'L1', reason: 'r', keys: [] },
  })
  runtime.start() // arm tier 0 = 600s
  t.mock.timers.tick(600_000)
  assert.equal(agent.followed.length, 1)
  agent.inbox.claim('next-turn')
  t.mock.timers.tick(1_200_000) // tier 1 = 1200s
  assert.equal(agent.followed.length, 2)
  agent.inbox.claim('next-turn')
  t.mock.timers.tick(1_800_000) // tier 2 = 1800s
  assert.equal(agent.followed.length, 3)
  runtime.dispose()
})

test('quiet hours schedule the next pulse for the window end', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agent = new FakeAgent()
  const now = new Date('2026-10-30T01:00:00').getTime()
  const { runtime } = makeRuntime(agent, {
    config: baseConfig({ quietHours: { start: '23:00', end: '08:00' } }),
    now: () => now,
  })
  runtime.start()
  assert.ok(runtime.timer !== undefined, 'a timer is still armed')
  assert.ok(runtime.nextBeatAt > now + 6 * 3600_000, 'it waits for the quiet window to end')
  runtime.dispose()
})

test('dispose clears the armed timers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agent = new FakeAgent()
  const { runtime } = makeRuntime(agent, { signals: [signal()], gated: { level: 'L1', reason: 'r', keys: [] } })
  runtime.start()
  runtime.dispose()
  t.mock.timers.tick(10 * 3600_000)
  assert.equal(agent.followed.length, 0)
})

test('event-driven noteSignal wakes a pulse after the debounce', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const agent = new FakeAgent()
  const { runtime } = makeRuntime(agent, { signals: [signal()], gated: { level: 'L1', reason: 'r', keys: [] } })
  runtime.start()
  runtime.noteSignal()
  t.mock.timers.tick(2_000)
  assert.equal(agent.followed.length, 1)
  runtime.dispose()
})

// ── compaction ─────────────────────────────────────────────────────────────

test('pre-beat compaction receives a real AbortSignal and then delivers', async () => {
  const agent = new FakeAgent()
  const calls = []
  const compaction = { compactNow: async (_agent, signal) => { calls.push(signal); return { ok: true } } }
  const { runtime } = makeRuntime(agent, {
    config: baseConfig({ compactBeforeBeat: true }),
    signals: [signal()],
    gated: { level: 'L2', reason: 'r', keys: ['k'] },
    extra: { getCompaction: () => compaction },
  })
  await runtime.tick()
  assert.equal(calls.length, 1)
  assert.ok(calls[0] instanceof AbortSignal)
  assert.equal(agent.followed.length, 1)
})

test('compaction failure never blocks the beat', async () => {
  const agent = new FakeAgent()
  const compaction = { compactNow: async () => { throw new Error('boom') } }
  const warnings = []
  const { runtime } = makeRuntime(agent, {
    config: baseConfig({ compactBeforeBeat: true }),
    signals: [signal()],
    gated: { level: 'L1', reason: 'r', keys: [] },
    extra: { getCompaction: () => compaction, logger: { info: () => {}, warn: (message) => warnings.push(message) } },
  })
  await runtime.tick()
  assert.equal(agent.followed.length, 1)
  assert.match(warnings.join('\n'), /compaction skipped/)
})

// ── manual / hot-plug helpers ──────────────────────────────────────────────

test('forceBeat delivers even while paused and ignores politeness gates', () => {
  const agent = new FakeAgent()
  const { runtime } = makeRuntime(agent, { signals: [], gated: { level: 'L1', reason: 'manual', keys: [] } })
  runtime.pause('manual')
  assert.equal(runtime.forceBeat(), true)
  assert.equal(agent.followed.length, 1)
})

test('liveness check disposes a runtime whose agent is gone', () => {
  const registry = { live: new Map(), roots: () => [...registry.live.values()], get: (id) => registry.live.get(id) }
  const agent = new FakeAgent()
  registry.live.set(agent.id, agent)
  const runtime = new HeartbeatRuntime(agent, {
    readConfig: () => baseConfig(),
    agents: registry,
    logger: { info: () => {}, warn: () => {} },
  })
  registry.live.delete(agent.id)
  runtime.tick()
  assert.equal(runtime.disposed, true)
})
