/**
 * 设置侧栏标记（导航图标）单测：爱心轮廓 + 认领规则 + mask 样式。
 *
 * 与 dsh-plugin-memory/test/settings-nav-icon.test.mjs 同构；两边图标规格必须
 * 保持一致（16×16 网格 / stroke 1.3 / 纯黑 alpha），这组用例就是那条约束。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isOwnNavRow,
  navIconCss,
  heartMaskUrl,
  heartSvg,
  HEART_PATH,
  HEARTBEAT_SECTION_LABEL,
  ICON_MEDIUM_STROKE,
  NAV_ICON_ATTR,
  NAV_ROW_SELECTOR,
} from '../lib/settings-nav-icon.js'

// ── isOwnNavRow: the only decision this feature makes ──────────────────────

test('isOwnNavRow claims the row whose text is exactly our label', () => {
  assert.equal(isOwnNavRow('Heartbeat', HEARTBEAT_SECTION_LABEL), true)
  assert.equal(isOwnNavRow('  Heartbeat  ', HEARTBEAT_SECTION_LABEL), true, 'surrounding whitespace is trimmed')
})

test('isOwnNavRow refuses anything that is not an exact match', () => {
  assert.equal(isOwnNavRow('心跳 Heartbeat', HEARTBEAT_SECTION_LABEL), false, 'the retired bilingual label must not match')
  assert.equal(isOwnNavRow('Heartbeat options', HEARTBEAT_SECTION_LABEL), false, 'a longer label is a different section')
  assert.equal(isOwnNavRow('Memory', HEARTBEAT_SECTION_LABEL), false)
})

test('isOwnNavRow refuses an unresolved label', () => {
  assert.equal(isOwnNavRow('Heartbeat', ''), false)
  assert.equal(isOwnNavRow('Heartbeat', '   '), false)
  assert.equal(isOwnNavRow('Heartbeat', undefined), false)
  assert.equal(isOwnNavRow(null, HEARTBEAT_SECTION_LABEL), false)
  assert.equal(isOwnNavRow(undefined, HEARTBEAT_SECTION_LABEL), false)
})

// ── navIconCss: hide the shell's gear, paint ours ──────────────────────────

test('navIconCss hides the shell glyph and paints the mark on the marked row', () => {
  const css = navIconCss('data:image/svg+xml,ABC')
  assert.match(css, new RegExp(NAV_ICON_ATTR), 'the stylesheet must be scoped to our marker attribute')
  assert.match(css, /display:\s*none/, "the shell's fallback gear must be hidden")
  assert.match(css, /mask-image/, 'the mark is painted via a mask')
  assert.match(css, /data:image\/svg\+xml,ABC/, 'the caller-supplied mask url is embedded verbatim')
})

test('navIconCss keeps the mark on currentColor so it follows the theme', () => {
  assert.match(navIconCss('data:image/svg+xml,ABC'), /background-color:\s*currentColor/)
})

test('the nav row selector targets the settings panel nav', () => {
  assert.equal(NAV_ROW_SELECTOR, '[role="dialog"] nav button')
})

// ── the mark itself ────────────────────────────────────────────────────────

test('the mark is a 16px outline drawn with the shared icon stroke width', () => {
  const decoded = decodeURIComponent(heartMaskUrl().replace(/^data:image\/svg\+xml,/, ''))
  assert.match(decoded, /viewBox="0 0 16 16"/, 'must match the shell icon grid')
  assert.equal(ICON_MEDIUM_STROKE, 1.3, 'must match the memory plugin / shell ICON_MEDIUM_STROKE')
  assert.match(decoded, /stroke-width="1\.3"/)
  assert.match(decoded, /stroke-linecap="round"/)
  assert.match(decoded, /stroke-linejoin="round"/)
})

test('the mark is painted pure black because a mask reads alpha only', () => {
  const decoded = decodeURIComponent(heartMaskUrl().replace(/^data:image\/svg\+xml,/, ''))
  assert.doesNotMatch(decoded, /currentColor/)
  assert.match(decoded, /stroke="#000"/)
})

test('the mark is one closed heart outline (no fills, no nodes)', () => {
  const decoded = decodeURIComponent(heartMaskUrl().replace(/^data:image\/svg\+xml,/, ''))
  const paths = decoded.match(/<path d="[^"]+"/g) ?? []
  assert.equal(paths.length, 1, 'a single path keeps the mark simple at 16px')
  assert.match(HEART_PATH, /Z$/, 'the outline must be closed')
  assert.equal((decoded.match(/<circle/g) ?? []).length, 0, 'the heart has no nodes')
  assert.match(decoded, /fill="none"/)
})

test('circle/path injection is escaped through the mask URL encoder', () => {
  const svg = heartSvg('<bogus>')
  assert.match(svg, /<path d="<bogus>"\/>/)
  const mask = heartMaskUrl(svg)
  assert.match(mask, /^data:image\/svg\+xml,/)
  // "#" and "<" must be percent-encoded so the CSS url() stays valid.
  assert.doesNotMatch(mask.slice('data:image/svg+xml,'.length), /[#<>]/)
})
