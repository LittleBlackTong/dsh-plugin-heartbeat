/**
 * Physiology line (v0.7): one short expressive status line describing the
 * heartbeat's sense of the user's recent rhythm.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  daypartOf,
  MAX_PHYSIOLOGY_LENGTH,
  renderPhysiology,
} from '../lib/physiology.js'

const NOW = new Date('2026-10-30T14:00:00').getTime()

test('no data renders nothing', () => {
  assert.equal(renderPhysiology({ now: NOW }), '')
  assert.equal(renderPhysiology({ now: NOW, lastUserMessageAt: 0, lastTurnEndAt: 0, lastDeliveredAt: 0 }), '')
})

test('a fresh user message hides the line (<20min)', () => {
  assert.equal(renderPhysiology({ now: NOW, lastUserMessageAt: NOW - 5 * 60_000, daypart: 'afternoon' }), '')
  assert.equal(renderPhysiology({ now: NOW, lastUserMessageAt: NOW - 19 * 60_000, daypart: 'afternoon' }), '')
  assert.notEqual(renderPhysiology({ now: NOW, lastUserMessageAt: NOW - 21 * 60_000, daypart: 'afternoon' }), '')
})

test('afternoon line reports silence and the count of today\'s beats', () => {
  const line = renderPhysiology({
    now: NOW,
    lastUserMessageAt: NOW - 2 * 3_600_000,
    deliveredToday: 2,
    daypart: 'afternoon',
  })
  assert.equal(line, '〔状态：距你上次说话 2h · 今天第 3 次找你〕')
})

test('without a delivered count the line only reports distance', () => {
  const line = renderPhysiology({ now: NOW, lastUserMessageAt: NOW - 45 * 60_000, daypart: 'morning' })
  assert.equal(line, '〔早上好：距你上次说话 45min〕')
  assert.doesNotMatch(line, /今天第/)
  const evening = renderPhysiology({ now: NOW, lastUserMessageAt: NOW - 2 * 24 * 3_600_000, daypart: 'evening' })
  assert.equal(evening, '〔傍晚了：距你上次说话 2天〕')
})

test('night wording is shorter and softer, without the beat counter', () => {
  const night = renderPhysiology({ now: NOW, lastUserMessageAt: NOW - 3 * 3_600_000, deliveredToday: 1, daypart: 'night' })
  const afternoon = renderPhysiology({ now: NOW, lastUserMessageAt: NOW - 3 * 3_600_000, deliveredToday: 1, daypart: 'afternoon' })
  assert.equal(night, '〔夜深了，距你上次说话 3h〕')
  assert.notEqual(night, afternoon)
  assert.ok(night.length <= afternoon.length)
  assert.doesNotMatch(night, /今天第/)
  assert.doesNotMatch(night, /呀|嘛|啦|哦|~/u, 'night wording stays plain, not cutesy')
})

test('a recorded turn end anchors the age when no user message is known', () => {
  const line = renderPhysiology({ now: NOW, lastTurnEndAt: NOW - 2 * 3_600_000, daypart: 'afternoon' })
  assert.equal(line, '〔状态：距你上次收工 2h〕')
  // A fresh turn end is still "the user is around": hide it.
  assert.equal(renderPhysiology({ now: NOW, lastTurnEndAt: NOW - 60_000, daypart: 'afternoon' }), '')
})

test('a user message wins over a turn end as the anchor', () => {
  const line = renderPhysiology({
    now: NOW,
    lastUserMessageAt: NOW - 3 * 3_600_000,
    lastTurnEndAt: NOW - 2 * 3_600_000,
    daypart: 'afternoon',
  })
  assert.equal(line, '〔状态：距你上次说话 3h〕')
})

test('daypartOf maps the local clock into four parts of the day', () => {
  assert.equal(daypartOf(new Date('2026-10-30T05:00:00')), 'morning')
  assert.equal(daypartOf(new Date('2026-10-30T10:59:00')), 'morning')
  assert.equal(daypartOf(new Date('2026-10-30T11:00:00')), 'afternoon')
  assert.equal(daypartOf(new Date('2026-10-30T16:59:00')), 'afternoon')
  assert.equal(daypartOf(new Date('2026-10-30T17:00:00')), 'evening')
  assert.equal(daypartOf(new Date('2026-10-30T22:59:00')), 'evening')
  assert.equal(daypartOf(new Date('2026-10-30T23:00:00')), 'night')
  assert.equal(daypartOf(new Date('2026-10-30T04:59:00')), 'night')
})

test('the rendered line always fits the 60-character budget', () => {
  const line = renderPhysiology({
    now: NOW,
    lastUserMessageAt: NOW - 30 * 24 * 3_600_000,
    deliveredToday: 9,
    daypart: 'afternoon',
  })
  assert.ok(line.length <= MAX_PHYSIOLOGY_LENGTH)
  assert.ok(line.startsWith('〔') && line.endsWith('〕'))
})
