/**
 * Physiology line injection (v0.7): level templates (L1/L2/L4), the optional
 * `{{physiology}}` placeholder, and the lighter night wording.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_LEVEL_PROMPTS,
  PHYSIOLOGY_PLACEHOLDER,
  renderHeartbeatText,
} from '../lib/prompt.js'

const DAY = new Date('2026-10-30T14:00:00')
const NIGHT = new Date('2026-10-30T02:00:00')
const TASK_BLOCK = '【会话任务巡检】\n- 待办：补测试'
const REASON = '团队任务 task-3 可开始了：发布'
const PHYSIOLOGY = '〔状态：距你上次说话 2h · 今天第 3 次找你〕'

test('built-in templates expose the physiology placeholder', () => {
  for (const level of ['L1', 'L2', 'L4']) {
    assert.ok(DEFAULT_LEVEL_PROMPTS[level].includes(PHYSIOLOGY_PLACEHOLDER), `${level} carries the placeholder`)
  }
})

test('L1/L2/L4 render the physiology line right after the why-now line', () => {
  for (const level of ['L1', 'L2', 'L4']) {
    const text = renderHeartbeatText({
      now: DAY,
      taskBlock: TASK_BLOCK,
      reason: REASON,
      level,
      physiology: PHYSIOLOGY,
    })
    assert.match(text, /为什么现在叫你：团队任务 task-3 可开始了：发布/)
    const whyIndex = text.indexOf('为什么现在叫你')
    const physiologyIndex = text.indexOf(PHYSIOLOGY)
    assert.ok(physiologyIndex > whyIndex, `${level} puts the line after why-now`)
    assert.ok(!text.includes(PHYSIOLOGY_PLACEHOLDER), `${level} placeholder is substituted`)
    assert.ok(text.indexOf('【会话任务巡检】') > physiologyIndex, `${level} keeps the task block after it`)
  }
})

test('no physiology (or the config switch off) leaves no empty line or placeholder', () => {
  const empty = renderHeartbeatText({ now: DAY, taskBlock: TASK_BLOCK, reason: REASON, level: 'L1' })
  assert.ok(!empty.includes(PHYSIOLOGY_PLACEHOLDER))
  assert.ok(!/\n{3,}/u.test(empty), 'empty placeholder lines collapse cleanly')
  const off = renderHeartbeatText({ now: DAY, taskBlock: TASK_BLOCK, reason: REASON, level: 'L2', physiology: PHYSIOLOGY, physiologyLine: false })
  assert.ok(!off.includes(PHYSIOLOGY))
  assert.match(off, /ask_user_question/)
})

test('custom prompts substitute {{physiology}} where the user placed it', () => {
  const text = renderHeartbeatText({
    now: DAY,
    taskBlock: TASK_BLOCK,
    reason: REASON,
    level: 'L2',
    prompt: `时间 {{time}}\n原因 {{reason}}\n${PHYSIOLOGY_PLACEHOLDER}\n自定义要求`,
    physiology: PHYSIOLOGY,
  })
  assert.ok(text.includes(PHYSIOLOGY))
  assert.ok(text.indexOf(PHYSIOLOGY) < text.indexOf('自定义要求'))
  assert.ok(!text.includes(PHYSIOLOGY_PLACEHOLDER))
})

test('custom prompts without the placeholder get the line appended last', () => {
  const text = renderHeartbeatText({ now: DAY, taskBlock: '', reason: REASON, level: 'L1', prompt: '只汇报', physiology: PHYSIOLOGY })
  assert.ok(text.startsWith('只汇报'))
  assert.ok(text.endsWith(PHYSIOLOGY), 'appended at the very end')
})

test('night keeps the why-now line but says it more gently', () => {
  const day = renderHeartbeatText({ now: DAY, taskBlock: '', reason: REASON, level: 'L1' })
  const night = renderHeartbeatText({ now: NIGHT, taskBlock: '', reason: REASON, level: 'L1' })
  assert.match(day, /为什么现在叫你：/)
  assert.match(night, /为什么现在叫你（夜里，简短说）：/)
  assert.notEqual(night, day)
  assert.doesNotMatch(night, /呀|嘛|啦|哦|~/u, 'no cutesy particles at night')
})
