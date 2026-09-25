# dsh-plugin-heartbeat

> A heartbeat plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): wakes the agent on a configurable interval so it proactively reports progress, risks, and blockers — or just checks in.

DeepSeek Harness 的「心跳」插件：给 agent 装一个定时唤醒的闹钟，让它**主动**开口 —— 汇报进展、风险、卡点，或者没事贫两句。类似 OpenClaw 的心跳模式。

## 怎么工作

- Host 平面的 Cordis 插件，监听 `agent/created`，给每个 **root agent**（子 agent 跳过）挂一个独立定时器。
- 每次心跳通过 `agent.followup()` 注入一条合成 user 消息（`source.kind === 'plugin'`）：
  - **agent 空闲** → 立即开新一轮，主动说话；
  - **agent 忙** → 消息排队，当前轮结束立刻处理 —— **不打断、不丢失**；
  - 连续忙时多拍心跳 → 只保留一条待处理（`inbox.replace` 原地替换，不堆积）。
- **退避间隔（v0.4.0）**：初始 10 分钟；无人回复则下一拍 20 分钟、再下一拍 30 分钟（`[base, 2×base, 3×base]` 自动推导，可 `backoffSeconds` 显式覆盖）。冷场越久，吵得越稀。
- **硬停保证（v0.4.0，token 保护）**：连续 `pauseAfterMissed`（默认 3）拍没有真人回复 → **拆掉定时器彻底停止**，绝不再投递；只有你的下一条消息能复活它，并从初始 10 分钟档**重新计时**。聊天活跃时每次你说话都会重置相位——心跳只在真正的冷场后才开口。
- **轻量唤醒（v0.4.0）**：投递前先请宿主的 compaction 服务把长历史压成 checkpoint 摘要（`compactBeforeBeat`，默认开，失败不影响投递），注入的指令明确「不调工具、不复盘历史、≤5 句」——每拍消耗的上下文尽量小。
- **每小时封顶（可选）**：`maxBeatsPerHour`（默认 0=关）给任何 60 分钟窗口设心跳上限，防「断续回复反复重置退避」的极端烧法。
- 注入的消息在对话流里渲染为一条折叠的 context 小行，不是整块用户气泡。

## 安装

```sh
dsh plugin --profile <profile> add dsh-plugin-heartbeat
```

（包内置 `dsh.bundle` manifest，`dsh plugin add` 会把它自动挂进 profile 的 bundles 层；dsh-market 里的一键安装同此通道。）

重启 DSH 后生效。之后在 **设置 → 心跳 Heartbeat** 面板里随时改频率、开关与暂停阈值，保存即热应用（无需重启）。

> ⚠️ **不要**再往 profile 的 `cordis.patch.yml` 里手写 `- insert: {id: dsh-heartbeat, ...}`：
> 那会与 bundle manifest 的自动挂载产生两条同名 entry，整个 profile 会以
> `duplicate loader entry id "dsh-heartbeat"` 启动失败（2026-08-18 实机事故，
> 当时撞的是 memory 插件的同名条目）。运行期配置走 `<dshHome>/heartbeat.json`；
> 覆盖 composition 键（如 `prompt`）用**不带 insert 的 id 覆盖条目**，见下。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关（用户层存在 `<dshHome>/heartbeat.json`） |
| `intervalSeconds` | `600` | 初始心跳周期（钳制在 30–86400 秒）；退避后续档自动 ×2、×3 |
| `pauseAfterMissed` | `3` | 硬停阈值：连续 N 拍无真人回复 → 拆定时器彻底停止；用户下一条消息复活并回初始档重新计时。`0` = 关闭 |
| `backoffSeconds` | 未设 | 显式退避档位数组（如 `[600, 900, 1800]`，仅 composition） |
| `compactBeforeBeat` | `true` | 投递前先压缩历史为 checkpoint 摘要（仅 composition，无 compaction 服务时自动跳过） |
| `maxBeatsPerHour` | `0` | 每 60 分钟滑动窗口的心跳上限（`0`=关闭，仅 composition） |
| `prompt` | 内置 | 每拍投递的指令模板，`{{time}}` 会替换为当前时间（仅 composition 配置） |
| `configFile` | `<dshHome>/heartbeat.json` | 用户配置文件路径（`enabled` / `intervalSeconds` / `pauseAfterMissed`） |
| `report` | `{enabled:false}` | 心跳汇总引擎（模式 B），见下 |

## 心跳汇总引擎（模式 B，本地扩展 2026-09-25）

默认每个会话各自回答自己的心跳（模式 A）。开启 `report.enabled` 后进入**报告模式**：

- **来源会话静默**：不注入消息、不唤醒、**0 模型 token**——状态是从会话日志里机械抄录的；
- 一个引擎按四段管道运行：采集(机械摘要) → 判定(机械规则 + **仅疑似异常时**一次模型调用)
  → 分发(报告条目/三色状态旗/策略唤醒) → 记账(无人应答硬停·退避·每小时上限)；
- 报告内嵌在 **设置 →「心跳 Heartbeat」页底部**（另有独立页）：🟢 正常 / 🔵 需决策 / 🟡 异常；
  **默认折叠**，出现黄点或蓝点自动展开最近 5 条，手动折叠后保持折叠；不弹窗；
- 点击「心跳报告」标题 → 在资源管理器/Finder 中打开完整 `.md` 报告
  （`<dshHome>/heartbeat-report.md`，每拍重写）；
- 统计口径为**窗口式**：只统计"自上次汇报以来"新增的工具错误与轮次结局
  （游标持久化，重启后也不会把历史错误当成新异常）；待决策为状态语义，未答复前一直显示蓝点；
- 「无人应答硬停」保留：连续 N 拍无任何真人活动 → 拆定时器，任意真人消息或打开报告页即可恢复；
- 判级模型可在设置页选择：默认跟随 Harness 默认模型，列表标注**最便宜（推荐）**。

```yaml
# 不带 insert 的 id 覆盖条目（bundle 层已 insert）
- id: dsh-heartbeat
  config:
    report:
      enabled: true
      retention: 200                  # 报告保留条数（10–1000）
      judgment:
        enabled: true                 # 疑似异常时用模型判级
        model:                        # 可选：固定判级模型（默认 = Harness 默认模型）
          provider: deepseek-official
          model: deepseek-flash
      strategies:                     # 跟随心跳节奏的策略（0 token 传感器）
        - id: watch-tokens
          label: 监控 tokens.json
          every: 1                    # 每 N 拍评估一次
          level: warn                 # 命中时的状态旗颜色 info|warn|decide
          message: tokens.json 被改动
          sensor:
            kind: file
            path: C:\work\design\tokens.json
            mode: changed              # changed | exists | missing
          wake:                       # 可选：命中时唤醒指定会话处理
            sessionId: session-xxxx
          wakePrompt: tokens.json 变了，复核一下
```

机制要点：报告引擎用 `ctx.sessions.list()` + `Session.ownEvents()` 抄录摘要
（最近用户/助手文本、turn 结果、工具错误数、空闲时长）；模型判定走 `ctx.llm.stream`
（不建会话），价格表来自人工核对的 USD/1M 表（`lib/model-pricing.js`，仅用于排序推荐）。
每个拍点广播 `heartbeat/beat` 事件，供其它策略插件跟随节奏。

自定义心跳提示词（composition 配置，**不带 `insert`**，避免与 bundle 层重复）：

```yaml
- id: dsh-heartbeat
  config:
    prompt: |
      【心跳】当前时间 {{time}}。看一眼最近的对话和待办：
      有进展说进展、有风险说风险；都没有就一句话带过。
      总长不超过 5 句，中文。
```

> 为什么不用 settings 面板的通用 namespace？DSH 的 settings wire 只服务一张
> 硬编码白名单（`WEB_SETTINGS_NAMESPACES`），插件无法把自有 namespace 暴露给
> 浏览器写入。本插件因此在 host 自建了 `GET/POST /api/heartbeat/config`
> 路由，设置面板里的「心跳 Heartbeat」区块直连该路由，写入即热应用。

## 开发

```sh
node --test
```

## 已知边界

- 心跳只在 DSH 进程活着时存在（app 关了就停）。
- 每个会话（root agent）各自一条定时器，互不干扰；子 agent 不挂心跳。
- 心跳**不打断**正在跑的任务；任务结束后它会立刻补一句。
- 心跳是「汇报」不是「新任务」：默认提示词要求它别自作主张开新活。
- 硬停前已排队的一条心跳（agent 忙时）会在当前轮结束时被消费——此后绝无新拍。
- 与 dsh-plugin-memory 互相独立、零依赖；两者同时安装时消息在同一个 inbox 队列里排队，不冲突。
- （报告模式，模式 B）摘要覆盖所有 live **根**会话（**子代理会话跳过**，与模式 A 的"子 agent 不挂心跳"一致），无会话内排队——引擎统一计时、永不触碰会话；报告历史与汇报游标持久化在 `<dshHome>/heartbeat-reports.json`。

## License

MIT
