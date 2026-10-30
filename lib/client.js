/**
 * dsh-plugin-heartbeat 客户端半（零构建）：
 * 在设置面板注册「Heartbeat」区块 —— 开关 + 频率 + 无人值守暂停 + 任务巡检。
 * 侧栏图标为描边爱心（与 dsh-plugin-memory 的图标规格统一）。
 *
 * 数据通道：settings wire 只服务硬编码白名单（heartbeat 不在其中），
 * 因此本区块直连插件自建的 HTTP 路由（/api/heartbeat/config）：
 * GET 读配置、POST 部分更新，Host 校验并立即热应用。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-heartbeat',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    let react = require('react')

    const React = react
    const CONFIG_URL = '/api/heartbeat/config'

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

    function HeartbeatSection() {
      return React.createElement(SectionBoundary, null, React.createElement(HeartbeatForm))
    }

    function HeartbeatForm() {
      const [config, setConfig] = React.useState(undefined)
      const [status, setStatus] = React.useState('loading')
      const [error, setError] = React.useState(undefined)
      const [saving, setSaving] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        fetch(CONFIG_URL)
          .then(async (response) => {
            if (!response.ok) throw new Error(`GET ${response.status}`)
            return response.json()
          })
          .then((value) => {
            if (!alive) return
            setConfig(value)
            setStatus('ready')
          })
          .catch((err) => {
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
            React.createElement('div', { style: subStyle }, '连续 N 拍你没回复就自动暂停，你下一条消息立即恢复'),
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
            React.createElement('div', { style: labelStyle }, '任务巡检'),
            React.createElement('div', { style: subStyle }, '每拍读一次会话里的待办/团队任务/目标，有该做没拍板的事就问你，不擅自开工'),
          ),
          React.createElement(Toggle, {
            checked: value.taskNudge !== false,
            disabled,
            onChange: (next) => apply({ taskNudge: next }),
          }),
        ),
        React.createElement('div', { style: rowStyle },
          React.createElement('div', null,
            React.createElement('div', { style: labelStyle }, '巡检条目上限'),
            React.createElement('div', { style: subStyle }, '任务快照里每类最多列几项，控制心跳的 token 开销'),
          ),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            React.createElement('input', {
              type: 'number',
              min: 1,
              max: 20,
              disabled,
              value: value.taskNudgeMaxItems ?? 5,
              onChange: (event) => {
                const count = Number(event.target.value)
                if (Number.isFinite(count) && count >= 1 && count <= 20) {
                  apply({ taskNudgeMaxItems: Math.round(count) })
                }
              },
              style: inputStyle,
            }),
            React.createElement('span', { style: labelStyle }, '项'),
          ),
        ),
        error !== undefined ? React.createElement('div', { style: errorStyle }, '保存失败：', error) : null,
        React.createElement('div', { style: { padding: '14px 16px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #888)' } },
          `当前：${value.enabled === false ? '已暂停' : `每 ${clampMinutes(value.intervalSeconds)} 分钟一次`}。修改即时生效，下一个周期起用。`,
        ),
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
    const HEARTBEAT_SECTION_LABEL = 'Heartbeat'
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
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'heartbeat',
        order: 100,
        label: () => HEARTBEAT_SECTION_LABEL,
      }, HeartbeatSection))
      // 官方 settings.section 没有 icon 字段，侧栏爱心标记只能靠自己认领。
      ctx.effect(() => claimNavIcon(() => HEARTBEAT_SECTION_LABEL), 'heartbeat: settings nav icon')
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
