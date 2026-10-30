/**
 * Projection access helpers: raw state vs wire view.
 *
 * Regression background: `sessionProjections.stateOf()` returns the unit's raw
 * state (`subagent` → `{}` / `{identity}`, `subagentCatalog` →
 * `{inheritedEventCount, head}`). Reading it as if it were the wire view made
 * every root session look like a subagent (so attach skipped everything) and
 * made the child-work gate blind (so heartbeats fired while children ran).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  childWorkActiveOf,
  sessionWireOf,
  subagentIdentityOf,
} from '../lib/index.js'

const session = { id: 'session-1' }

test('sessionWireOf prefers the snapshot wire view', () => {
  const projections = {
    snapshot: (_session, keys) => ({ asOfSeq: 1, values: Object.fromEntries(keys.map((key) => [key, `wire:${key}`])) }),
    stateOf: () => 'raw',
  }
  assert.equal(sessionWireOf(projections, session, 'subagent'), 'wire:subagent')
})

test('sessionWireOf falls back to the raw state', () => {
  const projections = { stateOf: () => 'raw' }
  assert.equal(sessionWireOf(projections, session, 'subagent'), 'raw')
  assert.equal(sessionWireOf(undefined, session, 'subagent'), undefined)
  assert.equal(sessionWireOf({ stateOf: () => { throw new Error('boom') } }, session, 'subagent'), undefined)
})

test('a root session raw state `{}` is not a subagent identity', () => {
  // The exact production bug: `{}` is truthy, so `identity !== undefined` was
  // true for every root session and heartbeat never attached.
  assert.equal(subagentIdentityOf({ stateOf: () => ({}) }, session), null)
  assert.equal(subagentIdentityOf({ snapshot: () => ({ asOfSeq: 0, values: { subagent: null } }) }, session), null)
  assert.equal(subagentIdentityOf(undefined, session), null)
})

test('a subagent identity is recognised from raw state and from the wire view', () => {
  const raw = { stateOf: () => ({ identity: { mode: 'continuable', label: 'worker', seq: 3 } }) }
  assert.deepEqual(subagentIdentityOf(raw, session), { mode: 'continuable', label: 'worker', seq: 3 })
  const wire = { snapshot: () => ({ asOfSeq: 2, values: { subagent: { mode: 'one-shot', seq: 4 } } }) }
  assert.deepEqual(subagentIdentityOf(wire, session), { mode: 'one-shot', seq: 4 })
})

test('childWorkActiveOf reads the catalog wire view and the live agents', () => {
  const agents = { registry: new Map(), get(id) { return this.registry.get(id) } }
  agents.registry.set('child-1', { status: 'running' })
  const projections = {
    snapshot: (_session, keys) => ({
      asOfSeq: 5,
      values: Object.fromEntries(keys.map((key) => [key, key === 'subagentCatalog'
        ? [{ id: 'child-1', mode: 'continuable', label: 'worker' }]
        : key === 'agentTeam' ? { members: [], tasks: [] } : null])),
    }),
  }
  assert.equal(childWorkActiveOf({ projections, agents, agent: { session } }), true)
  agents.registry.set('child-1', { status: 'idle' })
  assert.equal(childWorkActiveOf({ projections, agents, agent: { session } }), false)
})

test('childWorkActiveOf also looks at Agent Team members and degrades safely', () => {
  const agents = { get: (id) => ({ 'teammate-1': { status: 'running' } })[id] }
  const projections = {
    snapshot: (_session, keys) => ({
      asOfSeq: 6,
      values: Object.fromEntries(keys.map((key) => [key, key === 'subagentCatalog'
        ? []
        : key === 'agentTeam'
          ? { members: [{ id: 'lead-1', role: 'lead' }, { id: 'teammate-1', role: 'teammate' }], tasks: [] }
          : null])),
    }),
  }
  assert.equal(childWorkActiveOf({ projections, agents, agent: { session } }), true)
  assert.equal(childWorkActiveOf({ projections: undefined, agents: undefined, agent: { session } }), false)
  assert.equal(childWorkActiveOf({ projections: { snapshot: () => undefined }, agents, agent: { session } }), false)
})
