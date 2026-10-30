/**
 * v0.8 settings-panel render test（vm + 极简 hooks）。
 *
 * `lib/client.js` 是浏览器模块，零构建；现有 `test/client-half.test.mjs` 用 vm
 * 契约断言源码/字典。这里再往前一步：给 vm 里的 `react` 种子提供一个最小 hooks
 * 实现（useState/useEffect/Component），真正把 `HeartbeatSection` 渲染成元素树，
 * 断言 P0 三个新行、L3 已授权摘要、P1 诊断区（最近 5 拍 + 当前发言权）都落到了
 * 真实输出里，而不是只存在于源码字符串。
 *
 * 不是快照测试：只断言行为文案与结构顺序，样式/class 变动不会误报。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const NOW = 1_700_000_000_000
const CONFIG = {
  enabled: true,
  mode: 'assist',
  baseIntervalSeconds: 600,
  pauseAfterMissed: 3,
  quietHours: { start: '23:00', end: '08:00' },
  taskNudge: true,
  taskNudgeMaxItems: 5,
  dedupeWindowMinutes: 90,
  maxBeatsPerDay: 12,
  l3Allow: ['read', 'test'],
  proactiveCooldownSeconds: 180,
  userActiveSuppressSeconds: 120,
  physiologyLine: true,
}
const STATUS = {
  budget: { used: 2 },
  sessions: [{
    sessionId: 's1',
    nextBeatAt: NOW + 60_000,
    paused: false,
    snoozeUntil: 0,
    budget: { used: 2, max: 12 },
    level: 'L1',
    lock: { speaker: 'memory', at: NOW },
    history: [
      { at: NOW - 3000, level: 'L0', reason: 'proactive-cooldown（让位给 memory）' },
      { at: NOW - 2000, level: 'L0', reason: 'quiet-hours' },
      { at: NOW - 1000, level: 'L1', reason: 'task ready: ship 0.8.0' },
    ],
  }],
}

/** Minimal hooks renderer：单组件树、同步重渲染由测试手动驱动。 */
function createReact() {
  const store = []
  let cursor = 0
  let dirty = false
  const effects = []
  class Component {
    constructor(props) {
      this.props = props ?? {}
      this.state = {}
    }
    setState(next) {
      this.state = { ...this.state, ...next }
      dirty = true
    }
  }
  Component.prototype.isReactComponent = {}
  return {
    store,
    effects,
    get dirty() {
      return dirty
    },
    clearDirty() {
      dirty = false
    },
    reset() {
      cursor = 0
    },
    createElement(type, props, ...children) {
      return {
        type,
        props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
        children,
      }
    },
    Component,
    useState(initial) {
      const index = cursor++
      if (!(index in store)) store[index] = initial
      const set = (next) => {
        store[index] = typeof next === 'function' ? next(store[index]) : next
        dirty = true
      }
      return [store[index], set]
    },
    useEffect(callback) {
      effects.push(callback)
    },
    useRef: () => ({ current: undefined }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
}

/** Render one element tree; class and function components are expanded. */
function renderNode(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(renderNode)
  const { type, props, children } = node
  if (typeof type === 'function') {
    if (type.prototype?.isReactComponent) return renderNode(new type(props).render())
    return renderNode(type(props))
  }
  return { tag: type, props, children: children.map(renderNode) }
}

/** Collect visible text and control values out of a rendered tree. */
function collect(node, out = { texts: [], values: [] }) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.texts.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out)
    return out
  }
  if (node.tag !== undefined) {
    if (node.props?.value !== undefined) out.values.push(node.props.value)
    if (node.props?.checked !== undefined) out.values.push(node.props.checked)
  }
  for (const child of node.children ?? []) collect(child, out)
  return out
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Load the client bundle in a vm and render its settings section twice. */
async function renderPanel({ language = 'zh' } = {}) {
  let registration
  const sandbox = {
    window: { __ModuleLoader__: { load(entry) { registration = entry } } },
    document: {
      body: {},
      visibilityState: 'visible',
      head: { appendChild() {} },
      createElement: () => ({ textContent: '', remove() {} }),
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    console,
    setInterval: () => undefined,
    clearInterval() {},
    fetch: (url) => Promise.resolve({
      ok: true,
      json: async () => (String(url).endsWith('/config') ? CONFIG : STATUS),
    }),
  }
  vm.runInContext(
    fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'),
    vm.createContext(sandbox),
    { filename: 'lib/client.js' },
  )
  const React = createReact()
  const moduleExports = registration.factory((name) => {
    assert.equal(name, 'react')
    return React
  })
  const registrations = []
  moduleExports.apply({
    locale: {
      getSnapshot: () => ({ active: language }),
      register: () => () => {},
    },
    slots: {
      inject: (_key, callback) => callback(),
      register: (entry, component) => {
        registrations.push({ entry, component })
        return () => {}
      },
    },
    effect: (callback) => {
      callback()
      return () => {}
    },
  })
  const Section = registrations.find((item) => item.entry.name === 'settings.section').component

  React.reset()
  const loading = collect(renderNode(React.createElement(Section, { t: undefined })))
  for (const effect of React.effects.splice(0)) effect()
  await tick()
  await tick()
  await tick()
  React.clearDirty()
  React.reset()
  const full = collect(renderNode(React.createElement(Section, { t: undefined })))
  return { loading, full, dirty: React.dirty }
}

test('v0.8 settings panel actually renders the three missing config rows', async () => {
  const { loading, full } = await renderPanel()
  assert.ok(loading.texts.includes('读取配置中…'), 'first paint is the loading state')
  const joined = full.texts.join('\n')
  for (const label of ['发言权仲裁窗口', '你在场时静默', '消息带状态行']) {
    assert.ok(joined.includes(label), `panel renders "${label}"`)
  }
  assert.ok(joined.includes('与其他主动插件（如 memory）互让；0 = 关闭仲裁'), 'cooldown hint explains mutual yielding')
  assert.ok(joined.includes('你刚说过话的这段时间内不主动开口；0 = 不抑制'), 'suppression hint explains 0')
  assert.ok(joined.includes('在心跳消息里带一行「距你上次说话 …」'), 'physiology hint is rendered')
  // 180s show as 3 minutes; 120s suppression stays in seconds; toggle defaults on.
  assert.ok(full.values.includes(3), 'proactiveCooldownSeconds renders as minutes')
  assert.ok(full.values.includes(120), 'userActiveSuppressSeconds renders as seconds')
  assert.ok(full.values.includes(true), 'physiologyLine renders as an on toggle')
})

test('v0.8 settings panel renders the L3 grant summary from config', async () => {
  const { full } = await renderPanel()
  const joined = full.texts.join('\n')
  assert.ok(joined.includes('已授权：读取 / 检索、跑测试 / 构建'), 'live l3Allow grants are summarised')
  assert.ok(joined.includes('授权摘要（不可逆操作仍由审批拦截）'), 'summary keeps the approval hint')
  assert.ok(!joined.includes('未授权任何类别'), 'granted categories do not render the empty-state copy')
})

test('v0.8 settings panel renders diagnostics under vitals, without duplicating history', async () => {
  const { full } = await renderPanel()
  const texts = full.texts
  const joined = texts.join('\n')
  assert.ok(joined.includes('诊断'), 'diagnostics heading is rendered')
  assert.ok(joined.includes('最近几次为什么没开口，以及当前发言权在谁手里'), 'diagnostics hint is rendered')
  assert.ok(joined.includes('当前发言权：memory 持有'), 'current floor names the holder with a label')
  assert.ok(joined.includes('task ready: ship 0.8.0'), 'pulse reason is rendered verbatim')
  assert.ok(joined.includes('proactive-cooldown（让位给 memory）'), 'yield reason is rendered verbatim')
  // Layout: vitals header -> vitals rows -> diagnostics -> config rows.
  const indexOf = (needle) => texts.findIndex((value) => value.includes(needle))
  assert.ok(indexOf('生命体征') < indexOf('诊断'), 'diagnostics comes after the vitals heading')
  assert.ok(indexOf('诊断') < indexOf('启用心跳'), 'diagnostics sits directly below vitals, before the config rows')
  // The same pulse is rendered once (diagnostics owns history; vitals must not duplicate it).
  assert.equal(texts.filter((value) => value.includes('task ready: ship 0.8.0')).length, 1)
})
