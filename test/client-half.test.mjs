/**
 * 客户端半（零构建）契约测试。
 *
 * `lib/client.js` 是浏览器模块（`window.__ModuleLoader__.load`），Node 无法直接
 * import，所以这里用 `node:vm` 按浏览器的方式加载它：假 `window/document/
 * MutationObserver`，验证三件事——
 *   1. 设置区块注册形状（settings.section / id heartbeat / label Heartbeat）；
 *   2. 侧栏爱心图标只认领 **文本精确等于 label** 的那一行，不误伤别人；
 *   3. 样式是 16×16/stroke 1.3/纯黑 alpha 的 mask，且 teardown 摘干净。
 *
 * 与 `test/settings-nav-icon.test.mjs`（纯函数规格）互补：那份测图标规格，
 * 这份测真实客户端代码怎么用它。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const NAV_ROW_SELECTOR = '[role="dialog"] nav button'
const NAV_ICON_ATTR = 'data-dsh-heartbeat-nav-icon'
const CLIENT_SOURCE = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** Build the browser-ish sandbox: rows + styles + observers + module loader. */
function browserHarness() {
  const rows = [
    { textContent: 'General' },
    { textContent: 'Memory' },
    { textContent: '心跳' },
    { textContent: 'Heartbeat' },
    { textContent: '  Heartbeat  ' },
  ].map((row) => ({
    ...row,
    attrs: new Set(),
  }))
  for (const row of rows) {
    row.setAttribute = (name) => row.attrs.add(name)
    row.removeAttribute = (name) => row.attrs.delete(name)
  }

  const styles = []
  const observers = []
  let registration
  const documentStub = {
    body: {},
    head: {
      appendChild(node) {
        styles.push(node)
      },
    },
    createElement() {
      return {
        textContent: '',
        remove() {
          const index = styles.indexOf(this)
          if (index >= 0) styles.splice(index, 1)
        },
      }
    },
    querySelectorAll(selector) {
      if (selector === NAV_ROW_SELECTOR) return rows
      const match = /^\[([^\]]+)\]$/.exec(selector)
      if (match !== null) return rows.filter((row) => row.attrs.has(match[1]))
      throw new Error(`unexpected selector ${selector}`)
    },
  }
  class MutationObserverStub {
    constructor(callback) {
      this.callback = callback
      observers.push(this)
    }
    observe() {}
    disconnect() {
      this.disconnected = true
    }
  }
  const sandbox = {
    window: {
      __ModuleLoader__: { load(entry) { registration = entry } },
      navigator: { language: 'zh-CN' },
    },
    document: documentStub,
    MutationObserver: MutationObserverStub,
    console,
  }
  vm.runInContext(CLIENT_SOURCE, vm.createContext(sandbox), { filename: 'lib/client.js' })
  assert.equal(registration.id, 'dsh-plugin-heartbeat', 'client module id must be the package name')

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Component: class {},
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: undefined }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const moduleExports = registration.factory((name) => {
    assert.equal(name, 'react', 'the client half may only require the react platform seed')
    return react
  })
  return { moduleExports, rows, styles, observers }
}

/** Run apply() against a fake slots/effect context. */
function applyClient(moduleExports, { language = 'zh' } = {}) {
  const slots = { registrations: [], injections: [] }
  const effects = []
  const dictionaries = []
  const localeState = { active: language }
  const ctx = {
    locale: {
      getSnapshot: () => ({ active: localeState.active, revision: 1 }),
      register(namespace, dicts) {
        dictionaries.push({ namespace, dicts })
        return () => {}
      },
    },
    slots: {
      inject(key, callback) {
        slots.injections.push(key)
        callback()
      },
      register(entry, component) {
        slots.registrations.push({ entry, component })
        return () => {}
      },
    },
    effect: (callback, label) => {
      effects.push({ label, dispose: callback() })
      return () => {}
    },
  }
  moduleExports.apply(ctx)
  return { slots, effects, dictionaries, localeState }
}

test('client half registers the settings section as Heartbeat', () => {
  const { moduleExports, injections, rows } = browserHarness()
  const { slots, effects } = applyClient(moduleExports)
  assert.deepEqual(slots.injections, ['settings.section'])
  assert.equal(slots.registrations.length, 1)
  const { entry, component } = slots.registrations[0]
  assert.equal(entry.name, 'settings.section')
  assert.equal(entry.id, 'heartbeat')
  assert.equal(entry.order, 100)
  assert.equal(entry.label(), '心跳', 'Chinese app language yields the Chinese label')
  assert.equal(typeof component, 'function')
  const labels = effects.map((effect) => effect.label)
  assert.ok(labels.includes('heartbeat: settings nav icon'))
  assert.ok(labels.includes('heartbeat: dictionaries'))
  assert.ok(rows.length > 0)
})

test('sidebar label and icon follow a language switch', () => {
  const { moduleExports, rows, observers } = browserHarness()
  const first = applyClient(moduleExports, { language: 'zh' })
  const entry = first.slots.registrations[0].entry
  assert.equal(entry.label(), '心跳')
  // Browser language switch: label text changes, MutationObserver re-claims.
  first.localeState.active = 'en'
  assert.equal(entry.label(), 'Heartbeat')
  rows.find((row) => row.textContent === '心跳').textContent = 'Heartbeat'
  assert.ok(observers.length > 0)
  for (const observer of observers) observer.callback()
  const claimed = rows.filter((row) => row.attrs.has(NAV_ICON_ATTR)).map((row) => row.textContent)
  assert.ok(claimed.every((text) => text.trim() === 'Heartbeat'), `claimed rows: ${JSON.stringify(claimed)}`)
  assert.ok(claimed.length >= 1)
})

test('panel language follows the DSH locale layer, not navigator', () => {
  const { moduleExports } = browserHarness()
  const { slots, dictionaries } = applyClient(moduleExports, { language: 'en' })
  assert.equal(moduleExports.inject.join(','), 'slots,locale')
  assert.equal(slots.registrations[0].entry.locale, 'heartbeat', 'slot declares the locale namespace')
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].namespace, 'heartbeat')
  assert.deepEqual(Object.keys(dictionaries[0].dicts).sort(), ['en', 'zh'])
  const zhKeys = Object.keys(dictionaries[0].dicts.zh).sort()
  const enKeys = Object.keys(dictionaries[0].dicts.en).sort()
  assert.deepEqual(enKeys, zhKeys, 'both languages expose the same keys')
  assert.equal(dictionaries[0].dicts.zh.beatNow, '立即一拍')
  assert.equal(dictionaries[0].dicts.en.beatNow, 'Beat now')
  assert.equal(slots.registrations[0].entry.label(), 'Heartbeat', 'English app language yields the English label')
  assert.equal(dictionaries[0].dicts.zh.sectionLabel, '心跳')
  assert.equal(dictionaries[0].dicts.en.sectionLabel, 'Heartbeat')
})

test('the nav heart is claimed only on the exact-label row', () => {
  const { moduleExports, rows } = browserHarness()
  applyClient(moduleExports)
  const claimed = rows.filter((row) => row.attrs.has(NAV_ICON_ATTR)).map((row) => row.textContent)
  assert.deepEqual(claimed, ['心跳'], 'Chinese label only claims the Chinese row')
  assert.equal(rows.find((row) => row.textContent === 'Memory').attrs.has(NAV_ICON_ATTR), false)
  assert.equal(rows.find((row) => row.textContent === 'Heartbeat').attrs.has(NAV_ICON_ATTR), false)
})

test('the injected mark is the shared-spec black outline heart', () => {
  const { moduleExports, styles } = browserHarness()
  applyClient(moduleExports)
  assert.equal(styles.length, 1)
  const css = styles[0].textContent
  assert.match(css, /mask-image/)
  assert.match(css, /background-color:\s*currentColor/)
  const maskUrl = /mask-image: url\("([^"]+)"\)/.exec(css)?.[1] ?? ''
  assert.match(maskUrl, /^data:image\/svg\+xml,/)
  const svg = decodeURIComponent(maskUrl.slice('data:image/svg+xml,'.length))
  assert.match(svg, /viewBox="0 0 16 16"/)
  assert.match(svg, /stroke-width="1\.3"/)
  assert.match(svg, /stroke="#000"/)
  assert.match(svg, /<path d="M12\.667/)
})

test('panel helpers: durations, states, languages and strings', () => {
  const { moduleExports } = browserHarness()
  const helpers = moduleExports.__test
  assert.equal(typeof helpers, 'object')
  assert.equal(helpers.formatDuration(0), '—')
  assert.equal(helpers.formatDuration(45_000), '45s')
  assert.equal(helpers.formatDuration(90_000), '2m')
  assert.equal(helpers.formatDuration(3600_000), '1h')
  assert.equal(helpers.formatDuration(3900_000), '1h 5m')
  const zh = (key) => helpers.DICTS.zh[key]
  const en = (key) => helpers.DICTS.en[key]
  assert.equal(helpers.stateOf({ paused: true }, zh), '已暂停')
  assert.equal(helpers.stateOf({ snoozeUntil: Date.now() + 60_000 }, zh), '打盹中')
  assert.equal(helpers.stateOf({}, zh), '运行中')
  assert.equal(helpers.stateOf({ paused: true }, en), 'paused')
  assert.equal(helpers.fallbackT('beatNow'), '立即一拍')
  assert.equal(helpers.fallbackT('missing.key'), 'missing.key')
  for (const level of ['L0', 'L1', 'L2', 'L4']) {
    assert.ok(zh(`level${level}`).includes(level))
    assert.ok(en(`level${level}`).includes(level))
  }
})

test('teardown removes the mark, the stylesheet and the observer', () => {
  const { moduleExports, rows, styles, observers } = browserHarness()
  const { effects } = applyClient(moduleExports)
  assert.ok(rows.some((row) => row.attrs.has(NAV_ICON_ATTR)))
  for (const effect of effects) effect.dispose()
  assert.equal(rows.filter((row) => row.attrs.has(NAV_ICON_ATTR)).length, 0)
  assert.equal(styles.length, 0)
  assert.ok(observers.length > 0)
  assert.ok(observers.every((observer) => observer.disconnected === true))
})
