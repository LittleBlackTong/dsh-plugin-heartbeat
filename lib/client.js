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
    const ACTIVITY_POLL_MS = 5000

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
        activityRunning: '子智能体执行中',
        activityPillHint: '来自宿主真实状态：子智能体仍在运行，主会话本轮已结束',
        proactiveCooldown: '发言权仲裁窗口',
        proactiveCooldownHint: '与其他主动插件（如 memory）互让；0 = 关闭仲裁',
        proactiveCooldownUnit: '分钟',
        userActiveSuppress: '你在场时静默',
        userActiveSuppressHint: '你刚说过话的这段时间内不主动开口；0 = 不抑制',
        userActiveSuppressUnit: '秒',
        physiologyLine: '消息带状态行',
        physiologyLineHint: '在心跳消息里带一行「距你上次说话 …」',
        l3Granted: '已授权：{list}',
        l3None: '未授权任何类别（默认全关）',
        l3Join: '、',
        l3GrantedHint: '授权摘要（不可逆操作仍由审批拦截）',
        diagnostics: '诊断',
        diagnosticsHint: '最近几次为什么没开口，以及当前发言权在谁手里',
        floorIdle: '空闲',
        floorHeldBy: '{name} 持有（{when}）',
        floorLine: '当前发言权：{value}',
        floorNow: '刚刚',
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
        activityRunning: 'subagents working',
        activityPillHint: 'Host truth: child agents are still running after this turn ended',
        proactiveCooldown: 'Speech-floor cooldown',
        proactiveCooldownHint: 'Yield to other proactive plugins (e.g. memory); 0 = arbitration off',
        proactiveCooldownUnit: 'minutes',
        userActiveSuppress: 'Quiet after you speak',
        userActiveSuppressHint: 'Stay silent this long after your last message; 0 = never suppress',
        userActiveSuppressUnit: 'seconds',
        physiologyLine: 'Physiology line',
        physiologyLineHint: 'Add a "since your last message …" line to beats',
        l3Granted: 'Granted: {list}',
        l3None: 'No categories granted (all off by default)',
        l3Join: ', ',
        l3GrantedHint: 'Grant summary (irreversible actions still ask for approval)',
        diagnostics: 'Diagnostics',
        diagnosticsHint: 'Why recent pulses stayed quiet, and who currently holds the speech floor',
        floorIdle: 'idle',
        floorHeldBy: '{name} holds ({when})',
        floorLine: 'Speech floor: {value}',
        floorNow: 'just now',
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

    /**
     * Live child activity for one session out of a `/api/heartbeat/status`
     * payload. Defensive: any malformed payload degrades to "no children".
     * @param {unknown} json STATUS route body
     * @param {string} sessionId session whose children to read
     * @returns {{total: number, running: number}}
     */
    function childrenOfStatus(json, sessionId) {
      const sessions = json !== null && typeof json === 'object' && Array.isArray(json.sessions) ? json.sessions : []
      const row = sessions.find((item) => item !== null && typeof item === 'object' && item.sessionId === sessionId)
      const children = row !== null && typeof row === 'object' && row.children !== null && typeof row.children === 'object'
        ? row.children
        : undefined
      const total = Math.max(0, Math.round(Number(children?.total) || 0))
      const running = Math.min(total, Math.max(0, Math.round(Number(children?.running) || 0)))
      return { total, running }
    }

    /** Local `{name}` interpolation: the host `t` seat does not interpolate. */
    function fill(template, params) {
      if (typeof template !== 'string') return ''
      const map = params !== null && typeof params === 'object' ? params : {}
      return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name) => (Object.hasOwn(map, name) ? String(map[name]) : whole))
    }

    /** Local `HH:MM` clock, used by the floor/diagnostics lines. */
    function formatClock(at) {
      const value = Number(at)
      if (!Number.isFinite(value) || value <= 0) return ''
      try {
        return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      } catch {
        return ''
      }
    }

    /** Human summary of the L3 grants: "已授权：读取 / 检索、跑测试 / 构建". */
    function l3SummaryOf(grants, t) {
      const translate = typeof t === 'function' ? t : fallbackT
      const list = Array.isArray(grants) ? grants.filter((item) => typeof item === 'string' && item.length > 0) : []
      if (list.length === 0) return translate('l3None')
      const labels = list.map((category) => {
        const key = `l3${category}`
        const label = translate(key)
        return typeof label === 'string' && label !== key ? label : category
      })
      return fill(translate('l3Granted'), { list: labels.join(translate('l3Join')) })
    }

    /** Newest-first pulse explanations for the diagnostics block (max 5). */
    function recentPulsesOf(session, t, limit = 5) {
      const translate = typeof t === 'function' ? t : fallbackT
      const history = Array.isArray(session?.history) ? session.history : []
      const capped = Math.max(0, Math.round(Number(limit) || 0))
      return history.slice(-capped).reverse().map((row) => {
        const level = typeof row?.level === 'string' ? row.level : ''
        const reason = typeof row?.reason === 'string' ? row.reason : ''
        const translated = level === '' ? '' : translate(`level${level}`)
        const label = level === '' ? '' : (translated === `level${level}` ? level : translated)
        const text = [formatClock(row?.at), label, reason].filter((part) => part !== '').join(' · ')
        return { at: row?.at, level, reason, text }
      })
    }

    /** Current speech-floor holder as one line. */
    function floorTextOf(lock, t) {
      const translate = typeof t === 'function' ? t : fallbackT
      if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) return translate('floorIdle')
      if (typeof lock.speaker !== 'string' || lock.speaker.length === 0) return translate('floorIdle')
      return fill(translate('floorHeldBy'), {
        name: lock.speaker,
        when: formatClock(lock.at) || translate('floorNow'),
      })
    }

    /**
     * The whole diagnostics block as data: the newest pulse explanations plus a
     * labelled floor line. Pure so the vm harness can assert it without hooks.
     * @param {{history?: unknown[], lock?: unknown} | undefined} session one STATUS row
     * @param {(key: string) => string} [t] translate seat
     * @returns {{hint: string, pulses: string[], floor: string, empty: boolean}}
     */
    function diagnosticsOf(session, t) {
      const translate = typeof t === 'function' ? t : fallbackT
      const pulses = recentPulsesOf(session, translate).map((pulse) => pulse.text)
      return {
        hint: translate('diagnosticsHint'),
        pulses,
        floor: fill(translate('floorLine'), { value: floorTextOf(session?.lock, translate) }),
        empty: pulses.length === 0,
      }
    }

    /** Element tree for the header activity pill, or null when no child runs. */
    function renderActivityPill(activity, t) {
      const translate = typeof t === 'function' ? t : fallbackT
      const running = Math.max(0, Math.round(Number(activity?.running) || 0))
      if (running <= 0) return null
      return React.createElement('span', {
        title: translate('activityPillHint'),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          padding: '2px 8px',
          borderRadius: '999px',
          fontSize: '12px',
          lineHeight: '18px',
          color: 'var(--dsw-alias-label-secondary, #888)',
          background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12))',
          whiteSpace: 'nowrap',
        },
      },
      React.createElement('span', {
        style: {
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: 'var(--dsw-alias-state-success-primary, #22a06b)',
          display: 'inline-block',
          animation: 'dsh-heartbeat-activity-pulse 1.6s ease-in-out infinite',
        },
      }),
      React.createElement('span', null, `${translate('activityRunning')} · ${running}`))
    }

    /**
     * Header pill that keeps "child agents still working" visible after the
     * parent turn ended. The host only recomputes a session's list `running`
     * flag on agent add/dispose and forwards `api-session/status` per session
     * resource, so the conversation header can otherwise show a finished turn
     * while a background subagent is still executing. This pill reads the
     * plugin's own host truth on a short poll — paused while the document is
     * hidden so a background tab never keeps churning — and renders nothing
     * unless children are actually running.
     * @param {{sessionId?: string, t?: (key: string) => string}} props slot seats
     * @returns The pill, or null while no child is running
     */
    function ActivityPill({ sessionId, t }) {
      const translate = typeof t === 'function' ? t : fallbackT
      const [activity, setActivity] = React.useState(null)
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
        let alive = true
        let timer
        const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
        const load = () => {
          fetch(STATUS_URL)
            .then((response) => (response.ok ? response.json() : undefined))
            .then((json) => {
              if (!alive) return
              const next = childrenOfStatus(json, sessionId)
              setActivity(next.running > 0 ? next : null)
            })
            .catch(() => {
              // host unreachable: stay hidden rather than claiming work
            })
        }
        const start = () => {
          if (timer !== undefined) return
          timer = setInterval(load, ACTIVITY_POLL_MS)
        }
        const stop = () => {
          if (timer === undefined) return
          clearInterval(timer)
          timer = undefined
        }
        const onVisibility = () => {
          if (hidden()) {
            stop()
          } else {
            load()
            start()
          }
        }
        document.addEventListener('visibilitychange', onVisibility)
        if (!hidden()) {
          load()
          start()
        }
        return () => {
          alive = false
          stop()
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [sessionId])
      return renderActivityPill(activity, translate)
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

      pushRow('proactiveCooldown', t('proactiveCooldown'), t('proactiveCooldownHint'), React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        React.createElement('input', {
          type: 'number',
          min: 0,
          max: 1440,
          disabled,
          value: Math.round(Number(value.proactiveCooldownSeconds ?? 180) / 60),
          onChange: (event) => {
            const minutes = Number(event.target.value)
            if (Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440) apply({ proactiveCooldownSeconds: Math.round(minutes) * 60 })
          },
          style: inputStyle,
        }),
        React.createElement('span', { style: labelStyle }, t('proactiveCooldownUnit'))))

      pushRow('userActiveSuppress', t('userActiveSuppress'), t('userActiveSuppressHint'), React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        React.createElement('input', {
          type: 'number',
          min: 0,
          max: 86400,
          disabled,
          value: Math.round(Number(value.userActiveSuppressSeconds ?? 120)),
          onChange: (event) => {
            const seconds = Number(event.target.value)
            if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400) apply({ userActiveSuppressSeconds: Math.round(seconds) })
          },
          style: inputStyle,
        }),
        React.createElement('span', { style: labelStyle }, t('userActiveSuppressUnit'))))

      pushRow('physiologyLine', t('physiologyLine'), t('physiologyLineHint'), React.createElement(Toggle, {
        checked: value.physiologyLine !== false,
        disabled,
        onChange: (next) => apply({ physiologyLine: next }),
      }))

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
      pushRow('l3Summary', t('l3GrantedHint'), undefined, React.createElement('div', { style: subStyle }, l3SummaryOf(l3, t)))

      const vitalsRows = []
      vitalsRows.push(React.createElement('div', { style: rowStyle, key: 'state' },
        React.createElement('div', null,
          React.createElement('div', { style: labelStyle }, t('vitals')),
          React.createElement('div', { style: subStyle },
            `${session !== undefined ? stateOf(session, t) : '—'} · ${t('nextBeat')} ${session !== undefined ? formatDuration(Number(session.nextBeatAt) - Date.now(), t('never')) : t('never')}`),
        ),
        React.createElement('div', { style: labelStyle },
          budgetMax === 0 ? `${budgetUsed} / ∞` : `${budgetUsed} / ${budgetMax}`)))
      vitalsRows.push(React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', padding: '12px 16px' }, key: 'controls' },
        React.createElement('button', { type: 'button', style: buttonStyle, disabled: saving, onClick: () => control('beat-now') }, t('beatNow')),
        React.createElement('button', { type: 'button', style: buttonStyle, disabled: saving, onClick: () => control('snooze', { minutes: 30 }) }, t('snooze')),
        React.createElement('button', { type: 'button', style: buttonStyle, disabled: saving, onClick: () => control('pause') }, t('pause')),
        React.createElement('button', { type: 'button', style: buttonStyle, disabled: saving, onClick: () => control('resume') }, t('resume')),
        React.createElement('button', { type: 'button', style: buttonStyle, disabled: saving, onClick: () => control('reset') }, t('reset'))))

      // Diagnostics: why recent pulses stayed quiet (newest first) and who holds
      // the speech floor right now. Reuses the history renderer, reasons verbatim.
      const diagnostics = diagnosticsOf(session, t)
      const diagnosticsRows = [
        React.createElement('div', { style: { padding: '8px 16px' }, key: 'diagnostics-hint' },
          React.createElement('div', { style: subStyle }, diagnostics.hint)),
        ...(diagnostics.empty
          ? [React.createElement('div', { style: { padding: '4px 16px' }, key: 'diagnostics-empty' },
            React.createElement('div', { style: subStyle }, t('noHistory')))]
          : diagnostics.pulses.map((text, index) => React.createElement('div', {
            style: { padding: '4px 16px' },
            key: `diagnostics-pulse-${index}`,
          }, React.createElement('div', { style: subStyle }, text)))),
        React.createElement('div', { style: { padding: '4px 16px' }, key: 'diagnostics-floor' },
          React.createElement('div', { style: subStyle }, diagnostics.floor)),
      ]

      return React.createElement('div', { style: { padding: '8px 0' } },
        React.createElement('div', { style: { ...rowStyle, background: 'var(--dsw-alias-bg-layer-1, transparent)' } },
          React.createElement('div', { style: { ...labelStyle, fontWeight: 600 } }, t('vitals'))),
        ...vitalsRows,
        React.createElement('div', { style: { padding: '8px 0' } },
          React.createElement('div', { style: { ...rowStyle, background: 'var(--dsw-alias-bg-layer-1, transparent)' } },
            React.createElement('div', { style: { ...labelStyle, fontWeight: 600 } }, t('diagnostics'))),
          ...diagnosticsRows),
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
      // Conversation header pill: a background subagent keeps running after the
      // parent turn ends, and DSH's own header cannot always see that (the host
      // forwards child status per session resource). Reading our own host truth
      // keeps "still working" visible until the child settles.
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'heartbeat-activity',
        order: 20,
        locale: LOCALE_NS,
      }, ActivityPill))
      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = '@keyframes dsh-heartbeat-activity-pulse{0%,100%{opacity:1}50%{opacity:.35}}'
        document.head.appendChild(style)
        return () => style.remove()
      }, 'heartbeat: activity pill style')
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    // Test seam: the browser half cannot be imported by Node, so pure helpers
    // are exposed for the vm harness.
    exports.__test = {
      DICTS, LOCALE_NS, fallbackT, formatDuration, stateOf, clampMinutes, HEART_PATH,
      childrenOfStatus, ActivityPill, fill, l3SummaryOf, recentPulsesOf, floorTextOf, diagnosticsOf, renderActivityPill,
    }
    return module.exports
  },
})
