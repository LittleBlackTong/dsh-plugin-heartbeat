/**
 * dsh-plugin-heartbeat 客户端半（零构建）：
 *
 * 1. 设置 →「心跳 Heartbeat」页：开关 / 频率 / 无人应答暂停 / 汇总到心跳报告 /
 *    报告保留条数 / 判级模型（默认 = Harness 默认模型，标注最便宜推荐）。
 * 2. 设置 →「心跳报告」页：各会话心跳汇总列表，正常绿点、异常红/黄点；
 *    打开页面即视为已读（自动清点），不弹窗、不打断任何会话。
 * 3. 折叠侧栏未读小圆点（sidebar.toggle.badge）。
 *
 * 数据通道：settings wire 只服务硬编码白名单（heartbeat 不在其中），
 * 因此直连插件自建 HTTP 路由：/api/heartbeat/config、/api/heartbeat/reports、
 * /api/heartbeat/models。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-heartbeat',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    let react = require('react')

    const React = react
    const CONFIG_URL = '/api/heartbeat/config'
    const REPORTS_URL = '/api/heartbeat/reports'
    const MODELS_URL = '/api/heartbeat/models'
    const REPORTS_OPEN_URL = '/api/heartbeat/reports/open'

    const clampMinutes = (seconds) => Math.max(1, Math.round((Number(seconds) || 0) / 60))

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
    const selectStyle = {
      maxWidth: '260px',
      padding: '6px 8px',
      fontSize: '13px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      color: 'var(--dsw-alias-label-primary, inherit)',
    }

    const LEVEL_COLORS = {
      ok: 'var(--dsw-alias-state-success-primary, #3fbf6f)',      // 绿：正常
      decide: 'var(--dsw-alias-brand-primary, #4c8bf5)',          // 蓝：需要用户决策
      warn: 'var(--dsw-alias-state-warn-primary, #f5a623)',       // 黄：异常
      info: 'var(--dsw-alias-state-idle-primary, #8a9199)',       // 灰：信息
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

    function Dot({ level, title }) {
      return React.createElement('span', {
        title,
        style: {
          width: 10,
          height: 10,
          borderRadius: '50%',
          flex: 'none',
          display: 'inline-block',
          background: LEVEL_COLORS[level] ?? LEVEL_COLORS.info,
        },
      })
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

    // ======================= 设置页 1：心跳 =======================

    function HeartbeatForm() {
      const [config, setConfig] = React.useState(undefined)
      const [catalog, setCatalog] = React.useState(undefined)
      const [status, setStatus] = React.useState('loading')
      const [error, setError] = React.useState(undefined)
      const [saving, setSaving] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        Promise.all([
          fetch(CONFIG_URL).then((response) => {
            if (!response.ok) throw new Error(`GET ${response.status}`)
            return response.json()
          }),
          fetch(MODELS_URL).then((response) => (response.ok ? response.json() : null)).catch(() => null),
        ]).then(([value, models]) => {
          if (!alive) return
          setConfig(value)
          setCatalog(models)
          setStatus('ready')
        }).catch((err) => {
          if (!alive) return
          setStatus('failed')
          setError(err instanceof Error ? err.message : String(err))
        })
        return () => {
          alive = false
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
          })
          .catch((err) => {
            setError(err instanceof Error ? err.message : String(err))
          })
          .finally(() => setSaving(false))
      }

      if (status === 'loading') {
        return React.createElement('div', { style: { padding: '14px 16px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #888)' } }, '读取配置中…')
      }
      if (status === 'failed') return React.createElement(ErrorText, { message: error ?? 'unknown' })

      const value = config ?? {}
      const disabled = saving
      const report = value.report ?? { enabled: false, retention: 200, model: undefined }

      const applyReport = (patch) => apply({
        report: {
          enabled: patch.enabled !== undefined ? patch.enabled : report.enabled,
          retention: patch.retention !== undefined ? patch.retention : report.retention,
          model: patch.model !== undefined ? patch.model : report.model,
        },
      })

      // ---- 判级模型选择 ----
      const defaultLabel = catalog?.default
        ? `默认（${catalog.default.provider}/${catalog.default.model}）`
        : '默认（Harness 默认模型）'
      const selectedKey = report.model ? `${report.model.provider}\u0000${report.model.model}` : 'default'
      const options = []
      options.push(React.createElement('option', { key: 'default', value: 'default' }, defaultLabel))
      for (const item of catalog?.models ?? []) {
        const key = `${item.provider}\u0000${item.model}`
        const rec = catalog?.recommended
          && catalog.recommended.provider === item.provider
          && catalog.recommended.model === item.model
        const cheapest = rec ? ' · 最便宜(推荐)' : ''
        options.push(React.createElement('option', { key, value: key }, `${item.provider}/${item.model}${cheapest}`))
      }

      return React.createElement('div', { style: { padding: '8px 0' } },
        React.createElement('div', { style: rowStyle },
          React.createElement('div', null,
            React.createElement('div', { style: labelStyle }, '启用心跳'),
            React.createElement('div', { style: subStyle }, '到点主动汇报进展/风险，没事也会冒个泡'),
          ),
          React.createElement(Toggle, {
            checked: value.enabled !== false,
            disabled,
            onChange: (next) => apply({ enabled: next }),
          }),
        ),
        React.createElement('div', { style: rowStyle },
          React.createElement('div', null,
            React.createElement('div', { style: labelStyle }, '心跳频率'),
            React.createElement('div', { style: subStyle }, '最小 1 分钟；忙碌时不打断，任务结束补一句'),
          ),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            React.createElement('input', {
              type: 'number',
              min: 1,
              max: 1440,
              disabled,
              value: clampMinutes(value.intervalSeconds),
              onChange: (event) => {
                const minutes = Number(event.target.value)
                if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440) {
                  apply({ intervalSeconds: Math.round(minutes * 60) })
                }
              },
              style: inputStyle,
            }),
            React.createElement('span', { style: labelStyle }, '分钟'),
          ),
        ),
        React.createElement('div', { style: rowStyle },
          React.createElement('div', null,
            React.createElement('div', { style: labelStyle }, '无人回应时暂停'),
            React.createElement('div', { style: subStyle }, '连续 N 拍你没有回应就自动暂停，你的下一条消息立即恢复'),
          ),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            React.createElement('input', {
              type: 'number',
              min: 0,
              max: 100,
              disabled,
              value: value.pauseAfterMissed ?? 3,
              onChange: (event) => {
                const beats = Number(event.target.value)
                if (Number.isFinite(beats) && beats >= 0 && beats <= 100) {
                  apply({ pauseAfterMissed: Math.round(beats) })
                }
              },
              style: inputStyle,
            }),
            React.createElement('span', { style: labelStyle }, '拍（0 = 关闭）'),
          ),
        ),
        React.createElement('div', { style: rowStyle },
          React.createElement('div', null,
            React.createElement('div', { style: labelStyle }, '汇总到心跳报告'),
            React.createElement('div', { style: subStyle }, '各会话静默心跳（0 token），统一汇总到「心跳报告」页查看'),
          ),
          React.createElement(Toggle, {
            checked: report.enabled === true,
            disabled,
            onChange: (next) => applyReport({ enabled: next }),
          }),
        ),
        React.createElement('div', { style: rowStyle },
          React.createElement('div', null,
            React.createElement('div', { style: labelStyle }, '报告保留条数'),
            React.createElement('div', { style: subStyle }, '心跳报告页最多保留的条目数'),
          ),
          React.createElement('input', {
            type: 'number',
            min: 10,
            max: 1000,
            disabled,
            value: report.retention ?? 200,
            onChange: (event) => {
              const retention = Number(event.target.value)
              if (Number.isFinite(retention) && retention >= 10 && retention <= 1000) {
                applyReport({ retention: Math.round(retention) })
              }
            },
            style: inputStyle,
          }),
        ),
        React.createElement('div', { style: rowStyle },
          React.createElement('div', null,
            React.createElement('div', { style: labelStyle }, '判级模型'),
            React.createElement('div', { style: subStyle }, '只用于「疑似异常」时的汇总判级；默认跟随 Harness 默认模型'),
          ),
          React.createElement('select', {
            disabled,
            value: selectedKey,
            onChange: (event) => {
              const key = event.target.value
              if (key === 'default') {
                applyReport({ model: null })
              } else {
                const [provider, model] = key.split('\u0000')
                applyReport({ model: { provider, model } })
              }
            },
            style: selectStyle,
          }, options),
        ),
        error !== undefined ? React.createElement('div', { style: errorStyle }, '保存失败：', error) : null,
        React.createElement('div', { style: { padding: '14px 16px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #888)' } },
          `当前：${value.enabled === false ? '已暂停' : `每 ${clampMinutes(value.intervalSeconds)} 分钟一次`}；${report.enabled ? '心跳汇总已开启' : '各会话各自应答'}。修改即时生效，下一个周期起用。`,
        ),
        // 心跳报告：直接内嵌在本页（无需再找入口）
        React.createElement('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2))' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px 2px' } },
            React.createElement(OpenReportButton, null, '心跳报告'),
            React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #999)' } }, '点击标题在资源管理器中打开 .md 完整报告'),
          ),
          React.createElement(InlineReport, null),
        ),
      )
    }

    // ======================= 心跳报告（内嵌区块 + 独立页共用数据源）=======================

    const timeOf = (ts) => {
      const date = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function OpenReportButton({ children, style }) {
      const [busy, setBusy] = React.useState(false)
      return React.createElement('button', {
        type: 'button',
        disabled: busy,
        title: '在资源管理器中打开 heartbeat-report.md（完整报告）',
        onClick: () => {
          setBusy(true)
          fetch(REPORTS_OPEN_URL, { method: 'POST' })
            .catch(() => {})
            .finally(() => setBusy(false))
        },
        style: {
          background: 'transparent',
          border: 'none',
          padding: 0,
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          color: 'var(--dsw-alias-brand-primary, #4c8bf5)',
          textDecoration: 'underline',
          textUnderlineOffset: 3,
          ...(style ?? {}),
        },
      }, children)
    }

    function InlineReport() {
      const [data, setData] = React.useState(undefined)
      // null = 自动（无黄/蓝/红点时折叠，有时展开）；true/false = 用户手动覆盖
      const [collapsedOverride, setCollapsedOverride] = React.useState(null)
      const [showAll, setShowAll] = React.useState(false)
      React.useEffect(() => {
        let alive = true
        const load = () => {
          fetch(REPORTS_URL)
            .then(async (response) => {
              if (!response.ok) throw new Error(`GET ${response.status}`)
              return response.json()
            })
            .then((value) => {
              if (!alive) return
              setData(value)
            })
            .catch(() => {})
        }
        load()
        // 打开报告区块 = 人类在场（硬停锚点）；不涉及"未读/已读"
        fetch(REPORTS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'touch' }),
        }).catch(() => {})
        const timer = setInterval(load, 10000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      const entries = data?.entries ?? []
      const engine = data?.engine ?? {}
      const statusLine = data?.reportEnabled === false
        ? '心跳汇总未开启：打开上面的「汇总到心跳报告」开关即可。'
        : engine.status === 'running'
          ? `运行中 · 每 ${Math.round((engine.intervalSeconds ?? 600) / 60)} 分钟一拍 · 第 ${engine.tickCount ?? 0} 拍`
          : engine.status === 'paused'
            ? '已暂停（连续无人回应）：你发一条消息即可恢复'
            : '已停用'

      // 状态旗只由"每个会话最新的那一条"决定：会话修好后立刻变绿，
      // 历史条目只是时间线，不参与状态判断（因此不再需要未读/已读概念）。
      const attentionLevels = ['warn', 'decide']
      const latestPerSession = new Map()
      for (const entry of entries) {
        if (entry.kind === 'session' && entry.sessionId) latestPerSession.set(entry.sessionId, entry)
      }
      const attentionEntries = [...latestPerSession.values()].filter((entry) => attentionLevels.includes(entry.level))
      const hasAttention = attentionEntries.length > 0
      const prevAttention = React.useRef(hasAttention)
      React.useEffect(() => {
        // 新出现需要注意的条目时自动展开（清掉用户之前的折叠覆盖）
        if (hasAttention && !prevAttention.current) {
          setCollapsedOverride(null)
          setShowAll(false)
        }
        prevAttention.current = hasAttention
      }, [hasAttention])

      const collapsed = collapsedOverride === null ? !hasAttention : collapsedOverride
      const list = [...entries].reverse()
      const shown = showAll ? list : list.slice(0, 5)
      const worstLevel = attentionEntries.some((entry) => entry.level === 'warn')
        ? 'warn'
        : attentionEntries.some((entry) => entry.level === 'decide')
          ? 'decide'
          : 'ok'
      const worstText = { warn: '异常', decide: '需决策', ok: '全部正常' }[worstLevel]
      // 空列表也必须安全：摘要行是提前构造的，不能直接取 list[0]
      const newestTime = list[0] ? timeOf(list[0].time) : '—'

      const toggleButton = React.createElement('button', {
        type: 'button',
        // 取反：把"当前是否折叠"翻转，并成为用户的显式覆盖
        onClick: () => setCollapsedOverride(!collapsed),
        style: {
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          fontSize: 12,
          flex: 'none',
          color: 'var(--dsw-alias-brand-primary, #4c8bf5)',
        },
      }, collapsed ? '展开' : '折叠')

      const summaryRow = React.createElement('button', {
        type: 'button',
        onClick: () => setCollapsedOverride(false),
        style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', padding: '8px 16px 14px', textAlign: 'left' },
      },
        React.createElement(Dot, { level: worstLevel, title: worstText }),
        React.createElement('span', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #999)' } },
          hasAttention
            ? `${worstText} · ${attentionEntries.length} 条需要注意 · 共 ${entries.length} 条 · 最近 ${newestTime}（点击展开）`
            : `全部正常 · 共 ${entries.length} 条 · 最近 ${newestTime}（点击展开）`),
      )

      const entryList = React.createElement('div', null,
        shown.map((entry) => React.createElement('div', {
          key: entry.id,
          style: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2))' },
        },
          React.createElement(Dot, { level: entry.level }),
          React.createElement('div', { style: { flex: 1, minWidth: 0 } },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
              React.createElement('span', { style: { fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.source ?? '—'),
              React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #999)', flex: 'none' } }, timeOf(entry.time)),
            ),
            React.createElement('div', { style: { fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-secondary, #999)', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } }, entry.summary ?? ''),
          ),
        )),
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 16px', fontSize: 12 } },
          list.length > 5
            ? React.createElement('button', {
                type: 'button',
                onClick: () => setShowAll((v) => !v),
                style: { background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, color: 'var(--dsw-alias-brand-primary, #4c8bf5)' },
              }, showAll ? '收起' : `查看全部（共 ${list.length} 条）`)
            : React.createElement('span', null),
          React.createElement('button', {
            type: 'button',
            onClick: () => {
              fetch(REPORTS_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'clear' }),
              })
                .then(() => setData((previous) => (previous ? { ...previous, entries: [] } : previous)))
                .catch(() => {})
            },
            style: { background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #999)' },
          }, '清空'),
        ),
      )

      return React.createElement('div', { style: { padding: '0 0 8px' } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, padding: '6px 16px 8px' } },
          React.createElement('span', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #999)' } }, statusLine),
          entries.length > 0 ? toggleButton : null,
        ),
        entries.length === 0
          ? React.createElement('div', { style: { padding: '8px 16px 16px', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #999)' } }, '还没有心跳报告：开启汇总后，下一个心跳周期会出现在这里。')
          : collapsed
            ? summaryRow
            : entryList,
      )
    }

    // ======================= 设置页 2：心跳报告 =======================

    function ReportEntry({ entry, expanded, onToggle }) {
      const levelText = { warn: '异常', decide: '需决策', ok: '正常', info: '信息' }[entry.level] ?? entry.level
      return React.createElement('div', { style: { borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2))' } },
        React.createElement('button', {
          type: 'button',
          onClick: onToggle,
          style: {
            width: '100%',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
            padding: '12px 16px',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            color: 'var(--dsw-alias-label-primary, inherit)',
          },
        },
          React.createElement(Dot, { level: entry.level, title: levelText }),
          React.createElement('div', { style: { flex: 1, minWidth: 0 } },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
              React.createElement('span', { style: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.source ?? '—'),
              React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #999)', flex: 'none' } }, timeOf(entry.time)),
            ),
            React.createElement('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #999)', marginTop: 2 } }, entry.summary ?? ''),
          ),
        ),
        expanded ? React.createElement('pre', { style: {
          margin: '0 16px 12px 36px',
          padding: '8px 10px',
          fontSize: 11,
          lineHeight: '16px',
          borderRadius: 6,
          background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08))',
          color: 'var(--dsw-alias-label-secondary, #999)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        } }, JSON.stringify(entry.detail ?? {}, null, 2)) : null,
      )
    }

    function ReportPage() {
      const [data, setData] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [expanded, setExpanded] = React.useState(new Set())

      React.useEffect(() => {
        let alive = true
        const load = () => {
          fetch(REPORTS_URL)
            .then(async (response) => {
              if (!response.ok) throw new Error(`GET ${response.status}`)
              return response.json()
            })
            .then((value) => {
              if (!alive) return
              setData(value)
            })
            .catch((err) => {
              if (alive) setError(err instanceof Error ? err.message : String(err))
            })
        }
        load()
        // 打开报告页 = 人类在场（硬停锚点）
        fetch(REPORTS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'touch' }),
        }).catch(() => {})
        const timer = setInterval(load, 10000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      const toggle = (id) => {
        setExpanded((previous) => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      if (error !== undefined) return React.createElement(ErrorText, { message: error })

      const entries = data?.entries ?? []
      const engine = data?.engine ?? {}

      const statusLine = data?.reportEnabled === false
        ? '心跳汇总未开启：请到「心跳 Heartbeat」页打开「汇总到心跳报告」。'
        : engine.status === 'running'
          ? `运行中 · 每 ${Math.round((engine.intervalSeconds ?? 600) / 60)} 分钟一拍 · 第 ${engine.tickCount ?? 0} 拍`
          : engine.status === 'paused'
            ? '已暂停（连续无人回应）：你发一条消息即可恢复'
            : '已停用'

      return React.createElement('div', { style: { padding: '8px 0' } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px 4px' } },
          React.createElement(OpenReportButton, null, '心跳报告'),
          React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #999)' } }, '点击标题在资源管理器中打开 .md 完整报告'),
        ),
        React.createElement('div', { style: { padding: '4px 16px 12px', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #999)' } },
          statusLine,
        ),
        entries.length === 0
          ? React.createElement('div', { style: { padding: '24px 16px', fontSize: 13, color: 'var(--dsw-alias-label-secondary, #999)', textAlign: 'center' } },
            '还没有心跳报告。打开「汇总到心跳报告」后，下一个心跳周期就会出现在这里。')
          : [...entries].reverse().map((entry) => React.createElement(ReportEntry, {
              key: entry.id,
              entry,
              expanded: expanded.has(entry.id),
              onToggle: () => toggle(entry.id),
            })),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'heartbeat',
        order: 100,
        label: () => '心跳 Heartbeat',
      }, () => React.createElement(SectionBoundary, null, React.createElement(HeartbeatForm))))

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'heartbeat-report',
        order: 101,
        label: () => '心跳报告',
      }, () => React.createElement(SectionBoundary, null, React.createElement(ReportPage))))
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
