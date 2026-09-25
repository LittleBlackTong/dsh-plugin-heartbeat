# Changelog

所有记录跟随 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格；版本号与 `package.json` 保持一致。

## [0.5.0] - 2026-09-25

### Added

- **报告模式（mode B，`report.enabled`，默认关）**：来源会话静默（不注入、不唤醒、0 模型 token），
  一个引擎按「采集(机械摘要) → 判定(规则 + 仅疑似异常时一次模型调用) → 分发(报告条目/三色状态旗/策略唤醒)
  → 记账(无人应答硬停·退避·每小时上限)」四段管道运行；`heartbeat/beat` 事件每拍广播。
- **三色状态旗**：🟢 正常 / 🔵 需决策（检测 `ask_user_question`）/ 🟡 异常；**默认折叠**，
  出现黄/蓝点自动展开最近 5 条，用户手动折叠后保持折叠；会话修好后（最新一条变绿）旗帜自动回绿。
- **窗口式统计**：工具错误与轮次结局只统计"自上次汇报以来"（游标持久化进报告文件，
  重启后不会把历史错误当成新异常）；待决策为状态语义（未答复前一直蓝）。
- **内嵌报告区块 + 独立页**：设置 →「心跳 Heartbeat」页底部即报告列表；另有「心跳报告」独立页；
  点击标题在资源管理器/Finder 打开 `.md` 完整报告（每拍重写 `<dshHome>/heartbeat-report.md`）。
- **判级模型可配置**：设置页下拉选择，默认跟随 Harness 默认模型；列表按内置 USD 价表标注
  **最便宜（推荐）**（`lib/model-pricing.js`，仅用于排序推荐）。
- **跟随心跳的策略**（`report.strategies`）：文件传感器 `changed`（首拍记基线、改动才报）/
  `exists` / `missing`；命中写报告条目（可指定状态旗颜色 info|warn|decide），可选**唤醒指定会话**处理。
- **硬停在报告模式下保留**：连续 N 拍无任何真人活动（任意会话的用户消息 / 打开报告页）→ 拆定时器；
  任意真人活动恢复。异常未解决时同一状态行**原地刷新**（时间戳前移），不刷屏。
- 报告保留条数运行期生效（`setRetention` 即时裁剪）。
- 子代理会话不参与报告（尊重"子 agent 不挂心跳"边界）。
- 新测试：`test/report-engine.test.mjs`；总测试 48 项全绿。

### Fixed

- **适配会话格式 v4**：心跳消息的 `source.kind` 从已废弃的 `plugin` 改为 producer-owned
  `plugin:heartbeat` —— 旧写法在 v4 下整轮被拒（`format v4 message requires a producer-owned source kind`）。
- 配置部分更新不再丢弃 `report` 子字段（深合并）。
- 容忍配置/报告文件中的 UTF-8 BOM（PowerShell `Set-Content -Encoding UTF8` 会写入）。
- 测试命令由 `node --test test/` 改为 `node --test`（Node 22 下目录参数报 MODULE_NOT_FOUND）。

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
