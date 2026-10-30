/**
 * Default heartbeat prompt and the settings-namespace identity.
 *
 * The prompt is delivered to the agent as a synthetic user-role message
 * (source kind `plugin:heartbeat`), so the client renders it as a collapsed
 * context chip instead of a full user bubble. Keep it dense: it is both the
 * model instruction and the visible transcript artifact.
 *
 * ## Task inspection (v0.5.0)
 *
 * `{{tasks}}` marks where the plugin's own session-task snapshot goes (see
 * `lib/tasks.js`). The heartbeat must not silently start work: when the
 * snapshot shows something actionable, the agent ASKS the user whether to act
 * now. Custom prompts keep working — a template without `{{tasks}}` gets the
 * block appended at the end.
 *
 * @module dsh-plugin-heartbeat/prompt
 */

export const SETTINGS_NAMESPACE = 'heartbeat'

/** Placeholder the plugin substitutes with the rendered task block. */
export const TASKS_PLACEHOLDER = '{{tasks}}'

export const DEFAULT_PROMPT = [
  '【心跳】由 heartbeat 插件定时唤醒，不是用户的消息。当前时间 {{time}}。',
  '轻量唤醒模式：不要调用任何工具，不要复盘全部历史，只基于最近对话快速判断。',
  '',
  TASKS_PLACEHOLDER,
  '',
  '然后选一种回应：',
  '1. 有实质进展、风险、卡点或新发现 → 简明汇报，先结论后细节；',
  '2. 有悬而未决、需要阿周拍板的 → 直接提问；',
  '3. 都没有 → 回一句简短的日常状态。',
  '要求：总长 ≤5 句，中文，小蓝口吻（外松内紧）；不主动开始新任务，不重复车轱辘话。',
].join('\n')

/**
 * Substitute supported placeholders in a prompt template.
 *
 * - `{{time}}`  → local timestamp
 * - `{{tasks}}` → the rendered task block; if the template has no placeholder
 *   and a block is supplied, the block is appended at the end.
 *
 * @param {string} template
 * @param {Date} [now]
 * @param {string} [taskBlock] rendered task inspection block (may be '')
 * @returns {string}
 */
export function renderPrompt(template, now = new Date(), taskBlock = '') {
  const time = now.toLocaleString('zh-CN', { hour12: false })
  const block = typeof taskBlock === 'string' ? taskBlock.trim() : ''
  const text = String(template ?? '').replaceAll('{{time}}', time)
  if (!text.includes(TASKS_PLACEHOLDER)) {
    if (block.length === 0) return text
    return `${text.trimEnd()}\n\n${block}`
  }
  // Drop the placeholder line cleanly when there is nothing to report.
  if (block.length === 0) {
    return text
      .split('\n')
      .filter((line) => line.trim() !== TASKS_PLACEHOLDER)
      .join('\n')
      .replaceAll(/\n{3,}/gu, '\n\n')
      .trim()
  }
  return text.replaceAll(TASKS_PLACEHOLDER, block)
}
