# Changelog

所有记录跟随 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格；版本号与 `package.json` 保持一致。

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
