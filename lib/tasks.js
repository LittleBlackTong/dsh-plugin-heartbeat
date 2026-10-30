/**
 * Session task snapshot — read the current session's task state straight from
 * the host's session projections, so one heartbeat can nudge about real work
 * instead of guessing from the last few messages.
 *
 * ## Why projections (v0.5.0)
 *
 * A heartbeat is delivered after a pre-beat compaction folded the history into
 * a checkpoint summary; todos and board state may no longer be in the model's
 * context. The host keeps them independently as **session projections**
 * (`ctx.sessionProjections.stateOf(session, key)`, a synchronous read), so the
 * plugin can put a compact, always-current snapshot into the beat itself:
 *
 * - `todos`     — the agent's own list ({content, status}); completed rows are
 *                 dropped, `in_progress` and `pending` are kept;
 * - `agentTeam` — the shared task board of an Agent Team session
 *                 ({tasks: [{id, subject, status, blockedBy, …}]}); `ready`
 *                 is re-derived from blockers so the nudge can say which task
 *                 is actually unblocked;
 * - `goal`      — the persistent goal, when active (or blocked/paused, which
 *                 is exactly the "needs a human decision" case).
 *
 * Every read is defensive: a projection may be unregistered (no Agent Team
 * feature, no goal, older host), return `null`, or throw. A heartbeat must
 * never be dropped because a task lookup failed, so failures degrade to
 * "nothing to report".
 *
 * @module dsh-plugin-heartbeat/tasks
 */

/** Hard cap on the rendered snapshot block: this text is injected into every beat. */
export const TASK_BLOCK_MAX_CHARS = 800

/** Statuses worth surfacing: anything else (completed/deleted) is noise. */
const OPEN_STATUSES = new Set(['pending', 'in_progress'])

const GOAL_ATTENTION_PHASES = new Set(['active', 'blocked', 'paused'])

/**
 * Read one projection state without letting a missing/breaking projection
 * kill the beat.
 * @param {object | undefined} projections `ctx.sessionProjections`
 * @param {object | undefined} session the agent's Session
 * @param {string} key projection key
 * @returns {unknown} the projection state, or `undefined`
 */
export function readProjection(projections, session, key) {
  if (projections === undefined || projections === null) return undefined
  if (typeof projections.stateOf !== 'function') return undefined
  if (session === undefined || session === null) return undefined
  try {
    return projections.stateOf(session, key)
  } catch {
    return undefined
  }
}

/** Coerce unknown into a positive item cap with a small, token-safe ceiling. */
export function clampMaxItems(value, fallback = 5) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(20, Math.max(1, Math.trunc(number)))
}

/** Trim and clip one line of model-facing text. */
function clip(text, max) {
  const value = String(text ?? '').replaceAll(/\s+/gu, ' ').trim()
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value
}

/**
 * Fold the `todos` projection into open items.
 * @param {unknown} state `stateOf(session, 'todos')` → array | null
 * @returns {{ inProgress: string[], pending: string[] }}
 */
export function readTodos(state) {
  const result = { inProgress: [], pending: [] }
  if (!Array.isArray(state)) return result
  for (const item of state) {
    if (item === null || typeof item !== 'object') continue
    const status = item.status
    if (!OPEN_STATUSES.has(status)) continue
    const content = clip(item.content, 120)
    if (content.length === 0) continue
    if (status === 'in_progress') result.inProgress.push(content)
    else result.pending.push(content)
  }
  return result
}

/**
 * Fold the `agentTeam` projection (raw state or wire view) into open board
 * tasks, ready-first, with blockers resolved against the same snapshot.
 * @param {unknown} state `stateOf(session, 'agentTeam')` → {tasks: [...]} | undefined
 * @returns {Array<{id: string, subject: string, status: string, ready: boolean, blockedBy: string[]}>}
 */
export function readTeamTasks(state) {
  if (state === null || typeof state !== 'object') return []
  const rawTasks = Array.isArray(state.tasks) ? state.tasks : []
  const statusById = new Map()
  for (const task of rawTasks) {
    if (task === null || typeof task !== 'object') continue
    if (typeof task.id === 'string') statusById.set(task.id, task.status)
  }
  const open = []
  for (const task of rawTasks) {
    if (task === null || typeof task !== 'object') continue
    if (!OPEN_STATUSES.has(task.status)) continue
    if (typeof task.id !== 'string') continue
    const subject = clip(task.subject, 100) || task.id
    const blockedBy = Array.isArray(task.blockedBy)
      ? task.blockedBy.filter((id) => typeof id === 'string')
      : []
    // Mirror the host's readiness rule: a blocker counts as satisfied only
    // when the task it names is completed (missing/deleted blockers do not).
    const ready = task.status === 'pending'
      && blockedBy.every((id) => statusById.get(id) === 'completed')
    open.push({ id: task.id, subject, status: task.status, ready, blockedBy })
  }
  const rank = (task) => (task.ready ? 0 : task.status === 'in_progress' ? 1 : 2)
  open.sort((left, right) => rank(left) - rank(right))
  return open
}

/**
 * Fold the `goal` projection into an attention-worthy goal.
 * @param {unknown} state `stateOf(session, 'goal')` → {current: {goal, …} | null}
 * @returns {{ objective: string, phase: string } | undefined}
 */
export function readGoal(state) {
  if (state === null || typeof state !== 'object') return undefined
  const current = state.current
  if (current === null || typeof current !== 'object') return undefined
  const goal = current.goal
  if (goal === null || typeof goal !== 'object') return undefined
  if (!GOAL_ATTENTION_PHASES.has(goal.phase)) return undefined
  const objective = clip(goal.objective, 160)
  if (objective.length === 0) return undefined
  return { objective, phase: goal.phase }
}

/**
 * Collect everything the heartbeat should nudge about.
 *
 * @param {object} options
 * @param {object} [options.projections] `ctx.sessionProjections` (optional)
 * @param {object} [options.session] the agent's Session (optional)
 * @param {number} [options.maxItems] per-bucket item cap
 * @returns {{todos: {inProgress: string[], pending: string[]}, teamTasks: Array<object>, goal?: {objective: string, phase: string}} | undefined}
 *   `undefined` when nothing actionable was found or projections are unavailable.
 */
export function collectSessionTasks({ projections, session, maxItems } = {}) {
  const cap = clampMaxItems(maxItems)
  const todos = readTodos(readProjection(projections, session, 'todos'))
  const teamTasks = readTeamTasks(readProjection(projections, session, 'agentTeam')).slice(0, cap)
  const goal = readGoal(readProjection(projections, session, 'goal'))
  const hasTodos = todos.inProgress.length > 0 || todos.pending.length > 0
  if (!hasTodos && teamTasks.length === 0 && goal === undefined) return undefined
  return {
    todos: {
      inProgress: todos.inProgress.slice(0, cap),
      pending: todos.pending.slice(0, cap),
    },
    teamTasks,
    ...goal === undefined ? {} : { goal },
  }
}

/**
 * Render just the task snapshot (no instructions): what the session is holding
 * right now. Kept tiny — it rides on every heartbeat.
 *
 * @param {object | undefined} snapshot `collectSessionTasks()` result
 * @returns {string} snapshot block, empty string when there is nothing to show
 */
export function renderTaskSnapshot(snapshot) {
  const lines = ['【会话任务巡检】由 heartbeat 插件从会话投影读取，供你判断。']
  if (snapshot === undefined || snapshot === null) {
    lines.push('这一拍没检测到未完成的待办 / 团队任务 / 目标。')
    return capBlock(lines.join('\n'))
  }
  if (snapshot.todos.inProgress.length > 0) {
    lines.push(`- 进行中：${snapshot.todos.inProgress.join('；')}`)
  }
  if (snapshot.todos.pending.length > 0) {
    lines.push(`- 待办：${snapshot.todos.pending.join('；')}`)
  }
  if (snapshot.teamTasks.length > 0) {
    const tasks = snapshot.teamTasks.map((task) => {
      const state = task.status === 'in_progress'
        ? '进行中'
        : task.ready
          ? '可开始'
          : `被阻塞（${task.blockedBy.join('、') || '未知依赖'}）`
      return `${task.id} ${task.subject} [${state}]`
    })
    lines.push(`- 团队任务：${tasks.join('；')}`)
  }
  if (snapshot.goal !== undefined) {
    lines.push(`- 当前目标（${snapshot.goal.phase}）：${snapshot.goal.objective}`)
  }
  return capBlock(lines.join('\n'))
}

/** Cap the block to the injected-size budget. */
function capBlock(text) {
  return text.length > TASK_BLOCK_MAX_CHARS
    ? `${text.slice(0, TASK_BLOCK_MAX_CHARS - 1)}…`
    : text
}

/**
 * Render the task block **with** the "ask before you act" instruction.
 *
 * Kept for the v0.5.x message format and for callers that want a self-contained
 * nudge; v0.6 composes the instruction per activation level instead, so it uses
 * `renderTaskSnapshot()`.
 *
 * @param {object | undefined} snapshot `collectSessionTasks()` result
 * @param {object} [options]
 * @param {boolean} [options.enabled] task nudging master switch
 * @returns {string}
 */
export function renderTaskNudge(snapshot, { enabled = true } = {}) {
  if (enabled === false) return ''
  const instruction = '唯一允许的工具调用：ask_user_question（不可用就直接在回复里问）。有发现 → 问阿周「现在要不要我主动做」：最多 3 条、每条一句建议；只提问，不擅自开工。'
  return capBlock(`${renderTaskSnapshot(snapshot)}\n${instruction}`)
}
