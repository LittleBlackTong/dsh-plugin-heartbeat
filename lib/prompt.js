/**
 * Prompt composition — level-aware heartbeat messages.
 *
 * v0.6 separates the *snapshot* (what the session holds) from the *activation*
 * (why the heartbeat is opening a turn and what it may do):
 *
 * - L1 report: no tools, report progress/risk;
 * - L2 ask: the only tool call allowed is `ask_user_question`, ask before acting;
 * - L4 escalate: same ask, but state that it was already asked and stayed unanswered.
 *
 * Custom prompts (`config.prompt`) keep working: `{{time}}` / `{{tasks}}` /
 * `{{reason}}` are substituted, and missing placeholders get the blocks appended.
 *
 * @module dsh-plugin-heartbeat/prompt
 */

export const SETTINGS_NAMESPACE = 'heartbeat'

/** Placeholder the plugin substitutes with the rendered task snapshot. */
export const TASKS_PLACEHOLDER = '{{tasks}}'

/** Placeholder the plugin substitutes with the one-line reason. */
export const REASON_PLACEHOLDER = '{{reason}}'

const REQUIREMENTS = '要求：总长 ≤5 句，中文，小蓝口吻（外松内紧）；不主动开始新任务，不重复车轱辘话。'

const HEAD = '【心跳】由 heartbeat 插件定时唤醒，不是用户的消息。当前时间 {{time}}。'

/** Built-in templates per activation level. */
export const DEFAULT_LEVEL_PROMPTS = {
  L1: [
    HEAD,
    '为什么现在叫你：{{reason}}',
    '',
    TASKS_PLACEHOLDER,
    '',
    '轻量唤醒模式：不要调用工具，不要复盘全部历史；汇报实质进展、风险、卡点或新发现，先结论后细节；没有实质内容就用一句话带过。',
    REQUIREMENTS,
  ].join('\n'),
  L2: [
    HEAD,
    '为什么现在叫你：{{reason}}',
    '',
    TASKS_PLACEHOLDER,
    '',
    '这一拍需要阿周做决定。唯一允许的工具调用：ask_user_question（不可用就直接在回复里问）。',
    '问法：最多 3 条、每条一句建议，明确「现在要不要我主动做」；只提问，不擅自开工。',
    REQUIREMENTS,
  ].join('\n'),
  L4: [
    HEAD,
    '为什么现在叫你：{{reason}}',
    '',
    TASKS_PLACEHOLDER,
    '',
    '这件事之前已经提醒过但还没有回应，这是升级提醒（不是新任务）。',
    '唯一允许的工具调用：ask_user_question（不可用就直接在回复里问）。用一句话点明「仍然在等你的决定」，最多 3 条选项；只提问，不擅自开工。',
    REQUIREMENTS,
  ].join('\n'),
}

/** Backwards-compatible default prompt (L1 shape). */
export const DEFAULT_PROMPT = DEFAULT_LEVEL_PROMPTS.L1

/** Append the L3 authorization sentence only when the user actually granted it. */
function l3Note(l3Allow) {
  if (!Array.isArray(l3Allow) || l3Allow.length === 0) return ''
  return `已授权类别（这些可自行推进，不必先问）：${l3Allow.join(' / ')}；其余一切仍然只问不做。`
}

/**
 * Substitute placeholders in a custom prompt template.
 *
 * @param {string} template
 * @param {Date} [now]
 * @param {string} [taskBlock] rendered task snapshot (may be '')
 * @param {string} [reason] one-line "why now" explanation
 * @returns {string}
 */
export function renderPrompt(template, now = new Date(), taskBlock = '', reason = '') {
  const time = now.toLocaleString('zh-CN', { hour12: false })
  const block = typeof taskBlock === 'string' ? taskBlock.trim() : ''
  const why = typeof reason === 'string' ? reason.trim() : ''
  let text = String(template ?? '')
    .replaceAll('{{time}}', time)
    .replaceAll(REASON_PLACEHOLDER, why)

  if (text.includes(TASKS_PLACEHOLDER)) {
    text = block.length === 0
      ? text
        .split('\n')
        .filter((line) => line.trim() !== TASKS_PLACEHOLDER)
        .join('\n')
        .replaceAll(/\n{3,}/gu, '\n\n')
        .trim()
      : text.replaceAll(TASKS_PLACEHOLDER, block)
  } else if (block.length > 0) {
    text = `${text.trimEnd()}\n\n${block}`
  }

  if (why.length > 0 && !String(template ?? '').includes(REASON_PLACEHOLDER)) {
    text = `${text.trimEnd()}\n\n为什么现在叫你：${why}`
  }
  return text
}

/**
 * Compose the heartbeat message text for one activation.
 *
 * @param {object} options
 * @param {string | null} [options.prompt] custom template (composition config)
 * @param {Date} [options.now]
 * @param {string} [options.taskBlock] rendered snapshot (may be '')
 * @param {string} [options.reason] why-now line
 * @param {'L1'|'L2'|'L4'} [options.level]
 * @param {string[]} [options.l3Allow] granted L3 categories
 * @returns {string}
 */
export function renderHeartbeatText({
  prompt = null,
  now = new Date(),
  taskBlock = '',
  reason = '',
  level = 'L1',
  l3Allow = [],
} = {}) {
  const template = typeof prompt === 'string' && prompt.length > 0
    ? prompt
    : (DEFAULT_LEVEL_PROMPTS[level] ?? DEFAULT_LEVEL_PROMPTS.L1)
  const text = renderPrompt(template, now, taskBlock, reason)
  const note = level === 'L1' || level === 'L0' ? '' : l3Note(l3Allow)
  return note.length === 0 ? text : `${text}\n${note}`
}
