/**
 * Sensors: projection diffs → signals, signatures, suppression inputs.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  collectSignals,
  signatureOf,
  teamSnapshotOf,
  activeQuestionIds,
  hashText,
} from '../lib/sensors.js'

const session = { id: 's' }
const projectionsOf = (values) => ({ stateOf: (_session, key) => values[key] })
const fakeVitals = (seen = {}) => ({ get: () => ({ seen }) })

test('hashText is stable and changes with input', () => {
  assert.equal(hashText('abc'), hashText('abc'))
  assert.notEqual(hashText('abc'), hashText('abd'))
})

test('teamSnapshotOf computes readiness from completed blockers', () => {
  const snapshot = teamSnapshotOf({
    tasks: [
      { id: 'task-1', subject: 'done', status: 'completed', blockedBy: [] },
      { id: 'task-2', subject: 'ready', status: 'pending', blockedBy: ['task-1'] },
      { id: 'task-3', subject: 'blocked', status: 'pending', blockedBy: ['task-9'] },
      { id: 'task-4', subject: 'working', status: 'in_progress', blockedBy: [] },
    ],
  })
  assert.equal(snapshot['task-2'].ready, true)
  assert.equal(snapshot['task-3'].ready, false)
  assert.deepEqual(snapshot['task-3'].blockedBy, ['task-9'])
})

test('signatureOf captures open todos and pending questions', () => {
  const first = signatureOf({
    todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'completed' }],
    team: { tasks: [] },
    goal: { current: null },
    questions: { questions: { active: [{ callId: 'call-1' }], settled: [] } },
  })
  const second = signatureOf({
    todos: [{ content: 'a', status: 'pending' }, { content: 'b', status: 'completed' }],
    team: { tasks: [] },
    goal: { current: null },
    questions: { questions: { active: [{ callId: 'call-1' }], settled: [] } },
  })
  assert.deepEqual(first, second)
  assert.equal(first.questions, 'call-1')
  const changed = signatureOf({
    todos: [{ content: 'a', status: 'completed' }],
    team: { tasks: [] },
    goal: { current: null },
    questions: { questions: { active: [], settled: [] } },
  })
  assert.notEqual(first.todos, changed.todos)
})

test('a newly ready team task becomes a decision signal', () => {
  const projections = projectionsOf({
    todos: null,
    agentTeam: { tasks: [{ id: 'task-3', subject: '发布', status: 'pending', blockedBy: [] }] },
    goal: { current: null },
    userQuestions: { questions: { active: [], settled: [] } },
  })
  const result = collectSignals({ projections, session, vitals: fakeVitals(), sessionId: 's', pressure: 0.2 })
  const ready = result.signals.find((signal) => signal.key === 'team:task-3:ready')
  assert.ok(ready)
  assert.equal(ready.weight, 5)
  assert.ok(result.arousal >= 5)
  assert.equal(result.pressure, 0.2)
  assert.equal(typeof result.seen.team, 'string')
})

test('unchanged projections produce no signals', () => {
  const values = {
    todos: [{ content: 'a', status: 'pending' }],
    agentTeam: { tasks: [{ id: 'task-1', subject: 'x', status: 'in_progress', blockedBy: [] }] },
    goal: { current: { goal: { id: 'g1', objective: '发版', phase: 'active' } } },
    userQuestions: { questions: { active: [], settled: [] } },
  }
  const seen = signatureOf({
    todos: values.todos,
    team: values.agentTeam,
    goal: values.goal,
    questions: values.userQuestions,
  })
  const result = collectSignals({
    projections: projectionsOf(values),
    session,
    vitals: fakeVitals(seen),
    sessionId: 's',
  })
  assert.deepEqual(result.signals, [])
  assert.equal(result.arousal, 0)
})

test('blocked and completed team tasks produce their own signals', () => {
  const seen = signatureOf({
    todos: null,
    team: {
      tasks: [
        { id: 'task-1', subject: 'done', status: 'in_progress', blockedBy: [] },
        { id: 'task-2', subject: 'blocked', status: 'pending', blockedBy: [] },
      ],
    },
    goal: { current: null },
    questions: { questions: { active: [], settled: [] } },
  })
  const projections = projectionsOf({
    todos: null,
    agentTeam: {
      tasks: [
        { id: 'task-1', subject: 'done', status: 'completed', blockedBy: [] },
        { id: 'task-2', subject: 'blocked', status: 'pending', blockedBy: ['task-9'] },
      ],
    },
    goal: { current: null },
    userQuestions: { questions: { active: [], settled: [] } },
  })
  const result = collectSignals({ projections, session, vitals: fakeVitals(seen), sessionId: 's' })
  const kinds = result.signals.map((signal) => signal.kind)
  assert.ok(kinds.includes('team-completed'))
  assert.ok(kinds.includes('team-blocked'))
})

test('goal blocked and pending questions are surfaced', () => {
  const result = collectSignals({
    projections: projectionsOf({
      todos: null,
      agentTeam: undefined,
      goal: { current: { goal: { id: 'g1', objective: '发版', phase: 'blocked' } } },
      userQuestions: { questions: { active: [{ callId: 'call-9', questions: [{ question: '要现在做吗？' }] }], settled: [] } },
    }),
    session,
    vitals: fakeVitals(),
    sessionId: 's',
  })
  const keys = result.signals.map((signal) => signal.key)
  assert.ok(keys.includes('goal:g1:blocked'))
  assert.ok(keys.includes('question:call-9'))
})

test('missing projections and broken registries degrade to no signals', () => {
  const broken = { stateOf: () => { throw new Error('boom') } }
  for (const projections of [undefined, {}, broken]) {
    const result = collectSignals({ projections, session, vitals: fakeVitals(), sessionId: 's' })
    assert.deepEqual(result.signals, [])
    assert.equal(result.arousal, 0)
  }
})

test('activeQuestionIds tolerates missing shapes', () => {
  assert.deepEqual(activeQuestionIds(undefined), [])
  assert.deepEqual(activeQuestionIds({ questions: {} }), [])
  assert.deepEqual(activeQuestionIds({ questions: { active: [{ callId: 'b' }, { callId: 'a' }] } }), ['a', 'b'])
})
