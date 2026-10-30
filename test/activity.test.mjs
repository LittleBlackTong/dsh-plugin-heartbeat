/**
 * Live child activity for the status route and the conversation-header pill.
 *
 * The pill exists because DSH's own conversation header can show a finished
 * parent turn while a background subagent is still executing: the host
 * recomputes a list row's `running` flag only on agent add/dispose, and
 * forwards `api-session/status` per session resource. The plugin therefore
 * reports host truth (catalog/team children + live agent registry) on its own
 * `/api/heartbeat/status` route, and the client pill polls it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { childActivityOf, childWorkActiveOf } from '../lib/index.js'

const session = { id: 'session-root' }

/** Fake agents registry whose children report the given statuses. */
function registry(statuses) {
  const map = new Map(Object.entries(statuses).map(([id, status]) => [id, { status }]))
  return { get: (id) => map.get(id) }
}

/** Fake projections service serving wire views through `snapshot`. */
function projections(valuesByKey) {
  return {
    snapshot: (_session, keys) => ({
      asOfSeq: 7,
      values: Object.fromEntries(keys.map((key) => [key, valuesByKey[key]])),
    }),
  }
}

test('childActivityOf counts catalog children and their running state', () => {
  const activity = childActivityOf({
    projections: projections({ subagentCatalog: [{ id: 'child-a' }, { id: 'child-b' }] }),
    agents: registry({ 'child-a': 'running', 'child-b': 'idle' }),
    agent: { session },
  })
  assert.deepEqual(activity, { total: 2, running: 1, runningIds: ['child-a'] })
})

test('childActivityOf counts Agent Team members too and ignores the lead', () => {
  const activity = childActivityOf({
    projections: projections({
      subagentCatalog: [],
      agentTeam: { members: [{ id: 'lead-1', role: 'lead' }, { id: 'mate-1', role: 'teammate' }] },
    }),
    agents: registry({ 'lead-1': 'running', 'mate-1': 'running' }),
    agent: { session },
  })
  assert.deepEqual(activity, { total: 1, running: 1, runningIds: ['mate-1'] })
})

test('childActivityOf deduplicates ids present in both sources', () => {
  const activity = childActivityOf({
    projections: projections({
      subagentCatalog: [{ id: 'child-a' }],
      agentTeam: { members: [{ id: 'child-a', role: 'teammate' }] },
    }),
    agents: registry({ 'child-a': 'running' }),
    agent: { session },
  })
  assert.equal(activity.total, 1)
  assert.equal(activity.running, 1)
})

test('childActivityOf degrades to zero without projections, agents or children', () => {
  assert.deepEqual(childActivityOf({}), { total: 0, running: 0, runningIds: [] })
  assert.deepEqual(childActivityOf({ projections: { snapshot: () => undefined }, agents: registry({}), agent: { session } }), {
    total: 0,
    running: 0,
    runningIds: [],
  })
  assert.deepEqual(childWorkActiveOf({ agents: registry({ 'child-a': 'running' }), agent: { session } }), false)
})

test('childWorkActiveOf derives from the same counts', () => {
  const options = {
    projections: projections({ subagentCatalog: [{ id: 'child-a' }] }),
    agents: registry({ 'child-a': 'running' }),
    agent: { session },
  }
  assert.equal(childWorkActiveOf(options), true)
  options.agents = registry({ 'child-a': 'idle' })
  assert.equal(childWorkActiveOf(options), false)
})
