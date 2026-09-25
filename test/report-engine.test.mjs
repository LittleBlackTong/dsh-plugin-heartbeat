// dsh-plugin-heartbeat v2 report-engine unit tests.
// Run with `node --test test/` after installing devDependencies.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HeartbeatEngine, HeartbeatReportStore, HeartbeatConfigStore, annotateModels } from '../lib/index.js'
import { digestSession, mechanicalSuspect, mechanicalLevel } from '../lib/digest.js'
import { evaluateStrategies } from '../lib/strategies.js'

const tmp = mkdtempSync(join(tmpdir(), 'hb-v2-'))

// ---------- 1) store: report fields, partial updates, persistence ----------
test('store: report fields, partial updates keep fields, persistence roundtrip', () => {
  const store = new HeartbeatConfigStore({
    path: join(tmp, 'heartbeat.json'),
    base: { enabled: true, intervalSeconds: 600, pauseAfterMissed: 3, report: { enabled: true, retention: 120 } },
  })
  assert.equal(store.get().report.enabled, true, 'composition base report.enabled applies')
  store.update({ report: { retention: 80 } })
  assert.equal(store.get().report.enabled, true, 'partial update keeps enabled')
  assert.equal(store.get().report.retention, 80)
  store.update({ report: { model: { provider: 'deepseek-official', model: 'deepseek-chat' } } })
  assert.equal(store.get().report.enabled, true, 'partial update keeps enabled/retention')
  assert.equal(store.get().report.retention, 80)
  assert.deepEqual(store.get().report.model, { provider: 'deepseek-official', model: 'deepseek-chat' })
  const reloaded = new HeartbeatConfigStore({ path: join(tmp, 'heartbeat.json'), base: {} })
  assert.deepEqual(reloaded.get().report.model, { provider: 'deepseek-official', model: 'deepseek-chat' }, 'model choice survives restart')
})

// ---------- 2) mechanical digest ----------
test('digest: text extraction, turn outcome, tool errors, suspicion', () => {
  const mkEvent = (type, time, data) => ({ type, time, data })
  const fakeSession = {
    id: 'session-1',
    header: { cwd: 'E:\\work' },
    seq: 12,
    ownEvents: () => [
      mkEvent('turn/start', 1000, { turn: 1 }),
      mkEvent('user/message', 1100, { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我检查心跳插件' }] }),
      mkEvent('assistant/message', 1200, { message: { source: { kind: 'model' }, content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '好的，马上查。' }] } }),
      mkEvent('tool/result', 1300, { message: { isError: true, content: [{ type: 'text', text: 'boom' }] } }),
      mkEvent('turn/end', 1400, { reason: { kind: 'error', error: { message: 'x' } } }),
    ],
  }
  const d = digestSession(fakeSession, { title: 'WorkSpace', now: 1400 })
  assert.equal(d.turnEnd, 'error')
  assert.equal(d.toolErrors, 1)
  assert.equal(d.lastUserText, '帮我检查心跳插件')
  assert.equal(d.lastAssistantText, '好的，马上查。', 'reasoning blocks excluded')
  assert.equal(mechanicalSuspect(d), true)
  assert.equal(mechanicalLevel(d), 'warn', 'session anomalies are yellow (warn), not red')
})

test('digest: ask_user_question marks a pending decision (blue)', () => {
  const fakeSession = {
    id: 'session-2',
    header: {},
    seq: 5,
    ownEvents: () => [
      { type: 'tool/call', time: 100, data: { name: 'ask_user_question' } },
      { type: 'turn/end', time: 200, data: { reason: { kind: 'completed' } } },
    ],
  }
  const d = digestSession(fakeSession, { now: 300 })
  assert.equal(d.pendingQuestion, true)
  assert.equal(mechanicalSuspect(d), true)
  assert.equal(mechanicalLevel(d), 'decide', 'pending question → blue (decide)')
})

test('digest: the report window stops re-reporting historical tool errors', () => {
  const mk = (type, seq, time, data) => ({ type, seq, time, data })
  const session = {
    id: 'session-window',
    header: {},
    seq: 50,
    ownEvents: () => [
      mk('tool/result', 10, 1000, { message: { isError: true } }),
      mk('tool/result', 11, 1100, { message: { isError: true } }),
      mk('turn/start', 40, 2000, { turn: 2 }),
      mk('turn/end', 50, 2100, { reason: { kind: 'completed' } }),
    ],
  }
  const full = digestSession(session, { now: 2200 })
  assert.equal(full.toolErrors, 2, 'no window (first report) still sees the whole tail')
  assert.equal(full.turnEnd, 'completed')

  const windowed = digestSession(session, { now: 2200, sinceSeq: 39 })
  assert.equal(windowed.toolErrors, 0, 'errors before the window are not counted')
  assert.equal(windowed.turnEnd, 'completed')
  assert.equal(windowed.windowEvents, 2, 'only the two events after sinceSeq')
  assert.equal(mechanicalSuspect(windowed), false)
  assert.equal(mechanicalLevel(windowed), 'ok', 'a clean window reads green')
})

test('digest: pending decision is state-scoped (stays until answered)', () => {
  const mk = (type, seq, time, data) => ({ type, seq, time, data })
  const base = [
    mk('tool/call', 10, 1000, { name: 'ask_user_question' }),
    mk('turn/end', 11, 1100, { reason: { kind: 'completed' } }),
  ]
  const session = { id: 'session-q', header: {}, seq: 20, ownEvents: () => base }
  const asked = digestSession(session, { now: 1200, sinceSeq: 11 })
  assert.equal(asked.pendingQuestion, true, 'unanswered question survives the window')

  const answered = {
    id: 'session-q',
    header: {},
    seq: 30,
    ownEvents: () => [...base, mk('user/message', 25, 2000, { source: { kind: 'user' }, content: [{ type: 'text', text: '选 A' }] })],
  }
  const cleared = digestSession(answered, { now: 2100, sinceSeq: 11 })
  assert.equal(cleared.pendingQuestion, false, 'a real user message clears it')
})

test('engine: a stale error is reported once, then the next window goes green without a model call', async () => {
  const reportStore = new HeartbeatReportStore({ path: join(tmp, 'reports-window.json'), retention: 20 })
  let llmCalls = 0
  const llm = {
    stream: async function* () {
      llmCalls += 1
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ levels: { 'session-1': 'warn' } }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  let seq = 50
  let events = [
    { type: 'user/message', seq: 10, time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
    { type: 'tool/result', seq: 11, time: 1100, data: { message: { isError: true } } },
    { type: 'turn/end', seq: 12, time: 1200, data: { reason: { kind: 'completed' } } },
  ]
  const session = {
    id: 'session-1',
    header: { cwd: 'E:\\work' },
    get seq() { return seq },
    ownEvents: () => events,
  }
  const engine = new HeartbeatEngine(
    { on: () => () => {}, emit: () => {}, agents: { get: () => undefined } },
    {
      readConfig: () => ({ enabled: true, intervalSeconds: 60, pauseAfterMissed: 0, maxBeatsPerHour: 0 }),
      readReportConfig: () => ({ enabled: true, retention: 20, judgment: { enabled: true }, strategies: [] }),
      reportStore,
      getSessions: () => ({ list: () => [session] }),
      getLlm: () => llm,
      getDefaultModel: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
      getTitle: () => 'WorkSpace',
      logger: { info: () => {}, warn: () => {} },
    },
  )

  await engine.tick()
  assert.equal(reportStore.snapshot().length, 1, 'first beat reports the anomaly')
  assert.equal(reportStore.snapshot()[0].level, 'warn')
  assert.equal(llmCalls, 1, 'one judgment call for the suspected digest')

  seq = 60
  events = [
    ...events,
    { type: 'turn/start', seq: 55, time: 5000, data: { turn: 3 } },
    { type: 'tool/result', seq: 56, time: 5100, data: { message: { content: [] } } },
    { type: 'turn/end', seq: 60, time: 5200, data: { reason: { kind: 'completed' } } },
  ]
  await engine.tick()
  const snapshot = reportStore.snapshot()
  assert.equal(snapshot.length, 2, 'the new window gets its own entry')
  assert.equal(snapshot[1].level, 'ok', 'a clean window is green')
  assert.equal(snapshot[1].detail.toolErrors, 0, 'the historical error is not re-counted')
  assert.equal(llmCalls, 1, 'no model call when nothing in the window is suspected')
  assert.equal(reportStore.latestFor('session-1').level, 'ok', 'the session flag follows its newest row')
})

// ---------- 3) file sensor: changed semantics ----------
test('file sensor: baseline first, hit on change, silent when unchanged', async () => {
  const state = { mtime: 1000, size: 10 }
  const fakeFs = {
    resolve: async (path) => ({ path }),
    stat: async () => ({ mtimeMs: state.mtime, size: state.size }),
  }
  const strategy = { id: 'watch-tokens', label: '监控 tokens', level: 'warn', message: 'tokens.json 变了', sensor: { kind: 'file', path: 'x', mode: 'changed' } }
  let hits = await evaluateStrategies([strategy], { fsService: fakeFs, tickCount: 1 })
  assert.equal(hits.length, 0, 'first beat records the baseline only')
  state.mtime = 2000
  hits = await evaluateStrategies([strategy], { fsService: fakeFs, tickCount: 2 })
  assert.equal(hits.length, 1, 'mtime change hits')
  state.mtime = 2000
  hits = await evaluateStrategies([strategy], { fsService: fakeFs, tickCount: 3 })
  assert.equal(hits.length, 0, 'no change stays silent')
})

// ---------- 4) engine pipeline ----------
const mkEngine = (reportStore, llm) => {
  const fakeSession = {
    id: 'session-1',
    header: { cwd: 'E:\\work' },
    seq: 12,
    ownEvents: () => [
      { type: 'user/message', time: 1100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我检查心跳插件' }] } },
      { type: 'tool/result', time: 1300, data: { message: { isError: true, content: [{ type: 'text', text: 'boom' }] } } },
      { type: 'turn/end', time: 1400, data: { reason: { kind: 'error', error: { message: 'x' } } } },
    ],
  }
  return new HeartbeatEngine(
    { on: () => () => {}, emit: () => {}, agents: { get: () => undefined } },
    {
      readConfig: () => ({ enabled: true, intervalSeconds: 60, pauseAfterMissed: 2, maxBeatsPerHour: 0 }),
      readReportConfig: () => ({ enabled: true, retention: 20, judgment: { enabled: true }, strategies: [] }),
      reportStore,
      getSessions: () => ({ list: () => [fakeSession] }),
      getLlm: () => llm,
      getDefaultModel: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
      getTitle: () => 'WorkSpace',
      logger: { info: () => {}, warn: () => {} },
    },
  )
}

test('engine: judgment, in-place refresh, hard stop, page touch', async () => {
  const reportStore = new HeartbeatReportStore({ path: join(tmp, 'reports.json'), retention: 20 })
  const fakeLlm = {
    stream: async function* (options) {
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ levels: { 'session-1': 'warn' } }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const engine = mkEngine(reportStore, fakeLlm)
  await engine.tick()
  let entries = reportStore.snapshot()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].level, 'warn', 'model level adopted (yellow for session anomaly)')
  assert.equal(entries[0].kind, 'session')

  const firstTime = entries[0].time
  await engine.tick()
  entries = reportStore.snapshot()
  assert.equal(entries.length, 1, 'an unresolved problem refreshes the same row (no duplicates)')
  assert.ok(entries[0].time >= firstTime)
  assert.equal(engine.missedCount, 2)

  await engine.tick()
  assert.equal(engine.status().status, 'paused', 'hard stop after N quiet beats')

  engine.touch()
  assert.equal(engine.status().status, 'running', 'opening the report page revives the engine')
  assert.equal(engine.missedCount, 0)
})

test('engine: judgment falls back to mechanical rules when the model fails', async () => {
  const reportStore = new HeartbeatReportStore({ path: join(tmp, 'reports2.json') })
  const brokenLlm = { stream: async function* () { throw new Error('no network') } }
  const engine = mkEngine(reportStore, brokenLlm)
  await engine.tick()
  assert.equal(reportStore.snapshot()[0].level, 'warn', 'mechanical fallback on model failure (yellow)')
})

test('engine: persisting the cursor survives a restart (no resurrected errors)', async () => {
  const storePath = join(tmp, 'reports-cursor.json')
  let llmCalls = 0
  const llm = {
    stream: async function* () {
      llmCalls += 1
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ levels: { 'session-1': 'warn' } }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const events = [
    { type: 'user/message', seq: 10, time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
    { type: 'tool/result', seq: 11, time: 1100, data: { message: { isError: true } } },
    { type: 'turn/end', seq: 12, time: 1200, data: { reason: { kind: 'completed' } } },
  ]
  const session = { id: 'session-1', header: {}, seq: 12, ownEvents: () => events }
  const mkEngine = (store) => new HeartbeatEngine(
    { on: () => () => {}, emit: () => {}, agents: { get: () => undefined } },
    {
      readConfig: () => ({ enabled: true, intervalSeconds: 60, pauseAfterMissed: 0, maxBeatsPerHour: 0 }),
      readReportConfig: () => ({ enabled: true, retention: 50, judgment: { enabled: true }, strategies: [] }),
      reportStore: store,
      getSessions: () => ({ list: () => [session] }),
      getLlm: () => llm,
      getDefaultModel: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
      logger: { info: () => {}, warn: () => {} },
    },
  )

  const firstStore = new HeartbeatReportStore({ path: storePath, retention: 50 })
  await mkEngine(firstStore).tick()
  assert.equal(firstStore.snapshot().length, 1, 'first report covers the whole tail')
  assert.equal(firstStore.getCursor('session-1'), 12, 'cursor persisted with the report')

  // "Restart": a brand-new store reads the file, a brand-new engine starts.
  const restartedStore = new HeartbeatReportStore({ path: storePath, retention: 50 })
  const engine = mkEngine(restartedStore)
  assert.equal(engine.reportStore.getCursor('session-1'), 12, 'cursor restored from disk')
  await engine.tick()
  assert.equal(restartedStore.snapshot().length, 1, 'no first-beat resurrection of the old error')
  assert.equal(llmCalls, 1, 'no extra judgment call after the restart')
})

test('engine: subagent sessions are excluded from the report (original boundary)', async () => {
  const reportStore = new HeartbeatReportStore({ path: join(tmp, 'reports-subagent.json'), retention: 50 })
  const mkSession = (id, header) => ({ id, header, seq: 10, ownEvents: () => [] })
  const sessions = [
    mkSession('root-1', { cwd: 'E:\\work' }),
    mkSession('sub-1', { cwd: 'E:\\work', origin: 'subagent' }),
  ]
  let llmCalls = 0
  const engine = new HeartbeatEngine(
    { on: () => () => {}, emit: () => {}, agents: { get: () => undefined } },
    {
      readConfig: () => ({ enabled: true, intervalSeconds: 60, pauseAfterMissed: 0, maxBeatsPerHour: 0 }),
      readReportConfig: () => ({ enabled: true, retention: 50, judgment: { enabled: true }, strategies: [] }),
      reportStore,
      getSessions: () => ({ list: () => sessions }),
      getLlm: () => ({ stream: async function* () { llmCalls += 1; yield { type: 'finish', reason: { kind: 'stop' } } } }),
      getDefaultModel: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
      logger: { info: () => {}, warn: () => {} },
    },
  )
  await engine.tick()
  const reported = reportStore.snapshot().map((entry) => entry.sessionId)
  assert.ok(reported.includes('root-1'), 'root session reported')
  assert.ok(!reported.includes('sub-1'), 'subagent session skipped (README: 子 agent 不挂心跳)')
  assert.equal(llmCalls, 0, 'nothing suspected, no model call')
})

test('report store: setRetention prunes immediately at runtime', () => {
  const store = new HeartbeatReportStore({ path: join(tmp, 'reports-retention.json'), retention: 200 })
  for (let i = 0; i < 12; i += 1) {
    store.append({ kind: 'session', level: 'ok', source: `s${i}`, summary: 'x' })
  }
  assert.equal(store.snapshot().length, 12)
  store.setRetention(10)
  assert.equal(store.snapshot().length, 10, 'shrinking retention prunes without a restart')
  assert.equal(store.retention, 10)
})

test('report store: markdown document generation', () => {
  const reportStore = new HeartbeatReportStore({ path: join(tmp, 'reports3.json'), retention: 20 })
  reportStore.append({ kind: 'session', level: 'ok', source: '会话A', summary: '一切正常', detail: { lastUserText: 'hi' }, sessionId: 's1' })
  reportStore.append({ kind: 'strategy', level: 'warn', source: 'watch', summary: '文件变了', strategy: 'watch' })
  const mdPath = join(tmp, 'report.md')
  reportStore.writeMarkdown(mdPath, { title: 'HeartBeat Report', status: { status: 'running', tickCount: 3, unread: 0 }, reportEnabled: true })
  const text = readFileSync(mdPath, 'utf8')
  assert.match(text, /# HeartBeat Report/)
  assert.match(text, /🟢 正常/)
  assert.match(text, /🟡 异常/)
  assert.match(text, /会话A/)
})

// ---------- 5) pricing recommendation ----------
test('pricing: cheapest recommendation = lowest estimated cost', () => {
  const { models, cheapest } = annotateModels([
    { provider: 'deepseek-official', model: 'deepseek-flash' },
    { provider: 'deepseek-official', model: 'deepseek-reasoner' },
    { provider: 'xiaomi', model: 'mimo-v2.6-flash' },
  ])
  assert.ok(cheapest, 'a cheapest model exists')
  const cheapestEntry = models.find((m) => m.provider === cheapest.provider && m.model === cheapest.model)
  assert.equal(Math.min(...models.map((m) => m.cost)), cheapestEntry.cost)
})

test('cleanup', () => {
  rmSync(tmp, { recursive: true, force: true })
})
