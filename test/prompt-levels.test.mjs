/**
 * Level-aware message composition tests.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_LEVEL_PROMPTS,
  REASON_PLACEHOLDER,
  TASKS_PLACEHOLDER,
  renderHeartbeatText,
  renderPrompt,
} from '../lib/prompt.js'

const NOW = new Date('2026-10-30T14:00:00')
const TASK_BLOCK = '【会话任务巡检】\n- 待办：补测试'
const REASON = '团队任务 task-3 可开始了：发布'

test('L1 reports without asking and carries the why-now line', () => {
  const text = renderHeartbeatText({ now: NOW, taskBlock: TASK_BLOCK, reason: REASON, level: 'L1' })
  assert.match(text, /为什么现在叫你：团队任务 task-3 可开始了：发布/)
  assert.match(text, /待办：补测试/)
  assert.doesNotMatch(text, /ask_user_question/)
  assert.match(text, /≤5 句/)
})

test('L2 asks via ask_user_question and keeps the why-now line', () => {
  const text = renderHeartbeatText({ now: NOW, taskBlock: TASK_BLOCK, reason: REASON, level: 'L2' })
  assert.match(text, /ask_user_question/)
  assert.match(text, /只提问，不擅自开工/)
  assert.match(text, /为什么现在叫你/)
})

test('L4 marks the beat as an escalation', () => {
  const text = renderHeartbeatText({ now: NOW, taskBlock: TASK_BLOCK, reason: REASON, level: 'L4' })
  assert.match(text, /升级提醒/)
  assert.match(text, /ask_user_question/)
})

test('L3 authorization note appears only when categories are granted and only for L2/L4', () => {
  const withL3 = renderHeartbeatText({ now: NOW, taskBlock: TASK_BLOCK, reason: REASON, level: 'L2', l3Allow: ['read', 'test'] })
  assert.match(withL3, /已授权类别/)
  assert.match(withL3, /read \/ test/)
  const withoutL3 = renderHeartbeatText({ now: NOW, taskBlock: TASK_BLOCK, reason: REASON, level: 'L2', l3Allow: [] })
  assert.doesNotMatch(withoutL3, /已授权类别/)
  const reportL3 = renderHeartbeatText({ now: NOW, taskBlock: TASK_BLOCK, reason: REASON, level: 'L1', l3Allow: ['read'] })
  assert.doesNotMatch(reportL3, /已授权类别/, 'L1 never announces authorization')
})

test('custom prompts keep their placeholders', () => {
  const text = renderHeartbeatText({
    now: NOW,
    taskBlock: TASK_BLOCK,
    reason: REASON,
    level: 'L2',
    prompt: '时间 {{time}}\n原因 {{reason}}\n{{tasks}}\n自定义要求',
  })
  assert.match(text, /原因 团队任务 task-3 可开始了：发布/)
  assert.match(text, /待办：补测试/)
  assert.match(text, /自定义要求/)
  assert.doesNotMatch(text, /为什么现在叫你/, 'custom prompts are not force-annotated')
})

test('custom prompts without placeholders get task block and reason appended', () => {
  const text = renderHeartbeatText({ now: NOW, taskBlock: TASK_BLOCK, reason: REASON, level: 'L1', prompt: '只汇报' })
  assert.match(text, /^只汇报/)
  assert.match(text, /【会话任务巡检】/)
  assert.match(text, /为什么现在叫你：/)
})

test('empty blocks collapse cleanly', () => {
  const text = renderHeartbeatText({ now: NOW, taskBlock: '', reason: '', level: 'L1' })
  assert.doesNotMatch(text, /\{\{tasks\}\}/)
  assert.ok(!/\n{3,}/u.test(text))
})

test('renderPrompt still substitutes {{time}} alone (v0.5 compatibility)', () => {
  const text = renderPrompt('now: {{time}}', NOW)
  assert.equal(text, 'now: 2026/10/30 14:00:00')
})

test('templates expose the documented placeholders', () => {
  for (const level of ['L1', 'L2', 'L4']) {
    assert.ok(DEFAULT_LEVEL_PROMPTS[level].includes(TASKS_PLACEHOLDER), `${level} has tasks placeholder`)
    assert.ok(DEFAULT_LEVEL_PROMPTS[level].includes(REASON_PLACEHOLDER), `${level} has reason placeholder`)
  }
})
