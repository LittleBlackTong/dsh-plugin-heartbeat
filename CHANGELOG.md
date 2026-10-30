# Changelog

所有记录跟随 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格；版本号与 `package.json` 保持一致。

## [0.7.0] - 2026-10-30

### Added（A 仲裁 + B 生理签名 + C 子智能体胶囊）

- **A 发言权仲裁（与 memory 插件共享协议）**：新增 `lib/proactive-lock.js`。投递前先 claim 共享文件 `${DSH_HOME:-~/.dsh}/proactive-cooldown.json`（`{ version: 1, speaker: 'heartbeat' | 'memory', at: <epoch ms> }`，tmp+rename 原子写）：若窗口内已有**其他 speaker** 的 claim，本拍让位并记 `L0 · proactive-cooldown（让位给 …）`，下一拍再试；`proactiveCooldownSeconds`（默认 **180**，`0` = 关闭；manual **Beat now** 绕过）。模块零 import 自 memory，双方各自独立实现同一协议——任一方可单独装/升级/卸载；读失败按「无锁」、写失败降级为「放行」（礼貌而非硬依赖）。
- **B 生理签名 / 社交节律**：新增 `lib/physiology.js`。L1/L2/L4 消息在 why-now 后可带一行 ≤60 字的状态（例：`〔状态：距你上次说话 2h · 今天第 3 次找你〕`）；`physiologyLine`（默认 `true`）总开关、自定义 prompt 可用 `{{physiology}}` 占位符。vitals 新增 `lastUserMessageAt` / `lastTurnEndAt` / `busyMsToday`（跨重启保留）。用户 20 分钟内出现过 → 不显示（是观察不是打扰）；措辞随时段变化（早上好：/ 傍晚了：/ 状态：），深夜更短更轻、不带计数。
- **`userActiveSuppressSeconds`（默认 `120`，`0` = 不抑制）**：「你刚说过话就静默」的窗口可配置，并使用持久化的 `lastUserMessageAt`，跨重启仍生效。
- **C 子智能体执行中胶囊**：`GET /api/heartbeat/status` 每个会话新增 `children: { total, running, runningIds }`（来自 `subagentCatalog` / `agentTeam` 的 wire view + 活 agent registry，与 runtime 保持静默用的是同一份宿主真值）；客户端在 `conversation.session.header.actions` 注册头部胶囊 **「子智能体执行中 · N」**，5s 轮询，子任务结束自动隐藏，中英 i18n。**纯插件层、零宿主改动**。

### Changed

- **已知宿主行为（胶囊为何存在）**：DSH 会话列表的 `running` 只在 agent 创建/销毁时重算，子会话 `api-session/status` 按 session 资源转发；父会话空闲时其视图可能拿不到子会话的运行变化，于是头部显示「N 个子智能体」而不是「正在运行」，主会话看起来已完成。本版的 status `children` + 头部胶囊在不改宿主的前提下把「仍在跑」补回来（见 README「Child activity pill」）。
- 配置表新增 `proactiveCooldownSeconds` / `userActiveSuppressSeconds` / `physiologyLine`；自定义 prompt 新增 `{{physiology}}`；README 两语言补 A/B/C 三节。

### Tests

- 新增 `test/proactive-lock.test.mjs`、`test/physiology.test.mjs`、`test/prompt-physiology.test.mjs`、`test/activity.test.mjs`；`runtime` / `gate` / `vitals` / `client-half` / `config-store-v2` 等补相应用例。
- 全量单测 **172/172 通过**（`node --test`）。

## [0.6.2] - 2026-10-30

### Fixed

- **投影读法错误：`stateOf()` 返回的是原始 state，不是 wire view（真机 bug，0.6.1 的守卫因此全坏）**：`sessionProjections.stateOf()` 给的是**原始 state**——普通会话的 `subagent` 原始 state 是 `{}`（不是 `null`），`subagentCatalog` 原始 state 是 `{ inheritedEventCount, head }`（不是数组）。0.6.1 把原始 state 直接当 wire view 用，导致：
  - ① **身份守卫误判**：`{}` 被判为 truthy → 所有会话都被当成「子会话」→ **心跳根本挂不上**（运行实例 `/api/heartbeat/status` 返回 `sessions: []` 就是这个）；
  - ② **child-active 闸门永远失效**：catalog 不是数组 → 永远检测不到子任务在运行 → 「子任务进行中保持静默」实际没生效。
  - **修法**：新增 `sessionWireOf()`——优先 `projections.snapshot(session, [key]).values[key]` 拿 wire view，退化时用 raw state 并**校验形状**；`subagentIdentityOf()` 校验 `mode` / `identity` 形状（`{}` 不算子会话）；`childWorkActiveOf()` 改写成用 wire view 的 catalog / team members + 活 agent registry 判断运行中。
- **0.6.1 已在 npm 且含此缺陷——请升级到 0.6.2。**

### Tests

- 新增 `test/projections-wire.test.mjs`（7 条）：wire 优先 / raw 回退、raw `{}` 不算子会话、身份识别、catalog + registry、team members、降级安全。
- 修正 wiring 测试的假投影为**真实 raw 形状**，并补「raw `{}` 仍能挂载」回归用例。
- 全量单测 **129/129 通过**（`node --test`）。

## [0.6.1] - 2026-10-30

### Fixed

- **子任务进行中不再插话（真机 bug）**：现象——子 agent / teammate 还在跑的时候，心跳触发注入了一轮新 turn，主会话里「子 agent 正在运行」的状态被这轮新话顶掉，用户因此看不出后台工作还在跑。
  - **原因**：root agent 在等委派出去的子任务时是 idle，心跳把「idle」当成可打扰；而客户端把「正在运行的子会话」作为当前活跃 turn / 会话状态的一部分渲染，新注入的 turn 会抢占这个位置。另外 v0.6.0 修复 `AbortSignal` 后 pre-beat 压缩才真正生效，也可能把活跃 turn 的表面节点折进摘要（本机日志未观察到 compaction 事件，属防御性一并规避）。
  - **修法**：pulse 前检查本会话的 `subagentCatalog` + `agentTeam` 成员，任一子会话的 agent `status !== 'idle'` → 本拍记 **`L0 · child-active`**、**不注入、不压缩**，直到子任务全部结束。手动 **Beat now** 仍可强制触发（用户显式操作例外）。
- **心跳不再挂到子 agent 会话（resumed child 可能被算作 root 的风险）**：teammate / subagent 是 `mode: "continuable"` 的子会话，用户可能从侧栏把它当顶层会话重新打开 / 恢复（resume）；按宿主语义，这种 resumed child **可能被算作 root（无 owner）**，旧 attach 逻辑会因此给它挂上心跳 → 向子 agent 会话注入多余上下文。
  - **修法**：`attach()` 先读该会话的 `subagent` 投影身份，身份非空 → **跳过不挂**（日志 `heartbeat: skip subagent session`）；`tick()` 里再防御性检查，一旦发现自己是 subagent 会话就 `dispose()` 摘除。
  - **真机排查证据**：当前实例 3 个运行时全是 root 用户会话；逐个扫 teammate 子会话日志，**heartbeat 注入 0 条**（日志里出现的 `plugin:heartbeat` 字样是工具输出 / 文档内容，不是注入消息）。
  - **已知边界（fork 语义）**：fork 型子 agent 会继承父会话历史，若 fork 前父会话已有心跳消息，会随 seed 带过去——这是 fork 语义本身，插件无法阻止；spawn 型子 agent 不受影响。
- **设置面板 L3 授权类别标签空白（真机 UI bug）**：现象——「L3 自动执行授权」那 4 个勾选框**旁边没有文字**，看不出在授权什么；历史脉冲行的 level 也显示成原始 `L0` / `L1`。
  - **原因**：早前把客户端文案批量换成 `t('key')` 时漏了一处 `t[\`l3${category}\`]`——`t` 是函数，用方括号取值得到 `undefined`，React 就渲染空白；历史行的 `t[\`level${row.level}\`]` 同款错误（该处有 `?? row.level` 兜底，所以显示成原始 level）。
  - **修法**：两处都改为函数调用 `t(...)`；新增回归测试 `the client source calls translate instead of indexing a function`（静态卡住 `t[` 这种写法，并确认 L3 标签与历史 level 都是函数调用）。

### Changed

- **新配置 `quietWhileChildrenActive`（默认 `true`）**：子 agent / teammate 仍在运行时保持静默；设 `false` 可恢复旧行为。可写 `heartbeat.json`（v2）或 `POST /api/heartbeat/config`；本轮未加进设置面板控件。

### Tests

- 新增 3 条：`no pulse while a child subagent is still working`、`manual Beat now still works while a child is working`、`child gate can be disabled by config`。
- 新增 2 条子会话守卫用例：`a subagent conversation never receives heartbeat context`、`apply never attaches to a subagent conversation`。
- 新增 1 条 UI 文案回归用例：`the client source calls translate instead of indexing a function`。
- 全量单测 **122/122 通过**（`node --test`）。

## [0.6.0] - 2026-10-30

### Added（自主神经）

- **新模块**：`lib/sensors.js`（投影 diff → 信号 + arousal，FNV-1a 稳定指纹）、`lib/rhythm.js`（arousal / 不应期 / 静默时段 / 退避 / jitter）、`lib/gate.js`（等级判定 / 去重窗口 / 每日预算 / 礼貌闸门）、`lib/vitals.js`（运行态持久化 `heartbeat-vitals.json`：tmp+rename 原子写、2s 防抖、每会话 10 条历史、200 条去重账本、重启冷却判定）。
- **自主等级 L0–L4**：L0 静默拍**不注入任何消息**（只记 vitals）；L1 汇报进展/风险；L2 用 `ask_user_question` 问你要不要做；L4 对同一决策信号「已提醒过仍无回应」（`missed ≥ 2`）升级措辞、不加频；L3 类别授权（`read` / `test` / `notes` / `continue`，默认空）只做指令级授权，**不是沙箱**，不可逆操作仍由宿主 approval 拦截。
- **信号与 arousal**：团队任务变可开始 +5、变被阻塞 +4、目标受阻/暂停 +4、待回答提问 +3、待办变化 +2、团队任务完成 +1；`arousal = clamp(Σ, 0, 8)`，越高间隔越短。抑制条件：你刚说过话（2 分钟内）、上下文压力 > 0.9、静默时段、禁用/打盹/暂停、`mode: silent`。
- **节律**：`baseIntervalSeconds`（默认 600）、退避档位、arousal 调频（arousal 4 → 间隔 ×1/3）、`refractorySeconds`（默认 300）、`jitterSeconds`（默认 60，确定性）、`restartCooldownSeconds`（默认 300）、静默时段默认 `23:00–08:00`。
- **去重与预算**：`dedupeWindowMinutes`（默认 90，同一信号键不重复问）、`maxBeatsPerDay`（默认 12，`0` = 不限，进程内跨会话共享）。
- **事件驱动**：订阅 `sessionProjections.onChanged`（`todos` / `agentTeam` / `goal` / `userQuestions`）→ 2s 防抖后额外一拍，仍过全部门控；服务不可用自动退化为纯定时器模式。
- **可观测与控制**：`GET /api/heartbeat/status`、`POST /api/heartbeat/control`（`beat-now` / `snooze` / `pause` / `resume` / `reset`）；设置面板新增**生命体征**（状态 / 下次 ETA / 今日预算 / 最近 5 拍）+ 控制按钮；面板文案走 **DSH 语言包**（client 注入 `locale`、注册 `heartbeat` 命名空间 zh/en、slot 声明 `locale: 'heartbeat'`，跟随「设置 → 通用设置 → 语言」并即时重渲染），侧栏 label 也跟随语言（中文「心跳」/ 英文 `Heartbeat`），爱心图标不变且认领键随语言切换自动更新。
- **配置 v2**：`mode` / `baseIntervalSeconds` / `quietHours` / `dedupeWindowMinutes` / `maxBeatsPerDay` / `refractorySeconds` / `restartCooldownSeconds` / `jitterSeconds` / `l3Allow` / `workspaces`；v1 `heartbeat.json` 加载时**自动迁移**并回写 v2；工作区覆盖按 `session.header.cwd`，优先级 composition < 用户配置 < 工作区覆盖。
- 自定义 `prompt` 新增 `{{reason}}` 占位符（why-now 一行）。

### Changed（默认行为变化）

- **默认行为从「按间隔必说话」改为「静默拍」**：没有信号时走 L0、**不注入任何消息**，只有检测到变化才按 L1/L2/L4 开口。0.5.x 的「每拍都汇报」不再是默认；想更活跃可调 `mode` / 去重 / 静默时段。
- **面板文案与侧栏 label 改为跟随 DSH 语言设置**：不再用 `navigator.language` 猜（Electron 里常是 en-US、与 App 语言不一致），改为注册 `heartbeat` 语言包并跟随「设置 → 通用设置 → 语言」，默认回退中文；侧栏 label 也走语言包（中文「心跳」/ 英文 `Heartbeat`），语言切换后 `MutationObserver` 自动重新认领爱心标记。
- **配置字段重命名**：`intervalSeconds` → `baseIntervalSeconds`（v1 文件自动迁移，无需手工处理）；配置升为 v2。
- **消息格式**：新增「为什么现在叫你：`{{reason}}`」一行，分级指令取代单一默认提示词；自定义 prompt 仍兼容 `{{time}}` / `{{tasks}}`，并新增 `{{reason}}`。
- 双语文档（`README.md` / `README.zh.md`）全面更新到 v0.6 口径：自主等级、信号/去重/预算、生命体征与控制、配置 v2 全表与 v1→v2 迁移；爱心图标小节保持。

### Fixed

- 本版无新增修复项（0.5.1 的 pre-beat 压缩 `AbortSignal`、热挂载补齐、`runtimes` Map 泄漏等修复原样沿用，不在此复述）。

### Tests

- 新增 `test/sensors.test.mjs`、`test/rhythm.test.mjs`、`test/gate.test.mjs`、`test/vitals.test.mjs`、`test/config-store-v2.test.mjs`、`test/prompt-levels.test.mjs`、`test/wiring-v06.test.mjs`；`test/client-half.test.mjs` 扩展面板契约（生命体征 / 控制 / i18n），并补「zh/en 语言包 key 对齐、slot 声明 `locale: 'heartbeat'`、`inject` 含 `locale`」与 `sidebar label and icon follow a language switch`（切语言后 label 变「心跳」/`Heartbeat`、MutationObserver 重新认领）用例。
- 全量单测 **116/116 通过**（`node --test`）。

## [0.5.1] - 2026-10-30

### Added

- **设置侧栏爱心导航图标**：设置侧栏的 Heartbeat 一行现在带一个**描边爱心**标记——16×16 网格、`stroke-width: 1.3`（与宿主 `ICON_MEDIUM_STROKE` 一致）、纯黑描边只提供 alpha，可见颜色由 `mask-image` + `background-color: currentColor` 决定，深浅主题都跟随。规格与 dsh-plugin-memory 的图标**完全统一**。
  - 官方 `settings.section` 槽只投影 id / order / label，**没有 icon 字段**，设置 shell 的 `navIcon(id)` 也只认一小撮白名单 id；因此插件按 **label 文本精确认领** 自己那一行（trim 后精确相等，不做子串匹配，避免误伤邻居），并用 `MutationObserver` 跟随语言切换 / 面板重挂载重新认领，disposer 卸载时清理 mark、样式与 observer。
  - 新增 `lib/settings-nav-icon.js`（纯函数：`heartSvg()` / `heartMaskUrl()` / `isOwnNavRow()` / `navIconCss()`、`HEARTBEAT_SECTION_LABEL = 'Heartbeat'`），`lib/client.js` 内联同一套契约 + `claimNavIcon()`。
- **双语文档**：`README.md` 改为英文主文档并新增 `README.zh.md` 中文版（顶部语言切换行 + GitHub / npm / license / node badges，与 dsh-plugin-memory 同款格式）；两份都补齐任务巡检、热挂载补齐、`engines.dsh` 与实机验证口径。

### Changed

- 设置区块 label 从 `'心跳 Heartbeat'` 改为 **`'Heartbeat'`**——它同时是显示文案和 nav 图标认领的匹配键，两者必须是同一个字符串，否则语言切换后标记会对不上行。
- `package.json`：`files` 加入 `README.zh.md`（npm 包随附中文文档）。

### Tests

- 新增 `test/settings-nav-icon.test.mjs`（10 个纯函数用例）与 `test/client-half.test.mjs`（4 个客户端契约用例：用 `node:vm` + 假 `window` / `document` / `MutationObserver` 按浏览器方式加载 `lib/client.js`，验证区块注册形状、只认领 label 精确相等的行、mark 为 16×16 / stroke 1.3 / `stroke="#000"` 的 mask 爱心且颜色走 currentColor、teardown 摘干净 mark / 样式 / observer）。
- nav icon 相关用例共 **14 个**；全量单测 **74/74 通过**（`node --test`）。

## [0.5.0] - 2026-10-30

### Added（任务巡检）

- **心跳前任务巡检**：每拍投递前同步读宿主 session projections（`ctx.sessionProjections.stateOf`）—— `todos`（会话待办）、`agentTeam`（Agent Team 团队任务板，含 `ready` / `blockedBy`）、`goal`（持久目标的 `objective` / `phase`）—— 把未完成条目压成一段任务块（快照 + 提问指令，整体 ≤800 字符）注入心跳消息。`todos` 只留 `in_progress` / `pending`；团队任务按「可开始 → 进行中 → 被阻塞」排序并标明阻塞依赖；`goal` 只留 `active` / `paused` / `blocked` 相位。
- **只提问、不擅自开工**：快照后附指令，要求 agent 发现「该做但还没人拍板」的事时，用 `ask_user_question`（不可用就直接问）问用户「现在要不要我主动做」，最多 3 条建议；代码不自动执行任何任务。没有可巡检事项时只保留一行「本拍没检测到」+ 提问指令。
- **`{{tasks}}` 占位符**：默认提示词把任务快照插在固定位置；自定义 `prompt` 不含占位符时快照追加到末尾（0.4.x 的自定义提示词无需改动）。
- **新配置**：`taskNudge`（默认 `true`，任务巡检**整开关**：关闭后心跳消息里既没有任务快照、也没有巡检 / 提问指令，只留通用汇报提示词）与 `taskNudgeMaxItems`（1–20，默认 `5`，每类条目上限）；同时进设置面板（新增「任务巡检」开关 + 「巡检条目上限」输入）与用户层 `<dshHome>/heartbeat.json`。
- **降级不丢拍**：宿主未注册 `sessionProjections`、会话未绑定、或某个投影读取抛错 → 退化为提示语，心跳照常投递。

### Changed

- **兼容 DSH 0.2.1-rc.5（session format v4）**：心跳消息 source 保持 producer-owned `plugin:heartbeat`（继承 0.4.3 的 v4 修复）；`sessionProjections` 按可选依赖注入（`ctx.inject(['sessionProjections'], …)`），缺失时自动降级，不阻塞插件加载。
- **实机验证（DSH Desktop 0.2.1-rc.5，运行中的真实宿主）**：**心跳投递 + 任务巡检快照注入**已跑通——真实会话里 `todos` 与 Agent Team 任务板均正确注入（`ready` / `blockedBy` 推导正确），source `plugin:heartbeat` 通过 session v4 准入；设置面板 `GET/POST /api/heartbeat/config` 实机读写并热应用。**pre-beat 压缩路径只有单测覆盖，未单独做实机观察。**
- **声明引擎闸门 `engines.dsh: "^0.2.1-rc.5"`**：宿主用 semver（`includePrerelease: true`）校验插件兼容性，`^0.2.1` / `>=0.2.0` 都匹配不上 `0.2.1-rc.5`（prerelease 语义坑），故显式声明。**0.4.2 是最后一个 v3 兼容版本**，0.5.0 起只支持官方 DSH 0.2.1-rc.5 系列。
- **投递与驱动面加固**：压缩耗时超过下一个 interval 时用 `delivering` 互斥，不会叠第二拍；`agent.followup` / `agent.inbox` 等 agent-loop 驱动面加**能力校验**（这些不属于公开 API catalog），宿主若改名/换实现，只丢一拍并打 warn，不在定时器里抛。
- **`npm test` 兼容 Node 22+/26**：`scripts.test` 从 `node --test test/` 改为无参 `node --test`（Node 26 下传目录会直接报 `Cannot find module .../test`），自动发现 `test/*.test.mjs`。

### Fixed

- **pre-beat 压缩的 `AbortSignal` 签名修复（压缩原先形同虚设）**：0.2.1-rc.5 的 `compactNow(agent, signal, sourceCommandId?)` 中 `signal` 是**必填**（实现顶部无条件 `signal.throwIfAborted()`）。原先传 `undefined` → 每个空闲拍同步抛 TypeError、被 catch 吞掉 → **投递前压缩从来没生效过**，还每拍刷一条 warn。现改为传 `AbortSignal.timeout(60s)`（第三参数不再传伪 commandId），并新增单测卡住「必须传真实 `AbortSignal`」。
- **`runtimes` Map 泄漏修复**：agent 销毁时随 `agent.ctx.effect` 的 disposer 删除对应 map 条目，不再随会话数累积。
- **热挂载补齐**：插件在会话已存在之后才被挂载/热重载时（`dsh plugin add`、市场安装、profile live reload 都属于这种），原先只监听 `agent/created`，**已经打开的会话永远收不到心跳**（实测现象：热加载后配置路由活着，但当前会话不跳）。现在 `apply()` 在监听事件之外，还会对 `ctx.agents.roots()` 现有的 root agent 做一次**幂等补挂**（`attach()` 统一去重，子 agent 仍跳过）。
- **测试脚本在新版 Node 上直接失败**：`node --test test/` → `node --test`（Node 26.6.0 复现：`Cannot find module .../test`；改后 60 个用例全通过）。

### Tests

- 新增 `test/tasks.test.mjs`：投影缺失 / `todos` 只有 completed / `agentTeam` ready 与 blocked / `goal` 非 active 相位 / `taskNudgeMaxItems` 截断 / `{{tasks}}` 替换与追加两条路径 / 注入消息含提问指令。
- 热挂载补挂两条用例：`apply catches up with agents that already exist (hot mount)`、`a subagent that predates the mount is not attached`。
- 压缩路径：`pre-beat compaction runs for an idle agent when available` 断言传入的是真实 `AbortSignal`；另有重叠拍互斥、驱动面缺失只 warn 不抛、agent 销毁清理 runtime 的用例。
- 全量单测 **60/60 通过**（`node --test`）。

## [0.4.3] - 2026-09-28

### Fixed（DSH session format v4 兼容）

- **修复心跳消息被 v4 拒绝**：`buildHeartbeatMessage()` 的 source 从 `{ kind: 'plugin', plugin: 'heartbeat' }` 改为 **`{ kind: 'plugin:heartbeat' }`**。
  - **症状**：心跳到点投递时抛 `SessionFormatError: format v4 message requires a producer-owned source kind`。它被 `dsh-agent-loop` 当作非 LLM 错误包成 `{ message, code: 'UNKNOWN' }`，界面上显示为 `... source kind UNKNOWN`——**`UNKNOWN` 是错误码，不是 kind 值**。
  - **原因**：session format **v4**（官方 DeepSeek Harness **0.1.7+**）的原生准入 `source()` 明确拒绝 `kind === "plugin"` 这一 v3 时代的 wrapper，要求 producer-owned kind；第三方插件的形态是 `plugin:<name>`。
  - **兼容性门槛**：v4 校验与 v3 的 `SOURCE_KINDS` 白名单**互斥**（v3 只认 `plugin`），**无法同时兼容两版**。**本版起要求 DSH session format v4（官方 0.1.7+）**；旧版 DSH 请停留在 0.4.2。
  - **历史 session 不受影响**：v3→v4 迁移会自动转换旧 wrapper，只有**新注入**的消息需要改。

### Tests

- `test/runtime.test.mjs` 两处 source 断言改为 `deepEqual(source, { kind: 'plugin:heartbeat' })`——同时卡住「不得再带 `plugin` 字段」。
- 先写测试并确认其失败（`actual: {kind:'plugin',plugin:'heartbeat'}` vs `expected: {kind:'plugin:heartbeat'}`）后才改实现。
- 单测 **33/33 通过**。

## [0.4.2] - 2026-08-31

### Changed

- **适配 DSH 0.1.2-alpha.1**：移除 `dsh.client.inject` 里已废弃的 `@deepseek-ai/dsh-client-runtime`（新版宿主已合并进 `dsh-client-modules`，且本插件客户端半只依赖 `react` 平台种子模块）。

## [0.4.1] - 2026-08-24

### Changed

- 包内新增 `CHANGELOG.md` 并纳入 npm 发布文件（`files` 加 `CHANGELOG.md`），随发布携带版本说明。

## [0.4.0] - 2026-08-19

### Added（防 token 烧设计）

- **退避式间隔**：初始 600s（`intervalSeconds`）；无人回复下一拍自动 `×2`、再下一拍 `×3`（`[base, 2×base, 3×base]`，可 `backoffSeconds` 显式覆盖）。冷场越久吵得越稀。
- **硬停保证（token 保护）**：连续 `pauseAfterMissed`（默认 3）拍无真人回复 → **拆掉定时器彻底停止**，绝不再空转投递；只有用户的一条消息能复活它，并从初始档重新计时。
- **真人消息全重置**：任何你的发言都计数/档位/相位全清零，聊天活跃期心跳完全安静。
- **轻量唤醒**：投递前先请求宿主 compaction 服务把长历史压成 checkpoint 摘要（`compactBeforeBeat`，默认开，失败吞掉不阻断投递）；默认 prompt 明确「不调工具 / 不复盘历史 / ≤5 句」。
- **每小时封顶（可选）**：`maxBeatsPerHour`（默认 `0`=关）给任意 60 分钟窗口设心跳上限，防「断续回复反复重置退避」的极端烧法。

### Changed

- README 更新：机制 / 配置（`backoffSeconds` / `compactBeforeBeat` / `maxBeatsPerHour`）/ 边界说明；删除「手动 cordis.patch insert」安装路径（防 manifest 与手写双轨）。

## [0.3.1] - 2026-08-18

### Changed

- **bundle manifest 进发布 tarball**：包内补 `cordis.patch.yml` + `dsh.bundle.patch` 声明并作为 npm 发布文件，保证 `dsh plugin add` / dsh-market 能从 tarball 安装（市场 npm 安装通道的硬前提）。

## [0.3.0] - 2026-08-18

### Changed

- **自建配置通道**：弃 settings namespace（web settings wire 白名单拒绝插件命名空间），自建 `~/.dsh/heartbeat.json`（schema 校验 + 原子落盘 + watch）+ host 注册 `GET/POST /api/heartbeat/config` 路由；客户端区块改 fetch 直连，写入即热应用（store.watch → runtime.reschedule）。
- **可安装/可上架**：声明 `dsh.bundle` manifest + 仓库根 `cordis.patch.yml`；README 安装方式改为以 `dsh plugin add` 为主。

## [0.2.2] - 2026-08-18

### Fixed

- 修复客户端 `useSyncExternalStore` 直接传类方法导致 `this` 丢失（`subscribe` / `getSnapshot` 显式绑定）。

## [0.2.1] - 2026-08-18

### Fixed

- 修复设置页空白：客户端半补注入 `connection` / `remote` 服务 + 错误自显示兜底。

## [0.2.0] - 2026-08-18

### Added

- **无人值守保护**：连续 `pauseAfterMissed`（默认 3，`0`=关）拍无真人回复 → 自动暂停；用户消息恢复。README 补 `pauseAfterMissed` 配置说明。

## [0.1.1] - 2026-08-18

### Added

- **设置面板 Heartbeat 区块**：开关 + 分钟频率（客户端半注入 `settings.section`，`settings` 热写）。

### Changed

- 面板热改立即重排定时器（`settings.watch` → `runtime.reschedule()`，改频率即时生效）。

## [0.1.0] - 2026-08-18

### Added（插件本体）

- 心跳插件：可配置频率，让 agent 主动在当前会话开口（OpenClaw 心跳模式）。
- 机制：host 插件监听 `agent/created` → 每个 root agent 挂 `HeartbeatRuntime` → 每拍 `agent.followup()` 注入 plugin 源 user 消息；空闲立即开轮、忙碌排队不打断、忙时多拍 `inbox.replace` 合并为一条；任务导向心跳内容。
