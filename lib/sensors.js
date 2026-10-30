/**
 * Sensors — the heartbeat's "interoception".
 *
 * Every pulse reads the session's public projections (cheap, synchronous,
 * read-only) and diffs them against what it saw last time. Only *changes* become
 * signals: a task that became ready, one that became blocked, the goal slipping
 * to `blocked`, a pending user question. Repeating the same todos on every beat
 * is exactly the noise v0.6 exists to remove.
 *
 * This module is deliberately pure host-side logic: it never injects messages
 * and never opens a turn. `lib/gate.js` decides what a signal list means;
 * `lib/runtime.js` owns the timer and the delivery.
 *
 * @module dsh-plugin-heartbeat/sensors
 */

import { readProjection } from './tasks.js'

/** Signal weights feed the arousal score (spec §4.1). */
export const SIGNAL_WEIGHTS = {
  'team-ready': 5,
  'team-blocked': 4,
  'team-completed': 1,
  todos: 2,
  goal: 4,
  question: 3,
}

const OPEN_STATUSES = new Set(['pending', 'in_progress'])

/** FNV-1a 32-bit — stable short fingerprints for dedupe/seen signatures. */
export function hashText(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Clip a signal line so pulses stay small. */
function clip(text, max = 80) {
  const value = String(text ?? '').replaceAll(/\s+/gu, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/**
 * Build stable signatures for the four observed projections.
 * @param {{todos: unknown, team: unknown, goal: unknown, questions: unknown}} parts
 * @returns {{todos: string, team: string, goal: string, questions: string}}
 */
export function signatureOf({ todos, team, goal, questions }) {
  const openTodos = Array.isArray(todos)
    ? todos
      .filter((item) => item !== null && typeof item === 'object' && OPEN_STATUSES.has(item.status))
      .map((item) => `${item.status}:${clip(item.content, 200)}`)
      .sort()
    : []
  const teamMap = teamSnapshotOf(team)
  const goalKey = goal !== null && typeof goal === 'object' && goal.current !== null
    ? `${goal.current?.goal?.id ?? 'goal'}:${goal.current?.goal?.phase ?? 'unknown'}`
    : ''
  const activeIds = activeQuestionIds(questions)
  return {
    todos: hashText(openTodos.join('|')),
    // The team/vision diffs need the previous entries, not just a digest.
    team: JSON.stringify(teamMap),
    goal: goalKey,
    questions: activeIds.join('|'),
  }
}

/** Normalize the team board state into `{id: {status, ready, subject, blockedBy}}`. */
export function teamSnapshotOf(team) {
  if (team === null || typeof team !== 'object' || !Array.isArray(team.tasks)) return {}
  const statusById = new Map()
  for (const task of team.tasks) {
    if (task !== null && typeof task === 'object' && typeof task.id === 'string') statusById.set(task.id, task.status)
  }
  const snapshot = {}
  for (const task of team.tasks) {
    if (Object.keys(snapshot).length >= 200) break // bound the persisted seen map
    if (task === null || typeof task !== 'object' || typeof task.id !== 'string') continue
    const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy.filter((id) => typeof id === 'string') : []
    snapshot[task.id] = {
      status: task.status,
      ready: task.status === 'pending' && blockedBy.every((id) => statusById.get(id) === 'completed'),
      subject: clip(task.subject, 60),
      blockedBy,
    }
  }
  return snapshot
}

/** Active (unanswered) question call ids from the `userQuestions` projection state. */
export function activeQuestionIds(state) {
  const active = state?.questions?.active
  if (!Array.isArray(active)) return []
  return active
    .map((entry, index) => (typeof entry?.callId === 'string' ? entry.callId : `q${index}`))
    .sort()
}

/** Active question payloads (for signal text). */
function activeQuestions(state) {
  const active = state?.questions?.active
  if (!Array.isArray(active)) return []
  return Array.isArray(active) ? active : []
}

/**
 * Collect signals for one session by diffing projections against `seen`.
 *
 * @param {object} options
 * @param {object} [options.projections] `ctx.sessionProjections`
 * @param {object} [options.session] the agent's Session
 * @param {object} options.vitals vitals store (`get(sessionId)` returns `seen`)
 * @param {string} options.sessionId
 * @param {number} [options.pressure] context pressure 0..1 (host `contextPressure`)
 * @returns {{signals: Array<object>, arousal: number, seen: object, pressure: number|undefined}}
 */
export function collectSignals({ projections, session, vitals, sessionId, pressure } = {}) {
  const todos = readProjection(projections, session, 'todos')
  const team = readProjection(projections, session, 'agentTeam')
  const goal = readProjection(projections, session, 'goal')
  const questions = readProjection(projections, session, 'userQuestions')
  const seen = signatureOf({ todos, team, goal, questions })
  const previous = vitals?.get(sessionId)?.seen ?? {}
  const signals = []

  // ── team board diff ────────────────────────────────────────────────────
  const currentTeam = teamSnapshotOf(team)
  let previousTeam = {}
  try {
    previousTeam = typeof previous.team === 'string' ? JSON.parse(previous.team) : (previous.team ?? {})
  } catch {
    previousTeam = {}
  }
  for (const [id, task] of Object.entries(currentTeam)) {
    const previousTask = previousTeam[id]
    const wasReady = previousTask?.ready === true
    if (task.status === 'pending' && task.ready && !wasReady) {
      signals.push({
        kind: 'team-ready',
        key: `team:${id}:ready`,
        weight: SIGNAL_WEIGHTS['team-ready'],
        text: `团队任务 ${id} 可开始了：${task.subject}`,
      })
    } else if (task.status === 'pending' && !task.ready && (previousTask === undefined || previousTask.ready === true)) {
      signals.push({
        kind: 'team-blocked',
        key: `team:${id}:blocked`,
        weight: SIGNAL_WEIGHTS['team-blocked'],
        text: `团队任务 ${id} 被阻塞（${task.blockedBy.join('、') || '未知依赖'}）：${task.subject}`,
      })
    }
  }
  for (const [id, task] of Object.entries(previousTeam)) {
    if (OPEN_STATUSES.has(task?.status) && currentTeam[id]?.status === 'completed') {
      signals.push({
        kind: 'team-completed',
        key: `team:${id}:done`,
        weight: SIGNAL_WEIGHTS['team-completed'],
        text: `团队任务 ${id} 完成了：${task.subject ?? id}`,
      })
    }
  }

  // ── todos diff ─────────────────────────────────────────────────────────
  if (seen.todos !== previous.todos) {
    const openCount = Array.isArray(todos)
      ? todos.filter((item) => item !== null && typeof item === 'object' && OPEN_STATUSES.has(item.status)).length
      : 0
    if (openCount > 0) {
      signals.push({
        kind: 'todos',
        key: `todos:${seen.todos}`,
        weight: SIGNAL_WEIGHTS.todos,
        text: `会话待办有变化（${openCount} 项未完成）`,
      })
    }
  }

  // ── goal diff ──────────────────────────────────────────────────────────
  if (seen.goal !== previous.goal) {
    const current = goal?.current
    const phase = current?.goal?.phase
    if (phase === 'blocked' || phase === 'paused') {
      signals.push({
        kind: 'goal',
        key: `goal:${current.goal.id}:${phase}`,
        weight: SIGNAL_WEIGHTS.goal,
        text: `目标${phase === 'blocked' ? '受阻' : '暂停'}：${clip(current.goal.objective, 60)}`,
      })
    } else if (phase === 'active' && previous.goal !== undefined) {
      signals.push({
        kind: 'goal',
        key: `goal:${current.goal.id}:active`,
        weight: SIGNAL_WEIGHTS.todos,
        text: `目标推进中：${clip(current.goal.objective, 60)}`,
      })
    }
  }

  // ── pending questions ──────────────────────────────────────────────────
  const currentQuestionIds = activeQuestionIds(questions)
  let previousQuestionIds = []
  try {
    previousQuestionIds = typeof previous.questions === 'string' ? previous.questions.split('|').filter(Boolean) : []
  } catch {
    previousQuestionIds = []
  }
  for (const entry of activeQuestions(questions)) {
    const callId = typeof entry?.callId === 'string' ? entry.callId : undefined
    if (callId === undefined) continue
    if (previousQuestionIds.includes(callId)) continue
    const first = entry?.questions?.[0]?.question
    signals.push({
      kind: 'question',
      key: `question:${callId}`,
      weight: SIGNAL_WEIGHTS.question,
      text: `有未回答的提问${typeof first === 'string' ? `：${clip(first, 60)}` : ''}`,
    })
  }

  const arousal = signals.reduce((sum, signal) => sum + signal.weight, 0)
  return {
    signals,
    arousal: Math.min(8, arousal),
    seen,
    pressure: typeof pressure === 'number' ? pressure : undefined,
  }
}
