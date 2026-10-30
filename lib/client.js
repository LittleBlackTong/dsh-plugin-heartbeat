/**
 * dsh-plugin-heartbeat 客户端半（零构建）：
 * 设置面板「Heartbeat」区块 —— 生命体征 + 手动控制 + 配置 + 任务巡检。
 * 侧栏图标为描边爱心（与 dsh-plugin-memory 的图标规格统一）。
 *
 * 数据通道：settings wire 只服务硬编码白名单（heartbeat 不在其中），
 * 因此本区块直连插件自建的 HTTP 路由：
 *   GET/POST /api/heartbeat/config  ·  GET /api/heartbeat/status  ·  POST /api/heartbeat/control
 * 文案走 DSH 语言层（ctx.locale + `heartbeat` 命名空间，跟随设置 → 通用设置 → 语言），零依赖、零构建。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-heartbeat',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    let react = require('react')

    const React = react
    const CONFIG_URL = '/api/heartbeat/config'
    const STATUS_URL = '/api/heartbeat/status'
    const CONTROL_URL = '/api/heartbeat/control'
    const STATUS_REFRESH_MS = 10000

    /** Dictionary namespace owned by this plugin (registered via ctx.locale). */
    const LOCALE_NS = 'heartbeat'

    /** Language packs; the active language comes from DSH settings (通用设置 → 语言). */
    const DICTS = {
      zh: {
        sectionLabel: '心跳',
        loading: '读取配置中…',
        loadFailed: '心跳设置页加载失败：',
        enabled: '启用心跳',
        enabledHint: '有信号才开口；没信号只做静默检查',
        mode: '自主等级',
        modeAssist: 'Assist（有信号会问你）',
        modeSilent: 'Silent（只检查不开口）',
        interval: '基础间隔',
        intervalUnit: '分钟',
        quietHours: '静默时段',
        quietHint: '该时段内不主动开口',
        pauseAfterMissed: '无人回应时暂停',
        pauseUnit: '拍（0 = 关闭）',
        pauseHint: '连续 N 拍没回复就停，你的下一条消息恢复',
        taskNudge: '任务巡检',
        taskNudgeHint: '读会话里的待办 / 团队任务 / 目标，有该做没拍板的事就问你',
        maxItems: '巡检条目上限',
        maxItemsUnit: '项',
        dedupe: '去重窗口',
        dedupeUnit: '分钟（同一事项不重复问）',
        dedupeUnitShort: '分钟',
        dailyBudget: '每日预算',
        dailyBudgetUnit: '条主动消息（0 = 不限）',
        dailyBudgetUnitShort: '条',
        l3: 'L3 自动执行授权',
        l3Hint: '默认全关。授权类别内可自行推进；不可逆操作仍由审批拦截',
        l3read: '读取 / 检索',
        l3test: '跑测试 / 构建',
        l3notes: '写文档 / 笔记',
        l3continue: '续写草稿',
        vitals: '生命体征',
        statePaused: '已暂停',
        stateSnoozed: '打盹中',
        stateRunning: '运行中',
        nextBeat: '下次检查',
        noHistory: '还没有脉冲记录',
        beatNow: '立即一拍',
        snooze: '打盹 30 分钟',
        pause: '暂停',
        resume: '恢复',
        reset: '重置',
        saveFailed: '保存失败：',
        controlFailed: '操作失败：',
        never: '—',
        levelL0: 'L0 静默',
        levelL1: 'L1 汇报',
        levelL2: 'L2 询问',
        levelL4: 'L4 升级',
      },
      en: {
        sectionLabel: 'Heartbeat',
        loading: 'Loading configuration…',
        loadFailed: 'Failed to load heartbeat settings: ',
        enabled: 'Enable heartbeat',
        enabledHint: 'Speak only on signal; otherwise just pulse silently',
        mode: 'Autonomy level',
        modeAssist: 'Assist (asks on signals)',
        modeSilent: 'Silent (check only, never speak)',
        interval: 'Base interval',
        intervalUnit: 'min',
        quietHours: 'Quiet hours',
        quietHint: 'Never speaks inside this window',
        pauseAfterMissed: 'Pause when unanswered',
        pauseUnit: 'beats',
        pauseHint: 'Stop after N unanswered pulses; your next message resumes',
        taskNudge: 'Task inspection',
        taskNudgeHint: 'Read session todos / team board / goal and ask before acting',
        maxItems: 'Max snapshot items',
        maxItemsUnit: 'items',
        dedupe: 'Dedupe window',
        dedupeUnit: 'minutes (never repeat the same item)',
        dedupeUnitShort: 'min',
        dailyBudget: 'Daily budget',
        dailyBudgetUnit: 'proactive messages (0 = unlimited)',
        dailyBudgetUnitShort: 'beats',
        l3: 'L3 auto-execute grants',
        l3Hint: 'All off by default. Inside granted categories the agent may proceed; irreversible actions still ask for approval',
        l3read: 'read / search',
        l3test: 'run tests / build',
        l3notes: 'write docs / notes',
        l3continue: 'continue drafts',
        vitals: 'Vitals',
        statePaused: 'paused',
        stateSnoozed: 'snoozed',
        stateRunning: 'running',
        nextBeat: 'Next check',
        noHistory: 'No pulses recorded yet',
        beatNow: 'Beat now',
        snooze: 'Snooze 30m',
        pause: 'Pause',
        resume: 'Resume',
        reset: 'Reset',
        saveFailed: 'Save failed: ',
        controlFailed: 'Action failed: ',
        never: '—',
        levelL0: 'L0 silent',
        levelL1: 'L1 report',
        levelL2: 'L2 ask',
        levelL4: 'L4 escalate',
      },
    }

    /** Fallback translate for tests or a missing slot `t` seat (default Chinese). */
    function fallbackT(key) {
      return DICTS.zh[key] ?? key
    }

    const clampMinutes = (seconds) => Math.max(1, Math.round((Number(seconds) || 0) / 60))

    /** Human duration: `2h 5m`, `45m`, `30s`, `—`. */
    function formatDuration(ms, never = '—') {
      const value = Number(ms)
      if (!Number.isFinite(value) || value <= 0) return never
      const seconds = Math.round(value / 1000)
      if (seconds < 60) return `${seconds}s`
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      const restMinutes = minutes % 60
      return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`
    }

    /** Short state label for one status row. */
    function stateOf(session, t) {
      if (session?.paused === true) return t('statePaused')
      if (Number(session?.snoozeUntil ?? 0) > Date.now()) return t('stateSnoozed')
      return t('stateRunning')
    }

    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      padding: '14px 16px',
      borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2))',
    }
    const labelStyle = { fontSize: '14px', lineHeight: '22px' }
    const subStyle = { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #999)' }
    const errorStyle = { padding: '0 16px 8px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary, #e5484d)' }
    const inputStyle = {
      width: '72px',
      padding: '6px 8px',
      fontSize: '14px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      color: 'var(--dsw-alias-label-primary, inherit)',
    }
    const buttonStyle = {
      padding: '6px 12px',
      fontSize: '13px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      color: 'var(--dsw-alias-label-primary, inherit)',
      cursor: 'pointer',
    }

    function Toggle({ checked, disabled, onChange }) {
      return React.createElement('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        disabled,
        onClick: () => onChange(!checked),
        style: {
          position: 'relative',
          width: '40px',
          height: '22px',
          borderRadius: '11px',
          border: 'none',
          cursor: disabled ? 'not-allowed' : 'pointer',
          background: checked ? 'var(--dsw-alias-brand-primary, #4c8bf5)' : 'var(--dsw-alias-label-secondary, #666)',
          opacity: disabled ? 0.5 : 1,
          transition: 'background 0.15s',
          flexShrink: 0,
        },
      }, React.createElement('span', {
        style: {
          position: 'absolute',
          top: '2px',
          left: checked ? '20px' : '2px',
          width: '18px',
          height: '18px',
          borderRadius: '9px',
          background: '#fff',
          transition: 'left 0.15s',
        },
      }))
    }

    function ErrorText({ message }) {
      return React.createElement('div', { style: { padding: '14px 16px', fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-state-error-primary, #e5484d)' } },
        '心跳设置页加载失败：', message)
    }

    /** 渲染期兜底：任何异常都以文案形式显示，绝不空白。 */
    class SectionBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: undefined }
      }
      static getDerivedStateFromError(error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
      render() {
        if (this.state.error !== undefined) return React.createElement(ErrorText, { message: this.state.error })
        return this.props.children
      }
    }

    function HeartbeatSection(props) {
      return React.createElement(SectionBoundary, null, React.createElement(HeartbeatPanel, props))
    }

    function HeartbeatPanel(props) {
      // Slot entries that declare `locale: LOCALE_NS` receive a `t` seat from the
      // renderer; it follows DSH's own language setting (通用设置 → 语言).
      const t = typeof props?.t === 'function' ? props.t : fallbackT
      const [config, setConfig] = React.useState(undefined)
      const [status, setStatus] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [saving, setSaving] = React.useState(false)

      const refreshStatus = () => {
        fetch(STATUS_URL)
          .then(async (response) => (response.ok ? response.json() : undefined))
          .then((value) => {
            if (value !== undefined) setStatus(value)
          })
          .catch(() => {})
      }

      React.useEffect(() => {
        let alive = true
        Promise.all([
          fetch(CONFIG_URL).then(async (response) => {
            if (!response.ok) throw new Error(`GET config ${response.status}`)
            return response.json()
          }),
          fetch(STATUS_URL).then(async (response) => (response.ok ? response.json() : undefined)),
        ])
          .then(([nextConfig, nextStatus]) => {
            if (!alive) return
            setConfig(nextConfig)
            if (nextStatus !== undefined) setStatus(nextStatus)
          })
          .catch((err) => {
            if (!alive) return
            setError(err instanceof Error ? err.message : String(err))
          })
        const timer = setInterval(refreshStatus, STATUS_REFRESH_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      const apply = (patch) => {
        setSaving(true)
        setError(undefined)
        fetch(CONFIG_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
          .then(async (response) => {
            const body = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(body.error ?? `POST ${response.status}`)
            setConfig(body)
            refreshStatus()
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setSaving(false))
      }

      const control = (action, extra = {}) => {
        setError(undefined)
        fetch(CONTROL_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...extra }),
        })
          .then(async (response) => {
            const body = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(body.error ?? `POST ${response.status}`)
            refreshStatus()
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      }

      if (config === undefined) {
        return React.createElement('div', { style: { padding: '14px 16px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #888)' } }, t('loading'))
      }

      const value = config ?? {}
      const disabled = saving
      const session = status?.sessions?.[0]
      const budget = status?.budget
      const budgetUsed = status?.sessions?.reduce((sum, row) => sum + (row.budget?.used ?? 0), 0) ?? 0
      const budgetMax = value.maxBeatsPerDay ?? 0
      const quietOn = value.quietHours !== null && value.quietHours !== undefined
      const l3 = Array.isArray(value.l3Allow) ? value.l3Allow : []

      const rows = []
      const pushRow = (key, label, hint, controlNode) => rows.push(React.createElement('div', { style: rowStyle, key },
        React.createElement('div', null,
          React.createElement('div', { style: labelStyle }, label),
          hint !== undefined ? React.createElement('div', { style: subStyle }, hint) : null,
        ),
        controlNode,
      ))

      pushRow('enabled', t('enabled'), t('enabledHint'), React.createElement(Toggle, {
        checked: value.enabled !== false,
        disabled,
        onChange: (next) => apply({ enabled: next }),
      }))

      pushRow('mode', t('mode'), undefined, React.createElement('select', {
        value: value.mode ?? 'assist',
        disabled,
        onChange: (event) => apply({ mode: event.target.value }),
        style: { ...inputStyle, width: 'auto' },
      },
      React.createElement('option', { value: 'assist' }, t('modeAssist')),
      React.createElement('option', { value: 'silent' }, t('modeSilent'))))

      pushRow('interval', t('interval'), undefined, React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        React.createElement('input', {
          type: 'number',
          min: 1,
          max: 1440,
          disabled,
          value: clampMinutes(value.baseIntervalSeconds),
          onChange: (event) => {
            const minutes = Number(event.target.value)
            if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440) apply({ baseIntervalSeconds: Math.round(minutes * 60) })
          },
          style: inputStyle,
        }),
        React.createElement('span', { style: labelStyle }, t('intervalUnit'))))

      pushRow('quiet', t('quietHours'), t('quietHint'), React.createElement(Toggle, {
        checked: quietOn,
        disabled,
        onChange: (next) => apply({ quietHours: next ? { start: '23:00', end: '08:00' } : null }),
      }))
      if (quietOn) {
        pushRow('quiet-range', '23:00 – 08:00', undefined, React.createElement('div', { style: { display: 'flex', gap: '6px' } },
          React.createElement('input', {
            value: value.quietHours.start,
            disabled,
            onChange: (event) => apply({ quietHours: { ...value.quietHours, start: event.target.value } }),
            style: { ...inputStyle, width: '60px' },
          }),
          React.createElement('input', {
            value: value.quietHours.end,
            disabled,
            onChange: (event) => apply({ quietHours: { ...value.quietHours, end: event.target.value } }),
            style: { ...inputStyle, width: '60px' },
          })))
      }

      pushRow('pause', t('pauseAfterMissed'), t('pauseHint'), React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        React.createElement('input', {
          type: 'number',
          min: 0,
          max: 100,
          disabled,
          value: value.pauseAfterMissed ?? 3,
          onChange: (event) => {
            const count = Number(event.target.value)
            if (Number.isFinite(count) && count >= 0 && count <= 100) apply({ pauseAfterMissed: Math.round(count) })
          },
          style: inputStyle,
        }),
        React.createElement('span', { style: labelStyle }, t('pauseUnit'))))

      pushRow('taskNudge', t('taskNudge'), t('taskNudgeHint'), React.createElement(Toggle, {
        checked: value.taskNudge !== false,
        disabled,
        onChange: (next) => apply({ taskNudge: next }),
      }))

      pushRow('maxItems', t('maxItems'), undefined, React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        React.createElement('input', {
          type: 'number',
          min: 1,
          max: 20,
          disabled,
          value: value.taskNudgeMaxItems ?? 5,
          onChange: (event) => {
            const count = Number(event.target.value)
            if (Number.isFinite(count) && count >= 1 && count <= 20) apply({ taskNudgeMaxItems: Math.round(count) })
          },
          style: inputStyle,
        }),
        React.createElement('span', { style: labelStyle }, t('maxItemsUnit'))))

      pushRow('dedupe', t('dedupe'), t('dedupeUnit'), React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        React.createElement('input', {
          type: 'number',
          min: 0,
          max: 1440,
          disabled,
          value: value.dedupeWindowMinutes ?? 90,
          onChange: (event) => {
            const minutes = Number(event.target.value)
            if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440) apply({ dedupeWindowMinutes: Math.round(minutes) })
          },
          style: inputStyle,
        }),
        React.createElement('span', { style: labelStyle }, t('dedupeUnitShort'))))

      pushRow('budget', t('dailyBudget'), t('dailyBudgetUnit'), React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        React.createElement('input', {
          type: 'number',
          min: 0,
          max: 1000,
          disabled,
          value: value.maxBeatsPerDay ?? 12,
          onChange: (event) => {
            const count = Number(event.target.value)
            if (Number.isFinite(count) && count >= 0 && count <= 1000) apply({ maxBeatsPerDay: Math.round(count) })
          },
          style: inputStyle,
        }),
        React.createElement('span', { style: labelStyle }, t('dailyBudgetUnitShort'))))

      pushRow('l3', t('l3'), t('l3Hint'), React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        ['read', 'test', 'notes', 'continue'].map((category) => React.createElement('label', {
          key: category,
          style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer' },
        },
        React.createElement('input', {
          type: 'checkbox',
          checked: l3.includes(category),
          disabled,
          onChange: () => apply({ l3Allow: l3.includes(category) ? l3.filter((item) => item !== category) : [...l3, category] }),
        }),
        t(`l3${category}`)))))

      const vitalsRows = []
      vitalsRows.push(React.createElement('div', { style: rowStyle, key: 'state' },
        React.createElement('div', null,
          React.createElement('div', { style: labelStyle }, t('vitals')),
          React.createElement('div', { style: subStyle },
            `${session !== undefined ? stateOf(session, t) : '—'} · ${t('nextBeat')} ${session !== undefined ? formatDuration(Number(session.nextBeatAt) - Date.now(), t('never')) : t('never')}`),
        ),
        React.createElement('div', { style: labelStyle },
          budgetMax === 0 ? `${budgetUsed} / ∞` : `${budgetUsed} / ${budgetMax}`)))
      if (Array.isArray(session?.history) && session.history.length > 0) {
        for (const [index, row] of session.history.slice(-5).reverse().entries()) {
          vitalsRows.push(React.createElement('div', { style: { ...rowStyle, padding: '8px 16px' }, key: `history-${index}` },
            React.createElement('div', { style: subStyle },
              `${new Date(row.at).toLocaleTimeString('zh-CN', { hour12: false })} · ${t(`level${row.level}`) ?? row.level} · ${row.reason}`),
            null))
        }
      } else {
        vitalsRows.push(React.createElement('div', { style: { padding: '8px 16px' }, key: 'history-empty' },
          React.createElement('div', { style: subStyle }, t('noHistory'))))
      }
      vitalsRows.push(React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', padding: '12px 16px' }, key: 'controls' },
        React.createElement('button', { type: 'button', style: buttonStyle, disabled: saving, onClick: () => control('beat-now') }, t('beatNow')),
        React.createElement('button', { type: 'button', style: buttonStyle, disabled: saving, onClick: () => control('snooze', { minutes: 30 }) }, t('snooze')),
        React.createElement('button', { type: 'button', style: buttonStyle, disabled: saving, onClick: () => control('pause') }, t('pause')),
        React.createElement('button', { type: 'button', style: buttonStyle, disabled: saving, onClick: () => control('resume') }, t('resume')),
        React.createElement('button', { type: 'button', style: buttonStyle, disabled: saving, onClick: () => control('reset') }, t('reset'))))

      return React.createElement('div', { style: { padding: '8px 0' } },
        React.createElement('div', { style: { ...rowStyle, background: 'var(--dsw-alias-bg-layer-1, transparent)' } },
          React.createElement('div', { style: { ...labelStyle, fontWeight: 600 } }, t('vitals'))),
        ...vitalsRows,
        ...rows,
        error !== undefined ? React.createElement('div', { style: errorStyle }, t('saveFailed'), error) : null,
      )
    }

    // ---------------- 设置侧栏标记（导航图标：描边爱心） ----------------
    //
    // Inlined from lib/settings-nav-icon.js: the client bundle can only require
    // platform seeds, so the claim logic lives here in the same shape. The
    // canonical module (with its tests) is the source of truth; this mirrors it.
    //
    // 官方 settings.section 只投影 id / order / label，没有 icon 可传；设置 shell
    // 的 navIcon(id) 只认一小撮白名单 id，其余一律回落到它自己的齿轮。所以我们
    // 挂载后按 label 认出自己那一行，藏掉齿轮、用 mask 画自己的标记。
    // 规格与 dsh-plugin-memory 统一：16×16 网格、stroke 1.3、纯黑 alpha（颜色由
    // currentColor 提供）。官方哪天给 settings.section 长出 icon 字段，这段即可删除。
    const NAV_ROW_SELECTOR = '[role="dialog"] nav button'
    const NAV_ICON_ATTR = 'data-dsh-heartbeat-nav-icon'
    const ICON_MEDIUM_STROKE = 1.3
    const HEART_PATH = 'M12.667 9.333c0.993-0.973 2-2.14 2-3.667A3.667 3.667 0 0 0 11 2c-1.173 0-2 0.333-3 1.333c-1-1-1.827-1.333-3-1.333A3.667 3.667 0 0 0 1.333 5.667c0 1.533 1 2.7 2 3.667l4.667 4.667Z'
    const heartSvg = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="${ICON_MEDIUM_STROKE}" stroke-linecap="round" stroke-linejoin="round"><path d="${HEART_PATH}"/></svg>`
    const heartMaskUrl = (svg = heartSvg()) => `data:image/svg+xml,${encodeURIComponent(svg)}`
    const navIconCss = (maskUrl) => [
      `[${NAV_ICON_ATTR}] > svg { display: none; }`,
      `[${NAV_ICON_ATTR}]::before {`,
      `  content: '';`,
      `  flex: none;`,
      `  width: 16px;`,
      `  height: 16px;`,
      `  background-color: currentColor;`,
      `  -webkit-mask-image: url("${maskUrl}");`,
      `  mask-image: url("${maskUrl}");`,
      `  -webkit-mask-repeat: no-repeat;`,
      `  mask-repeat: no-repeat;`,
      `  -webkit-mask-position: center;`,
      `  mask-position: center;`,
      `  -webkit-mask-size: contain;`,
      `  mask-size: contain;`,
      `}`,
    ].join('\n')
    const isOwnNavRow = (rowText, wantedLabel) => {
      const wanted = String(wantedLabel == null ? '' : wantedLabel).trim()
      if (wanted.length === 0) return false
      return String(rowText == null ? '' : rowText).trim() === wanted
    }
    /** 认领设置侧栏里我们自己那一行；返回 teardown。 */
    function claimNavIcon(readLabel) {
      const style = document.createElement('style')
      style.textContent = navIconCss(heartMaskUrl())
      document.head.appendChild(style)
      const sync = () => {
        const rows = document.querySelectorAll(NAV_ROW_SELECTOR)
        const want = readLabel()
        for (const row of rows) {
          if (isOwnNavRow(row.textContent, want)) row.setAttribute(NAV_ICON_ATTR, '')
          else row.removeAttribute(NAV_ICON_ATTR)
        }
      }
      sync()
      // 语言切换 / 面板重挂载后重新认领，保证 label 与标记永不打架。
      const observer = new MutationObserver(sync)
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      return () => {
        observer.disconnect()
        style.remove()
        for (const row of document.querySelectorAll(`[${NAV_ICON_ATTR}]`)) row.removeAttribute(NAV_ICON_ATTR)
      }
    }

    function apply(ctx) {
      // Language packs ride DSH's own locale layer: the panel follows
      // 设置 → 通用设置 → 语言 instead of guessing from navigator.language.
      ctx.effect(() => ctx.locale.register(LOCALE_NS, DICTS), 'heartbeat: dictionaries')
      /** Sidebar label in the active language (zh `心跳` / en `Heartbeat`). */
      const labelOf = () => {
        let active = 'zh'
        try {
          active = ctx.locale.getSnapshot().active === 'en' ? 'en' : 'zh'
        } catch {
          active = 'zh'
        }
        return DICTS[active].sectionLabel
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'heartbeat',
        order: 100,
        locale: LOCALE_NS,
        label: labelOf,
      }, HeartbeatSection))
      // 官方 settings.section 没有 icon 字段，侧栏爱心标记只能靠自己认领；
      // 认领键就是当前语言的 label（语言切换后 MutationObserver 会重新对齐）。
      ctx.effect(() => claimNavIcon(labelOf), 'heartbeat: settings nav icon')
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    // Test seam: the browser half cannot be imported by Node, so pure helpers
    // are exposed for the vm harness.
    exports.__test = { DICTS, LOCALE_NS, fallbackT, formatDuration, stateOf, clampMinutes, HEART_PATH }
    return module.exports
  },
})
