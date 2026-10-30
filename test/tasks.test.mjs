/**
 * dsh-plugin-heartbeat — session task snapshot unit tests (v0.5.0).
 *
 * Run with `node --test test/`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectSessionTasks,
  renderTaskNudge,
  clampMaxItems,
  readTodos,
  readTeamTasks,
  readGoal,
  TASK_BLOCK_MAX_CHARS,
} from '../lib/tasks.js'
import { renderPrompt, TASKS_PLACEHOLDER, DEFAULT_PROMPT } from '../lib/prompt.js'

// ── projection readers ─────────────────────────────────────────────────────

test('readTodos keeps open items only and clips long content', () => {
  const todos = readTodos([
    { content: '  写代码  ', status: 'in_progress' },
    { content: '补测试', status: 'pending' },
    { content: '已完成', status: 'completed' },
    { content: '', status: 'pending' },
    null,
    { content: 'x'.repeat(400), status: 'pending' },
  ])
  assert.deepEqual(todos.inProgress, ['写代码'])
  assert.equal(todos.pending.length, 2)
  assert.ok(todos.pending[1].length <= 120)
})

test('readTodos tolerates null / non-array state', () => {
  assert.deepEqual(readTodos(null), { inProgress: [], pending: [] })
  assert.deepEqual(readTodos(undefined), { inProgress: [], pending: [] })
  assert.deepEqual(readTodos({ nope: true }), { inProgress: [], pending: [] })
})

test('readTeamTasks derives readiness from completed blockers', () => {
  const tasks = readTeamTasks({
    tasks: [
      { id: 'task-1', subject: 'done', status: 'completed', blockedBy: [] },
      { id: 'task-2', subject: 'ready', status: 'pending', blockedBy: ['task-1'] },
      { id: 'task-3', subject: 'blocked', status: 'pending', blockedBy: ['task-9'] },
      { id: 'task-4', subject: 'working', status: 'in_progress', blockedBy: [] },
      { id: 'task-5', subject: 'gone', status: 'deleted', blockedBy: [] },
    ],
  })
  assert.deepEqual(tasks.map((task) => task.id), ['task-2', 'task-4', 'task-3'])
  assert.equal(tasks[0].ready, true)
  assert.equal(tasks[1].ready, false)
  assert.deepEqual(tasks[1].blockedBy, [])
  assert.equal(tasks[2].ready, false)
  assert.deepEqual(tasks[2].blockedBy, ['task-9'])
})

test('readTeamTasks tolerates missing state', () => {
  assert.deepEqual(readTeamTasks(undefined), [])
  assert.deepEqual(readTeamTasks({}), [])
})

test('readGoal surfaces active / blocked / paused goals only', () => {
  assert.deepEqual(
    readGoal({ current: { goal: { objective: '发货', phase: 'active' } } }),
    { objective: '发货', phase: 'active' },
  )
  assert.equal(readGoal({ current: { goal: { objective: '发货', phase: 'complete' } } }), undefined)
  assert.equal(readGoal({ current: null }), undefined)
  assert.equal(readGoal(undefined), undefined)
})

test('clampMaxItems bounds the item cap', () => {
  assert.equal(clampMaxItems(undefined), 5)
  assert.equal(clampMaxItems(0), 1)
  assert.equal(clampMaxItems(99), 20)
  assert.equal(clampMaxItems(3.9), 3)
  assert.equal(clampMaxItems('7'), 7)
})

// ── collect: defensive but faithful ────────────────────────────────────────

const session = { id: 'session-1' }

test('collectSessionTasks returns undefined when nothing is actionable', () => {
  const projections = {
    stateOf: (_session, key) => ({
      todos: [{ content: '已完成', status: 'completed' }],
      agentTeam: { tasks: [{ id: 'task-1', subject: 'done', status: 'completed', blockedBy: [] }] },
      goal: { current: { goal: { objective: '已做完', phase: 'complete' } } },
    })[key],
  }
  assert.equal(collectSessionTasks({ projections, session }), undefined)
})

test('collectSessionTasks returns undefined without a projection registry or session', () => {
  assert.equal(collectSessionTasks({ projections: undefined, session }), undefined)
  assert.equal(collectSessionTasks({ projections: {}, session }), undefined)
  assert.equal(collectSessionTasks({ projections: { stateOf: () => undefined }, session: undefined }), undefined)
})

test('collectSessionTasks absorbs a throwing projection', () => {
  const projections = {
    stateOf: () => {
      throw new Error('boom')
    },
  }
  assert.equal(collectSessionTasks({ projections, session }), undefined)
})

test('collectSessionTasks assembles todos, team tasks and goal', () => {
  const projections = {
    stateOf: (_session, key) => ({
      todos: [{ content: '补测试', status: 'pending' }],
      agentTeam: { tasks: [{ id: 'task-1', subject: '实现', status: 'pending', blockedBy: [] }] },
      goal: { current: { goal: { objective: '发 0.5.0', phase: 'blocked' } } },
    })[key],
  }
  const snapshot = collectSessionTasks({ projections, session, maxItems: 2 })
  assert.ok(snapshot)
  assert.deepEqual(snapshot.todos, { inProgress: [], pending: ['补测试'] })
  assert.equal(snapshot.teamTasks.length, 1)
  assert.equal(snapshot.teamTasks[0].ready, true)
  assert.deepEqual(snapshot.goal, { objective: '发 0.5.0', phase: 'blocked' })
})

// ── rendering ──────────────────────────────────────────────────────────────

test('renderTaskNudge reports the snapshot and the ask-before-acting rule', () => {
  const text = renderTaskNudge({
    todos: { inProgress: ['写实现'], pending: ['补单测'] },
    teamTasks: [{ id: 'task-2', subject: '发布', status: 'pending', ready: false, blockedBy: ['task-1'] }],
    goal: { objective: '发 0.5.0', phase: 'active' },
  })
  assert.match(text, /会话任务巡检/)
  assert.match(text, /进行中：写实现/)
  assert.match(text, /待办：补单测/)
  assert.match(text, /task-2 发布 \[被阻塞（task-1）\]/)
  assert.match(text, /当前目标（active）：发 0\.5\.0/)
  assert.match(text, /ask_user_question/)
  assert.match(text, /只提问，不擅自开工/)
})

test('renderTaskNudge marks ready tasks explicitly', () => {
  const text = renderTaskNudge({
    todos: { inProgress: [], pending: [] },
    teamTasks: [{ id: 'task-1', subject: '实现', status: 'pending', ready: true, blockedBy: [] }],
  })
  assert.match(text, /task-1 实现 \[可开始\]/)
})

test('renderTaskNudge emits a hint when the snapshot is empty', () => {
  const text = renderTaskNudge(undefined)
  assert.match(text, /没检测到未完成的待办/)
  assert.match(text, /ask_user_question/)
})

test('renderTaskNudge is empty when disabled and capped in size', () => {
  assert.equal(renderTaskNudge({ todos: { inProgress: [], pending: ['x'] } }, { enabled: false }), '')
  const huge = {
    todos: {
      inProgress: Array.from({ length: 20 }, (_unused, index) => `进行中任务${index}${'x'.repeat(100)}`),
      pending: Array.from({ length: 20 }, (_unused, index) => `待办任务${index}${'y'.repeat(100)}`),
    },
    teamTasks: [],
  }
  const text = renderTaskNudge(huge)
  assert.ok(text.length <= TASK_BLOCK_MAX_CHARS)
})

// ── prompt integration ─────────────────────────────────────────────────────

test('DEFAULT_PROMPT carries the task placeholder', () => {
  assert.ok(DEFAULT_PROMPT.includes(TASKS_PLACEHOLDER))
  // The ask rule lives in the task block, so turning taskNudge off leaves no
  // dangling instruction pointing at a snapshot that is not there.
  assert.doesNotMatch(DEFAULT_PROMPT, /ask_user_question/)
})

test('renderPrompt substitutes {{tasks}} in place', () => {
  const text = renderPrompt('before\n{{tasks}}\nafter', new Date('2026-08-18T12:00:00'), '【TASK BLOCK】')
  assert.match(text, /before\n【TASK BLOCK】\nafter/)
})

test('renderPrompt appends the block when the template has no placeholder', () => {
  const text = renderPrompt('只汇报', new Date('2026-08-18T12:00:00'), '【TASK BLOCK】')
  assert.match(text, /^只汇报\n\n【TASK BLOCK】$/)
})

test('renderPrompt drops the placeholder line when the block is empty', () => {
  const text = renderPrompt('a\n{{tasks}}\nb', new Date('2026-08-18T12:00:00'), '')
  assert.equal(text, 'a\nb')
})
