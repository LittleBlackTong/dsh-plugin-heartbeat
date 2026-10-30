# dsh-plugin-heartbeat

> A heartbeat plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): wakes the agent on a configurable interval so it proactively reports progress, risks, and blockers — and, before each beat, inspects the session's own todos, team board and goal so it can ask whether to act — or just checks in.

DeepSeek Harness 的「心跳」插件：给 agent 装一个定时唤醒的闹钟，让它**主动**开口 —— 汇报进展、风险、卡点，或者没事贫两句。v0.5.0 起每拍还会先做一次**任务巡检**：读会话里的待办、团队任务和目标，把快照塞进心跳，让 agent 来问你要不要动手。类似 OpenClaw 的心跳模式。

## 怎么工作

- Host 平面的 Cordis 插件，监听 `agent/created`，给每个 **root agent**（子 agent 跳过）挂一个独立定时器。
- **热挂载补齐（v0.5.0）**：插件在会话已经开着时才被挂载/热重载（`dsh plugin add`、市场安装、profile live reload 都属于这种）时，只监听 `agent/created` 会永远错过这些已存在的会话。`apply()` 里除监听事件外，还会对 `ctx.agents.roots()` 当前的 root agent 做一次**幂等补挂**，已打开的会话照样开始心跳（子 agent 仍跳过）。
- 每次心跳通过 `agent.followup()` 注入一条合成 user 消息（session format v4 的 producer-owned kind：`source.kind === 'plugin:heartbeat'`）：
  - **agent 空闲** → 立即开新一轮，主动说话；
  - **agent 忙** → 消息排队，当前轮结束立刻处理 —— **不打断、不丢失**；
  - 连续忙时多拍心跳 → 只保留一条待处理（`inbox.replace` 原地替换，不堆积）。
- **退避间隔（v0.4.0）**：初始 10 分钟；无人回复则下一拍 20 分钟、再下一拍 30 分钟（`[base, 2×base, 3×base]` 自动推导，可 `backoffSeconds` 显式覆盖）。冷场越久，吵得越稀。
- **硬停保证（v0.4.0，token 保护）**：连续 `pauseAfterMissed`（默认 3）拍没有真人回复 → **拆掉定时器彻底停止**，绝不再投递；只有你的下一条消息能复活它，并从初始 10 分钟档**重新计时**。聊天活跃时每次你说话都会重置相位——心跳只在真正的冷场后才开口。
- **轻量唤醒（v0.4.0）**：投递前先请宿主的 compaction 服务把长历史压成 checkpoint 摘要（`compactBeforeBeat`，默认开，失败不影响投递），注入的指令明确「不调工具、不复盘历史、≤5 句」——每拍消耗的上下文尽量小。
- **每小时封顶（可选）**：`maxBeatsPerHour`（默认 0=关）给任何 60 分钟窗口设心跳上限，防「断续回复反复重置退避」的极端烧法。
- **任务巡检（v0.5.0）**：每拍投递前读一次会话投影（待办 / 团队任务板 / 目标），把未完成事项压成快照塞进心跳，并指示 agent **只提问、不擅自开工**。详见下一节。
- 注入的消息在对话流里渲染为一条折叠的 context 小行，不是整块用户气泡。

## 任务巡检（v0.5.0）

心跳不再只靠「最近对话」猜状态。每拍投递前，插件同步读一次宿主的 **session projections**（`ctx.sessionProjections`），把结果压成一段紧凑快照注入心跳消息：

| 投影 key | 读到的内容 | 进快照的规则 |
|---|---|---|
| `todos` | 会话待办清单（`content` / `status`） | 只留 `in_progress`、`pending`；`completed` 丢弃 |
| `agentTeam` | Agent Team 团队任务板（`subject` / `status` / `blockedBy`） | 只留未完成条目，按「可开始 → 进行中 → 被阻塞」排序，阻塞会标明依赖哪个任务 |
| `goal` | 持久目标（`objective` / `phase`） | 只留 `active` / `paused` / `blocked` 三种相位 |

读之前要知道的两件事：

- `agentTeam` 投影**只有启用 Agent Team 可选包时才注册**；未启用时读不到它 → 自动降级，不报错、快照里也不会出现团队任务段。
- `todos` 投影**每个 turn 开始会重置**：心跳看到的是「最近一个 turn 内的待办」，不是会话级长期 TODO——别把它当持久任务清单。

快照后面附一条指令：发现「该做但还没人拍板」的事 → 用 `ask_user_question` 工具（不可用就直接问）问用户「现在要不要我主动做」，最多 3 条、每条一句建议；**只提问，不擅自开工**。

健壮性约定：

- 宿主没注册 `sessionProjections` 服务、会话还没绑定、或某个投影读取抛错 → **降级为提示语**，心跳照常投递；绝不因为任务巡检失败而丢拍。
- 任务块（快照 + 提问指令）有 **800 字符硬上限**，`taskNudgeMaxItems` 再限每类条目数（默认 5，范围 1–20）——任务巡检是加料，不是加负担。
- 插件对投影**只读不写**：不改你的待办、团队任务板或目标；任务要真的被改动，仍然由你或 agent 走正常工具链。
- 自定义 `prompt` 不含 `{{tasks}}` 占位符时，任务块（快照 + 指令）自动追加到提示词末尾（v0.4.x 的自定义提示词不用改）。

配置（设置面板「心跳 Heartbeat」里可开关）：

| 键 | 默认 | 含义 |
|---|---|---|
| `taskNudge` | `true` | 是否做任务巡检；关闭后心跳消息里不再注入任务快照，也没有巡检 / 提问指令 |
| `taskNudgeMaxItems` | `5` | 快照里每类最多列几项（1–20） |

关掉 `taskNudge` 不影响心跳本身：消息退化为通用的「汇报进展 / 提问 / 报个日常」提示词，比开着时更短。

## 安装

```sh
dsh plugin --profile <profile> add dsh-plugin-heartbeat
```

（包内置 `dsh.bundle` manifest，`dsh plugin add` 会把它自动挂进 profile 的 bundles 层；dsh-market 里的一键安装同此通道。）

重启 DSH 后生效。之后在 **设置 → 心跳 Heartbeat** 面板里随时改频率、开关、暂停阈值与任务巡检，保存即热应用（无需重启）。

> ⚠️ **不要**再往 profile 的 `cordis.patch.yml` 里手写 `- insert: {id: dsh-heartbeat, ...}`：
> 那会与 bundle manifest 的自动挂载产生两条同名 entry，整个 profile 会以
> `duplicate loader entry id "dsh-heartbeat"` 启动失败（2026-08-18 实机事故，
> 当时撞的是 memory 插件的同名条目）。运行期配置走 `<dshHome>/heartbeat.json`；
> 覆盖 composition 键（如 `prompt`）用**不带 insert 的 id 覆盖条目**，见下。

## 版本要求

- **DSH：官方 0.2.1-rc.5 系列**。`package.json` 已声明 `engines.dsh: "^0.2.1-rc.5"`——宿主用 semver（`includePrerelease: true`）做引擎闸门，注意 prerelease 语义：`^0.2.1` / `>=0.2.0` **都匹配不上** `0.2.1-rc.5`，必须写 `^0.2.1-rc.5` 才认；它同时覆盖将来 0.2.1 正式版，而 0.3.0-rc.1 会被判不兼容。
- **session format v4**（官方 0.1.7+）。心跳消息的 source 使用 producer-owned kind `plugin:heartbeat`；v4 的原生准入拒绝 v3 的 `{kind:'plugin', plugin:'heartbeat'}` wrapper，报 `format v4 message requires a producer-owned source kind`（该错误被包成 `code: "UNKNOWN"`，界面显示为 `... source kind UNKNOWN`——`UNKNOWN` 是错误码，不是 kind 值）。v4 与 v3 白名单互斥、无法两全。
- **0.4.2 是最后一个 v3 兼容版本**；**0.5.0 起只支持官方 DSH 0.2.1-rc.5 系列**（session format v4 + 当前离线验证过的宿主 API）。更早的 0.2.x 若没有 `sessionProjections` 会自动降级，但未逐版本验证；0.3.x 暂不支持。
- **实机验证**（DSH Desktop 0.2.1-rc.5，运行中的真实宿主）：**心跳投递 + 任务巡检快照注入**已跑通——真实会话里 `todos` 与 Agent Team 任务板都正确注入（`ready` / `blockedBy` 推导正确），source `plugin:heartbeat` 通过 session v4 准入；设置面板 `GET/POST /api/heartbeat/config` 实机读写并热应用。注：pre-beat 压缩路径只有单测覆盖，未单独做实机观察。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关（用户层存在 `<dshHome>/heartbeat.json`） |
| `intervalSeconds` | `600` | 初始心跳周期（钳制在 30–86400 秒）；退避后续档自动 ×2、×3 |
| `pauseAfterMissed` | `3` | 硬停阈值：连续 N 拍无真人回复 → 拆定时器彻底停止；用户下一条消息复活并回初始档重新计时。`0` = 关闭 |
| `taskNudge` | `true` | 任务巡检：每拍读一次会话里的待办 / 团队任务 / 目标并把快照与提问指令注入心跳；关闭后两者都不出现（用户层可改） |
| `taskNudgeMaxItems` | `5` | 任务快照里每类条目上限，1–20（用户层可改） |
| `backoffSeconds` | 未设 | 显式退避档位数组（如 `[600, 900, 1800]`，仅 composition） |
| `compactBeforeBeat` | `true` | 投递前先压缩历史为 checkpoint 摘要（仅 composition，无 compaction 服务时自动跳过） |
| `maxBeatsPerHour` | `0` | 每 60 分钟滑动窗口的心跳上限（`0`=关闭，仅 composition） |
| `prompt` | 内置 | 每拍投递的指令模板，`{{time}}` 替换为当前时间、`{{tasks}}` 替换为任务快照（仅 composition 配置） |
| `configFile` | `<dshHome>/heartbeat.json` | 用户配置文件路径（`enabled` / `intervalSeconds` / `pauseAfterMissed` / `taskNudge` / `taskNudgeMaxItems`） |

自定义心跳提示词（composition 配置，**不带 `insert`**，避免与 bundle 层重复）：

```yaml
- id: dsh-heartbeat
  config:
    prompt: |
      【心跳】当前时间 {{time}}。看一眼最近的对话和待办：
      有进展说进展、有风险说风险；都没有就一句话带过。
      总长不超过 5 句，中文。
```

想指定任务快照插在哪，就把 `{{tasks}}` 写进自定义提示词；不写也能用——`taskNudge` 开着时快照会自动追加到末尾。

> 为什么不用 settings 面板的通用 namespace？DSH 的 settings wire 只服务一张
> 硬编码白名单（`WEB_SETTINGS_NAMESPACES`），插件无法把自有 namespace 暴露给
> 浏览器写入。本插件因此在 host 自建了 `GET/POST /api/heartbeat/config`
> 路由，设置面板里的「心跳 Heartbeat」区块直连该路由，写入即热应用。

## 开发

```sh
node --test
```

无参 `node --test` 会自动发现 `test/*.test.mjs`（`test/runtime.test.mjs` + `test/tasks.test.mjs`），当前共 60 个用例。

## 已知边界

- 心跳只在 DSH 进程活着时存在（app 关了就停）。
- 每个会话（root agent）各自一条定时器，互不干扰；子 agent 不挂心跳。
- 插件在会话已打开后才热挂载/热重载时，会对现有 root agent 做一次幂等补挂（不重复计时）；热挂载之后新开的会话仍走 `agent/created`。
- 心跳**不打断**正在跑的任务；任务结束后它会立刻补一句。
- 心跳是「汇报」不是「新任务」：默认提示词要求它别自作主张开新活。
- 任务巡检同样只问不做：快照里的事项要真的动手，仍需要你在心跳提问里点头。
- `taskNudge: false` 是整开关：心跳消息里没有任务快照、也没有巡检 / 提问指令，只留通用汇报提示词。
- 任务快照来自宿主 session projections，是**只读**的实时视图；宿主没有该服务（较老版本的 DSH）时自动降级为纯提示词心跳，不会报错。
- 硬停前已排队的一条心跳（agent 忙时）会在当前轮结束时被消费——此后绝无新拍。
- 与 dsh-plugin-memory 互相独立、零依赖；两者同时安装时消息在同一个 inbox 队列里排队，不冲突。
- 插件依赖 `agent.followup` / `agent.inbox` 等 **agent-loop 驱动面**——它们不属于 DSH 公开 API catalog，已锁定 DSH 0.2.x；宿主若换实现，最多丢一拍并打一条 warn，不会在定时器里抛崩插件。
- **版本要求**：官方 DSH 0.2.1-rc.5 系列、session format v4；`package.json` 已声明 `engines.dsh: "^0.2.1-rc.5"`，细节见上方「版本要求」。

## License

MIT
