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
 * `{{reason}}` / `{{physiology}}` are substituted, and missing placeholders get
 * the blocks appended.
 *
 * ## v0.7 physiology line
 *
 * L1/L2/L4 templates carry an optional one-line physiology signature right
 * after the why-now line (rendered by `lib/physiology.js`; empty hides it).
 * At night the why-now wording is calmer and shorter — a late ping should feel
 * lighter, never cutesy.
 *
 * @module dsh-plugin-heartbeat/prompt
 */

import { daypartOf } from './physiology.js'

export const SETTINGS_NAMESPACE = 'heartbeat'

/** Placeholder the plugin substitutes with the rendered task snapshot. */
export const TASKS_PLACEHOLDER = '{{tasks}}'

/** Placeholder the plugin substitutes with the one-line reason. */
export const REASON_PLACEHOLDER = '{{reason}}'

/** Placeholder the plugin substitutes with the physiology line (v0.7). */
export const PHYSIOLOGY_PLACEHOLDER = '{{physiology}}'

const REQUIREMENTS = '要求：总长 ≤5 句，中文，小蓝口吻（外松内紧）；不主动开始新任务，不重复车轱辘话。'

const HEAD = '【心跳】由 heartbeat 插件定时唤醒，不是用户的消息。当前时间 {{time}}。'

/** Daytime why-now line; the night variant is shorter and calmer. */
export const WHY_NOW_LINE = '为什么现在叫你：{{reason}}'

/** Night why-now line: same information, lighter tone. */
export const NIGHT_WHY_NOW_LINE = '为什么现在叫你（夜里，简短说）：{{reason}}'

/** Built-in templates per activation level. */
export const DEFAULT_LEVEL_PROMPTS = {
  L1: [
    HEAD,
    WHY_NOW_LINE,
    PHYSIOLOGY_PLACEHOLDER,
    '',
    TASKS_PLACEHOLDER,
    '',
    '轻量唤醒模式：不要调用工具，不要复盘全部历史；汇报实质进展、风险、卡点或新发现，先结论后细节；没有实质内容就用一句话带过。',
    REQUIREMENTS,
  ].join('\n'),
  L2: [
    HEAD,
    WHY_NOW_LINE,
    PHYSIOLOGY_PLACEHOLDER,
    '',
    TASKS_PLACEHOLDER,
    '',
    '这一拍需要阿周做决定。唯一允许的工具调用：ask_user_question（不可用就直接在回复里问）。',
    '问法：最多 3 条、每条一句建议，明确「现在要不要我主动做」；只提问，不擅自开工。',
    REQUIREMENTS,
  ].join('\n'),
  L4: [
    HEAD,
    WHY_NOW_LINE,
    PHYSIOLOGY_PLACEHOLDER,
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

/** Remove a standalone placeholder line (and collapse the gap) when value is empty. */
function dropPlaceholderLine(text, placeholder) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== placeholder)
    .join('\n')
    .replaceAll(/\n{3,}/gu, '\n\n')
    .trim()
}

/**
 * Substitute placeholders in a custom prompt template.
 *
 * @param {string} template
 * @param {Date} [now]
 * @param {string} [taskBlock] rendered task snapshot (may be '')
 * @param {string} [reason] one-line "why now" explanation
 * @param {string} [physiology] rendered physiology line (may be '', v0.7)
 * @returns {string}
 */
export function renderPrompt(template, now = new Date(), taskBlock = '', reason = '', physiology = '') {
  const time = now.toLocaleString('zh-CN', { hour12: false })
  const block = typeof taskBlock === 'string' ? taskBlock.trim() : ''
  const why = typeof reason === 'string' ? reason.trim() : ''
  const signature = typeof physiology === 'string' ? physiology.trim() : ''
  const source = String(template ?? '')
  let text = source
    .replaceAll('{{time}}', time)
    .replaceAll(REASON_PLACEHOLDER, why)

  if (source.includes(PHYSIOLOGY_PLACEHOLDER)) {
    text = signature.length === 0
      ? dropPlaceholderLine(text, PHYSIOLOGY_PLACEHOLDER)
      : text.replaceAll(PHYSIOLOGY_PLACEHOLDER, signature)
  }

  if (text.includes(TASKS_PLACEHOLDER)) {
    text = block.length === 0
      ? dropPlaceholderLine(text, TASKS_PLACEHOLDER)
      : text.replaceAll(TASKS_PLACEHOLDER, block)
  } else if (block.length > 0) {
    text = `${text.trimEnd()}\n\n${block}`
  }

  if (why.length > 0 && !source.includes(REASON_PLACEHOLDER)) {
    text = `${text.trimEnd()}\n\n为什么现在叫你：${why}`
  }
  // Custom prompts that do not place {{physiology}} get the line at the end.
  if (signature.length > 0 && !source.includes(PHYSIOLOGY_PLACEHOLDER)) {
    text = `${text.trimEnd()}\n\n${signature}`
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
 * @param {string} [options.physiology] rendered physiology line (v0.7, may be '')
 * @param {boolean} [options.physiologyLine] config switch (default true)
 * @param {'morning'|'afternoon'|'evening'|'night'} [options.daypart] override (default: from `now`)
 * @returns {string}
 */
export function renderHeartbeatText({
  prompt = null,
  now = new Date(),
  taskBlock = '',
  reason = '',
  level = 'L1',
  l3Allow = [],
  physiology = '',
  physiologyLine = true,
  daypart,
} = {}) {
  const custom = typeof prompt === 'string' && prompt.length > 0
  const date = now instanceof Date ? now : new Date(now)
  const part = daypart ?? daypartOf(date)
  let template = custom ? prompt : (DEFAULT_LEVEL_PROMPTS[level] ?? DEFAULT_LEVEL_PROMPTS.L1)
  // Night: built-in templates only; a user's custom wording is left alone.
  if (!custom && part === 'night') template = template.replace(WHY_NOW_LINE, NIGHT_WHY_NOW_LINE)
  const signature = physiologyLine === false
    ? ''
    : (typeof physiology === 'string' ? physiology.trim() : '')
  const text = renderPrompt(template, date, taskBlock, reason, signature)
  const note = level === 'L1' || level === 'L0' ? '' : l3Note(l3Allow)
  return note.length === 0 ? text : `${text}\n${note}`
}
