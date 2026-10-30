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
function browserHarness({ effects = false, visibility = 'visible', status } = {}) {
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
  const intervals = []
  const listeners = new Map()
  const effectCleanups = []
  let fetchCount = 0
  let registration
  const documentStub = {
    body: {},
    visibilityState: visibility,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(callback)
    },
    removeEventListener(type, callback) {
      listeners.get(type)?.delete(callback)
    },
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
    fetch: () => {
      fetchCount += 1
      return Promise.resolve({ ok: true, json: async () => status ?? { sessions: [] } })
    },
    setInterval: (callback, ms) => {
      const handle = { callback, ms }
      intervals.push(handle)
      return handle
    },
    clearInterval: (handle) => {
      const index = intervals.indexOf(handle)
      if (index >= 0) intervals.splice(index, 1)
    },
  }
  vm.runInContext(CLIENT_SOURCE, vm.createContext(sandbox), { filename: 'lib/client.js' })
  assert.equal(registration.id, 'dsh-plugin-heartbeat', 'client module id must be the package name')

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Component: class {},
    useState: () => [undefined, () => {}],
    useEffect: effects
      ? (callback) => {
        const cleanup = callback()
        if (typeof cleanup === 'function') effectCleanups.push(cleanup)
      }
      : () => {},
    useRef: () => ({ current: undefined }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  const moduleExports = registration.factory((name) => {
    assert.equal(name, 'react', 'the client half may only require the react platform seed')
    return react
  })
  return {
    moduleExports,
    rows,
    styles,
    observers,
    document: documentStub,
    intervals,
    listeners,
    effectCleanups,
    fetchCount: () => fetchCount,
    fire(type) {
      for (const callback of [...(listeners.get(type) ?? [])]) callback()
    },
  }
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
  assert.ok(slots.injections.includes('settings.section'))
  assert.ok(slots.injections.includes('conversation.session.header.actions'))
  const section = slots.registrations.find((item) => item.entry.name === 'settings.section')
  assert.equal(slots.registrations.length, 2)
  const { entry, component } = section
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
  const entry = first.slots.registrations.find((item) => item.entry.name === 'settings.section').entry
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
  const section = slots.registrations.find((item) => item.entry.name === 'settings.section')
  assert.equal(section.entry.locale, 'heartbeat', 'slot declares the locale namespace')
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].namespace, 'heartbeat')
  assert.deepEqual(Object.keys(dictionaries[0].dicts).sort(), ['en', 'zh'])
  const zhKeys = Object.keys(dictionaries[0].dicts.zh).sort()
  const enKeys = Object.keys(dictionaries[0].dicts.en).sort()
  assert.deepEqual(enKeys, zhKeys, 'both languages expose the same keys')
  assert.equal(dictionaries[0].dicts.zh.beatNow, '立即一拍')
  assert.equal(dictionaries[0].dicts.en.beatNow, 'Beat now')
  assert.equal(section.entry.label(), 'Heartbeat', 'English app language yields the English label')
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
  assert.ok(styles.some((style) => String(style.textContent).includes('mask-image')), 'nav icon stylesheet present')
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

test('the client source calls translate instead of indexing a function', () => {
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // Regression: a mechanical i18n rewrite once left `t[`key`]`, which is
  // `undefined` on a function and silently rendered blank labels (L3 grants
  // lost their category names). Translate lookups must be calls.
  assert.equal(/\bt\[/.test(source), false, 'translate lookups must be t(...) calls, never t[...]')
  assert.ok(source.includes('t(`l3${category}`)'), 'L3 category labels are translated via a call')
  // v0.8 moved history rendering into the diagnostics helper; the level label
  // must still go through a translate call (the 0.5.0 blank-label regression).
  assert.match(source, /translate\(`level\$\{[^}]+\}`\)/, 'history level labels are translated via a call')
})

test('activity pill renders nothing when the host reports no running child', () => {
  const { moduleExports } = browserHarness()
  const Pill = moduleExports.__test.ActivityPill
  assert.equal(typeof Pill, 'function')
  const tree = Pill({ sessionId: 'session-1', t: moduleExports.__test.fallbackT })
  assert.equal(tree, null)
})

test('childrenOfStatus reads host child counts defensively', () => {
  const { moduleExports } = browserHarness()
  const childrenOfStatus = moduleExports.__test.childrenOfStatus
  const payload = { sessions: [{ sessionId: 'main', children: { total: 3, running: 2 } }] }
  // sandbox objects live in another realm: compare fields, not prototypes
  const counts = (json, id) => {
    const value = childrenOfStatus(json, id)
    return `${value.total}/${value.running}`
  }
  assert.equal(counts(payload, 'main'), '3/2')
  assert.equal(counts(payload, 'other'), '0/0')
  assert.equal(counts(undefined, 'main'), '0/0')
  assert.equal(counts({ sessions: 'nope' }, 'main'), '0/0')
  // running never exceeds total after coercion
  assert.equal(counts({ sessions: [{ sessionId: 'main', children: { total: 1, running: 9 } }] }, 'main'), '1/1')
})

test('the header pill polls the status route and is translated', () => {
  const { moduleExports } = browserHarness()
  const dicts = moduleExports.__test.DICTS
  assert.equal(typeof dicts.zh.activityRunning, 'string')
  assert.equal(typeof dicts.en.activityRunning, 'string')
  assert.ok(CLIENT_SOURCE.includes("conversation.session.header.actions"))
  assert.ok(CLIENT_SOURCE.includes('ACTIVITY_POLL_MS'))
  assert.ok(CLIENT_SOURCE.includes('childrenOfStatus'))
})

test('v0.8 panel wires the three schema keys it used to omit', () => {
  const { moduleExports } = browserHarness()
  const { DICTS } = moduleExports.__test
  const keys = [
    'proactiveCooldown', 'proactiveCooldownHint', 'proactiveCooldownUnit',
    'userActiveSuppress', 'userActiveSuppressHint', 'userActiveSuppressUnit',
    'physiologyLine', 'physiologyLineHint',
  ]
  for (const key of keys) {
    assert.equal(typeof DICTS.zh[key], 'string', `zh.${key} must exist`)
    assert.equal(typeof DICTS.en[key], 'string', `en.${key} must exist`)
  }
  // The panel must post the snake-shaped schema keys, not a prettier alias.
  assert.ok(CLIENT_SOURCE.includes('apply({ proactiveCooldownSeconds:'), 'proactive cooldown row saves proactiveCooldownSeconds')
  assert.ok(CLIENT_SOURCE.includes('apply({ userActiveSuppressSeconds:'), 'user-active row saves userActiveSuppressSeconds')
  assert.ok(CLIENT_SOURCE.includes('apply({ physiologyLine:'), 'physiology row saves physiologyLine')
  // 0 must stay a legal value in every numeric row (0 = arbitration/suppression off).
  assert.match(CLIENT_SOURCE, /proactiveCooldownSeconds[\s\S]{0,220}minutes >= 0/, 'proactive cooldown accepts 0')
  assert.match(CLIENT_SOURCE, /userActiveSuppressSeconds[\s\S]{0,220}seconds >= 0/, 'user-active suppression accepts 0')
})

test('v0.8 L3 grant summary renders the live grants', () => {
  const { moduleExports } = browserHarness()
  const { l3SummaryOf, DICTS } = moduleExports.__test
  const zh = (key) => DICTS.zh[key]
  const en = (key) => DICTS.en[key]
  assert.equal(l3SummaryOf(['read', 'test'], zh), '已授权：读取 / 检索、跑测试 / 构建')
  assert.equal(l3SummaryOf(['notes'], en), 'Granted: write docs / notes')
  assert.equal(l3SummaryOf([], zh), '未授权任何类别（默认全关）')
  assert.equal(l3SummaryOf(undefined, zh), '未授权任何类别（默认全关）')
  assert.equal(l3SummaryOf(['bogus'], zh), '已授权：bogus', 'unknown categories stay visible instead of being dropped')
  assert.ok(CLIENT_SOURCE.includes('l3SummaryOf(l3, t)'), 'the L3 row renders the summary from config.l3Allow')
  assert.ok(CLIENT_SOURCE.includes("t('l3GrantedHint')"), 'the summary keeps the approval hint')
})

test('v0.8 diagnostics renders recent pulses and the current floor', () => {
  const { moduleExports } = browserHarness()
  const { recentPulsesOf, floorTextOf, DICTS } = moduleExports.__test
  const zh = (key) => DICTS.zh[key]
  const history = [
    { at: 1_700_000_000_000, level: 'L0', reason: 'why-0' },
    { at: 1_700_000_001_000, level: 'L1', reason: 'why-1' },
    { at: 1_700_000_002_000, level: 'L2', reason: 'why-2' },
    { at: 1_700_000_003_000, level: 'L4', reason: 'why-3' },
    { at: 1_700_000_004_000, level: 'L1', reason: 'why-4' },
    { at: 1_700_000_005_000, level: 'L2', reason: 'why-5' },
  ]
  const pulses = recentPulsesOf({ history }, zh)
  assert.equal(pulses.length, 5, 'only the newest five pulses')
  assert.deepEqual(Array.from(pulses, (pulse) => pulse.reason), ['why-5', 'why-4', 'why-3', 'why-2', 'why-1'])
  assert.ok(pulses[0].text.includes(zh('levelL2')), 'level label is translated')
  assert.ok(pulses[0].text.includes('why-5'), 'reason is shown verbatim (non-i18n allowed)')
  assert.deepEqual(Array.from(recentPulsesOf({}, zh)), [])
  assert.deepEqual(Array.from(recentPulsesOf(undefined, zh)), [])
  // Floor line: heartbeat/memory claim, or idle.
  assert.equal(floorTextOf(null, zh), '空闲')
  assert.equal(floorTextOf({ speaker: '', at: 1 }, zh), '空闲')
  const memory = floorTextOf({ speaker: 'memory', at: 1_700_000_000_000 }, zh)
  assert.ok(memory.includes('memory') && memory.includes('持有'), `memory floor: ${memory}`)
  const heartbeat = floorTextOf({ speaker: 'heartbeat', at: 1_700_000_000_000 }, (key) => DICTS.en[key])
  assert.ok(heartbeat.includes('heartbeat') && heartbeat.includes('holds'), `en floor: ${heartbeat}`)
  assert.ok(CLIENT_SOURCE.includes("t('diagnostics')"), 'panel renders the diagnostics heading')
  assert.ok(CLIENT_SOURCE.includes('recentPulsesOf('), 'diagnostics reuses the pulse renderer')
  assert.ok(CLIENT_SOURCE.includes('floorTextOf('), 'diagnostics renders the current speech floor')
  // The diagnostics block is one pure composition: hint + newest pulses + floor.
  const { diagnosticsOf } = moduleExports.__test
  const diagnostic = diagnosticsOf({ history, lock: { speaker: 'memory', at: 1_700_000_000_000 } }, zh)
  assert.equal(Array.from(diagnostic.pulses).length, 5)
  assert.ok(diagnostic.pulses[0].includes('why-5'))
  assert.equal(diagnostic.empty, false)
  assert.ok(diagnostic.floor.includes('memory'), `floor names the holder: ${diagnostic.floor}`)
  assert.ok(diagnostic.floor.startsWith(zh('floorLine').split('{')[0]), 'floor is labelled, not a bare word')
  const idle = diagnosticsOf({}, zh)
  assert.equal(idle.empty, true)
  assert.equal(Array.from(idle.pulses).length, 0)
  assert.ok(idle.floor.includes(zh('floorIdle')))
  assert.ok(CLIENT_SOURCE.includes("translate('floorLine')"), 'the floor line is labelled instead of a bare "idle"')
  assert.ok(CLIENT_SOURCE.includes('diagnosticsOf(session, t)'), 'the panel renders the pure diagnostics composition')
})

test('v0.8 i18n interpolation is local, never host-provided', () => {
  const { moduleExports } = browserHarness()
  const { fill, DICTS } = moduleExports.__test
  assert.equal(fill('{name} 持有（{when}）', { name: 'memory', when: '12:00' }), 'memory 持有（12:00）')
  assert.equal(fill('{name} holds ({when})', { name: 'heartbeat', when: '12:00' }), 'heartbeat holds (12:00)')
  assert.equal(fill('no placeholders'), 'no placeholders')
  assert.equal(fill('{name} {missing}', { name: 'x' }), 'x {missing}', 'unknown placeholders stay visible')
  assert.equal(fill(undefined), '')
  assert.ok(DICTS.zh.floorHeldBy.includes('{name}'), 'zh floor template keeps the {name} placeholder')
  assert.ok(DICTS.zh.floorHeldBy.includes('{when}'), 'zh floor template keeps the {when} placeholder')
  assert.ok(DICTS.en.floorHeldBy.includes('{name}'))
  assert.ok(DICTS.en.floorHeldBy.includes('{when}'))
})

test('v0.8 renderActivityPill renders nothing unless a child is running', () => {
  const { moduleExports } = browserHarness()
  const { renderActivityPill, DICTS } = moduleExports.__test
  const zh = (key) => DICTS.zh[key]
  assert.equal(typeof renderActivityPill, 'function')
  assert.equal(renderActivityPill(null, zh), null)
  assert.equal(renderActivityPill(undefined, zh), null)
  assert.equal(renderActivityPill({ total: 2, running: 0 }, zh), null)
  assert.equal(renderActivityPill({ total: 0, running: 0 }, zh), null)
})

test('v0.8 renderActivityPill renders the translated running count', () => {
  const { moduleExports } = browserHarness()
  const { renderActivityPill, DICTS } = moduleExports.__test
  const tree = renderActivityPill({ total: 3, running: 2 }, (key) => DICTS.zh[key])
  assert.equal(tree.type, 'span')
  assert.equal(tree.props.title, DICTS.zh.activityPillHint)
  assert.equal(tree.children[1].children[0], '子智能体执行中 · 2')
  const enTree = renderActivityPill({ total: 3, running: 1 }, (key) => DICTS.en[key])
  assert.equal(enTree.children[1].children[0], 'subagents working · 1')
})

test('v0.8 the activity pill pauses polling while the document is hidden', () => {
  const harness = browserHarness({ effects: true, visibility: 'hidden' })
  const { ActivityPill, fallbackT } = harness.moduleExports.__test
  ActivityPill({ sessionId: 'session-1', t: fallbackT })
  assert.equal(harness.intervals.length, 0, 'hidden at mount: no polling timer')
  assert.equal(harness.fetchCount(), 0, 'hidden at mount: no status request')
  assert.equal(harness.listeners.get('visibilitychange')?.size ?? 0, 1, 'visibilitychange is observed')
  // Tab becomes visible: poll immediately, then every ACTIVITY_POLL_MS.
  harness.document.visibilityState = 'visible'
  harness.fire('visibilitychange')
  assert.equal(harness.intervals.length, 1, 'visible tab resumes polling')
  assert.equal(harness.intervals[0].ms, 5000, 'the 5s poll interval is preserved')
  assert.equal(harness.fetchCount(), 1, 'resume polls right away')
  // Tab hidden again: the timer is cleared, no background churn.
  harness.document.visibilityState = 'hidden'
  harness.fire('visibilitychange')
  assert.equal(harness.intervals.length, 0, 'hidden tab stops polling')
  // Unmount tears down the listener and any running timer.
  harness.document.visibilityState = 'visible'
  harness.fire('visibilitychange')
  assert.equal(harness.intervals.length, 1)
  for (const cleanup of harness.effectCleanups) cleanup()
  assert.equal(harness.intervals.length, 0, 'teardown clears the interval')
  assert.equal(harness.listeners.get('visibilitychange')?.size ?? 0, 0, 'teardown removes the listener')
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
