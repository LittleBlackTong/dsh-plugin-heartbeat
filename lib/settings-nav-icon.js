/**
 * 心跳插件的设置侧栏标记（导航图标）：一个描边爱心。
 *
 * 为什么需要这个模块：官方 `settings.section` 槽**只投影 id / order / label**，
 * 没有 icon 字段可传；设置 shell 的 `navIcon(id)` 只认一小撮白名单 id
 * （account / models / agent-presets / plugins / archived-sessions），其余一律
 * 回落到它自己的齿轮。所以注册方拿不到图标位。
 *
 * 做法（与 dsh-plugin-memory 的 `settings-nav-icon.js`、dsh-market 的
 * `settings-nav-icon.ts` 同款）：挂载后按 **label 文本**认出自己那一行，给它打
 * 一个标记属性，再注入样式把 shell 的齿轮藏掉、用 mask 画我们自己的标记。
 * MutationObserver 跟着语言切换/重挂载重新认领；调用方的 disposer 负责摘干净。
 *
 * 范围刻意收窄：**只碰我们自己那一行**，不触摸任何 shell 结构。
 * 官方哪天给 `settings.section` 长出 `icon` 字段，本模块即可删除。
 *
 * ## 规格（与 memory 插件统一）
 *
 * 16×16 网格、`ICON_MEDIUM_STROKE` = 1.3、`stroke-linecap/linejoin="round"`、
 * 纯黑描边（mask 只读 alpha，可见颜色来自 `background-color: currentColor`，
 * 因此深浅主题都跟随）。
 *
 * @module dsh-plugin-heartbeat/settings-nav-icon
 */

/** 设置面板的 nav 行：shell 把每个 `settings.section` 渲染成 `<nav>` 里的一个 button。 */
export const NAV_ROW_SELECTOR = '[role="dialog"] nav button'

/** 认领标记。样式只挂在带此属性的行上，绝不波及别人。 */
export const NAV_ICON_ATTR = 'data-dsh-heartbeat-nav-icon'

/**
 * 本区块的 label。
 *
 * 它同时是**显示文案**和**认领时的匹配键**——两者必须是同一个字符串，
 * 否则语言切换后行与标记会对不上。
 */
export const HEARTBEAT_SECTION_LABEL = 'Heartbeat'

/** 与官方 `ICON_MEDIUM_STROKE` 一致，保证与相邻区块图标视觉重量相同。 */
export const ICON_MEDIUM_STROKE = 1.3

/**
 * 爱心轮廓（单个闭合 path，16×16 网格，左右对称）。
 *
 * 来源：Lucide `heart`（24 网格）按 2/3 缩放到 16 网格后手写为 path 指令；
 * 尖朝下、双瓣朝上，横向落在 1.33–14.67、纵向 2–14，与 memory 的大脑图标
 * 留白相近。
 */
export const HEART_PATH = 'M12.667 9.333c0.993-0.973 2-2.14 2-3.667A3.667 3.667 0 0 0 11 2c-1.173 0-2 0.333-3 1.333c-1-1-1.827-1.333-3-1.333A3.667 3.667 0 0 0 1.333 5.667c0 1.533 1 2.7 2 3.667l4.667 4.667Z'

/**
 * 标记的 SVG 源码。
 *
 * 描边用纯黑是**故意的**：mask 只读 alpha，可见颜色来自承载元素的
 * `background-color: currentColor`，所以深浅主题都能跟随。
 *
 * @param {string} [path] 覆盖轮廓（测试用）。
 * @returns {string} 一个 16×16 的 outline SVG。
 */
export function heartSvg(path = HEART_PATH) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="${ICON_MEDIUM_STROKE}" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`
}

/**
 * 标记的 CSS `mask-image` URL。运行时编码，不手写转义。
 *
 * @param {string} [svg] 覆盖默认标记（测试用）。
 * @returns {string} `data:image/svg+xml,...` URL。
 */
export function heartMaskUrl(svg = heartSvg()) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/**
 * 这一行是不是我们自己那一行。
 *
 * 这是本功能**唯一的判断**，所以刻意做成纯函数、精确匹配（trim 之后）：
 * 认错行就会把别人的图标盖掉，因此不做子串匹配。空 label 谁都不匹配——
 * 语言尚未就绪时不能把整个 nav 都认领了。
 *
 * @param {string | null | undefined} rowText 该行的可见文本。
 * @param {string | null | undefined} wantedLabel 期望的区块 label。
 * @returns {boolean} 是否为我们的行。
 */
export function isOwnNavRow(rowText, wantedLabel) {
  const wanted = String(wantedLabel ?? '').trim()
  if (wanted.length === 0) return false
  return String(rowText ?? '').trim() === wanted
}

/**
 * 认领行的样式表：藏掉 shell 的齿轮，用 mask 画出我们的标记。
 *
 * @param {string} maskUrl 由 {@link heartMaskUrl} 产出的 URL。
 * @returns {string} 可直接塞进 `<style>` 的 CSS。
 */
export function navIconCss(maskUrl) {
  return [
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
}
