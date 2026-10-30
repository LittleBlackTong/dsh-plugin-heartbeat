# dsh-plugin-heartbeat v0.6.0 设计：从「定时闹钟」到「自主神经」

- 日期：2026-10-30
- 状态：设计待批（未实施）
- 版本目标：0.6.0（minor，默认行为变化：静默拍）
- 决策已锁定：L3 分级授权取 **A 保守方案**（默认全关，只留类别开关，v0.6 不预设）
- 硬约束：**纯插件形态、可热插拔、不改宿主/不动其它插件/不影响项目架构**

## 1. 背景与目标

现状 v0.5.1 是 timer-driven：每个 root agent 一个固定间隔定时器，到点就 `followup` 开一轮，消息里附任务快照。实测问题：

- 空转拍 ~30%（本会话 6–7 拍中 2 拍「没检测到」仍开轮）；
- 同一批任务反复复述（快照是清单复述，不是变化检测）；
- 无观测/无控制面（不知道下次何时、为什么暂停、上几拍做了什么）；
- 运行态（missed/档位/pendingId）只在内存，重启丢失；
- 与 memory digest nudge 无协调。

v0.6.0 目标：把心跳变成**自主神经**——静默检查为主、有信号才开口、激活分级可授权、状态可观测可控、重启不丢、热插拔干净。

**非目标**：插件内不放 LLM 判断；不改宿主内核；不做跨设备通知；不做自定义消息卡片渲染（宿主能力未验证）；不做 L3 默认开启。

**成功指标（可测）**：

| 指标 | 目标 |
|---|---|
| 空转注入率 | 无信号场景注入 0 次（当前 ~30%） |
| 去重 | 同一事项在去重窗口内最多 1 次 |
| 预算 | 每会话每日注入 ≤ `maxBeatsPerDay` |
| 重启安全 | 重启后不立即重复轰炸（冷却窗口） |
| 可观测 | 面板/`status` 能回答：状态、下次 ETA、上拍原因、预算余量、最近 5 拍 |
| 热插拔 | add/remove 不残留 timer/route/listener；remove 后路由 404、心跳停止 |

## 2. 插件边界契约（验收项）

不改宿主、不动别的插件、不影响项目架构：

| 项 | 约定 |
|---|---|
| 挂载 | 自带 `dsh.bundle.patch`（`insert: dsh-heartbeat`），`dsh plugin add/remove`；不写 profile 手写 patch |
| 宿主依赖 | `agents`（必需，必有）+ `sessionProjections` / `compaction` / `webServer`（**可选注入**，缺失降级）；不要求宿主新 API |
| 跨插件 | **零 import、零私有文件共享**；与 memory digest / 官方 schedule / goal-round-driver 只做「读公开投影 + 时间窗口让位」 |
| 副作用 | 只写自己的 `<dshHome>/heartbeat.json`（配置）与 `heartbeat-vitals.json`（运行态）；不改系统配置、不动别人文件、不改会话内容（除 followup 注入） |
| 异常 | 路由重复/投影异常/样式认领失败/写盘失败 → warn 降级，绝不 throw 到宿主 |

**热插拔矩阵（逐条实测）**

| 场景 | 期望 |
|---|---|
| 运行中 add | apply → 对已存在 root agent 幂等补挂（沿用 v0.5.0 `attach()`） |
| 运行中 remove | dispose 清 timer、解绑 inbox 监听、注销路由、归还面板区块/导航图标；保留配置文件便于回装 |
| 重复挂载/双实例 | 同 agent 仅一个 runtime；apply 幂等；重复路由注册只 warn |
| 插件异常/不兼容 | 宿主静默 skip，其它 bundle 不受影响；插件内部异常只影响该拍 |
| 旧/坏配置 | v1→v2 自动迁移；坏文件回退默认值，不阻塞启动 |
| 移除后重装 | vitals 恢复但强制一次「重启冷却」（默认 5 分钟不播） |

## 3. 自主等级模型（B 分级授权，A 保守默认）

| 级别 | 行为 | v0.6 默认 |
|---|---|---|
| L0 | 静默检查，零注入 | ✅ 所有 tick 的解析默认 |
| L1 | 有信号开一轮，只汇报进展/风险 | ✅ |
| L2 | 开一轮 + `ask_user_question`（做不做/怎么选） | ✅ 需要决策时 |
| L3 | 白名单类别内自行推进（不先问） | ⛔ 默认关闭；`l3Allow` 为空数组；只实现「指令级授权 + 宿主 approval 兜底」语义 |
| L4 | 连续未回应时升级措辞/优先级（不加频） | ✅ |

L3 类别（配置枚举，默认空）：`read`（检索/读文件）、`test`（跑测试/lint/构建）、`notes`（写工作区文档/记忆）、`continue`（续写已约定草稿）。永不进白名单：`git-push/publish`、`deploy`、`delete`、`rm`、外部写。文档必须写明：L3 不是沙箱，不可逆操作仍由宿主 approval 拦截。

## 4. 架构与模块

```
传感器层 sensors.js   ：同步读投影 + 时间 → signals[] / arousal / activity / pressure
节律层   rhythm.js    ：interval = f(base, arousal, missed, quiet, jitter, refractory)
决策层   gate.js      ：signals → L0/L1/L2/L4；去重窗口；预算；安全闸；reason
动作层   runtime.js   ：compaction → 组织消息（why-now + 快照 + 指令）→ followup / ask 指令
状态层   vitals.js    ：per-session 运行态 + 全局预算 + 原子写/防抖/重启恢复
配置层   schema.js + store.js：v2 用户配置 + v1→v2 迁移 + 工作区覆盖
```

### 4.1 信号（sensors）

| 信号 | 来源 | 去重键 | 基础权重 |
|---|---|---|---|
| 团队任务变 ready | `agentTeam` diff（pending + blockers 全 completed） | `team:<id>:ready` | +5 |
| 团队任务变 blocked | `agentTeam` diff | `team:<id>:blocked` | +4 |
| 任务被完成 | `agentTeam` diff（completed ≠ 上次） | —（只计入汇报，不去重） | +1 |
| 待办新增/变化 | `todos` diff（内容+状态签名） | `todos:<sig>` | +2 |
| 目标受阻/暂停 | `goal` phase ∈ {blocked,paused} | `goal:<id>:<phase>` | +4 |
| 待回答的用户问题 | `userQuestions` 有 pending | `question:<id>` | +3 |
| 用户刚说过话 | last user interaction < 2min | — | −5（抑制） |
| 上下文压力高 | `contextPressure` > 阈值 | — | −6（抑制） |
| 久未拍 | now − lastPulse > 2×interval | — | +1 |
| 静默时段 | quietHours | — | 直接 L0 |

arousal = clamp(Σ权重, 0, 8)。信号快照（上次 seen 的签名）存 vitals，按 sessionId 隔离。

### 4.2 节律（rhythm）

```
tier        = clamp(missed, 0, schedule.length-1)          # 既有退避档位
moodFactor  = 1 / (1 + clamp(arousal, 0, 4) / 2)           # arousal 4 → 1/3 间隔
interval    = clamp(base * (1 + missed) * moodFactor, 30, 86400)
if quietHours(now): 不排拍，排到静默结束 + jitter(0..60s)
if refractory：上次投递 < refractorySeconds → 延后到 refractory 结束
多会话：同一时刻只允许一个会话投递（全局锁 + 全局预算），其余顺延
```

### 4.3 门控（gate）

```
decide(session, signals, activity, pressure, vitals, config) -> { level, reason, keys }
1. enabled=false / snoozed / paused / quiet → L0(reason)
2. pressure > 0.9 → L0(context-pressure)
3. 过滤去重窗口内已提醒的 keys（dedupeWindowMinutes，默认 90）
4. 无剩余信号 → L0(no-signal)
5. 有决策类信号（ready/blocked/goal/待回答）→ L2（assist 模式）
   仅进展类 → L1
6. missed >= 2 且同一决策类信号仍存在 → L4（措辞升级，仍只问不做）
7. 预算（每日/每小时/refractory）不足 → L0(budget) 并缩短下次间隔
```

### 4.4 动作（消息格式）

```
【心跳】<level>·由 heartbeat 插件定时唤醒，不是用户的消息。当前时间 {{time}}。
为什么现在叫你：<reason 一行>
<任务快照块（沿用 v0.5.x，taskNudge 开关）>
<按 level 的指令：L1 汇报 / L2 ask_user_question / L4 升级措辞>
要求：总长 ≤5 句，中文，小蓝口吻；只提问不擅自开工（L3 类别例外说明仅当 l3Allow 非空）
```

自定义 prompt 兼容：保留 `{{time}}`/`{{tasks}}`，新增 `{{reason}}`；无占位符时任务块+reason 追加到末尾。

### 4.5 状态（vitals）

`heartbeat-vitals.json`（与配置分离，便于手改配置不被运行态污染）：

```json
{
  "version": 1,
  "global": { "lastPulseAt": 0, "budget": { "day": "YYYY-MM-DD", "beats": 0 } },
  "sessions": {
    "<sessionId>": {
      "lastPulseAt": 0, "lastDeliveredAt": 0, "missedCount": 0,
      "paused": false, "pausedReason": null,
      "snoozeUntil": 0,
      "seen": { "todos": "<sig>", "team": "<sig>", "goal": "<sig>", "questions": "<sig>" },
      "asked": { "<key>": { "lastAt": 0, "count": 0 } },
      "history": [{ "at": 0, "level": "L2", "reason": "team:task-3:ready", "delivered": true }]
    }
  }
}
```

- history 每会话最多 10 条；`asked` 只保留 200 条（LRU by lastAt）。
- 原子写（tmp+rename）+ 防抖（≤1 次/2s）+ 读失败降级为空态。
- 重启恢复：`lastDeliveredAt` 距今 < restartCooldown（默认 300s）→ 首拍强制 L0。

### 4.6 配置 v2（heartbeat.json）

```json
{
  "version": 2,
  "enabled": true,
  "mode": "assist",
  "baseIntervalSeconds": 600,
  "pauseAfterMissed": 3,
  "backoffSeconds": null,
  "compactBeforeBeat": true,
  "maxBeatsPerHour": 0,
  "maxBeatsPerDay": 12,
  "quietHours": { "start": "23:00", "end": "08:00" },
  "dedupeWindowMinutes": 90,
  "refractorySeconds": 300,
  "restartCooldownSeconds": 300,
  "taskNudge": true,
  "taskNudgeMaxItems": 5,
  "l3Allow": [],
  "prompt": null,
  "workspaces": { "<abs cwd>": { "enabled": true, "mode": "assist", "baseIntervalSeconds": 600, "quietHours": null, "maxBeatsPerDay": 12 } }
}
```

- 覆盖优先级：composition 配置 < 全局用户配置 < 工作区覆盖（按 `agent.session.header.cwd`）。
- 迁移：v1 `{enabled, intervalSeconds, pauseAfterMissed, taskNudge, taskNudgeMaxItems}` → v2 对应字段（`intervalSeconds`→`baseIntervalSeconds`），其余补默认；写回 v2 时保留未知字段（前向兼容）。
- 校验：schemastery；坏文件忽略并保持内存态。

### 4.7 事件驱动（可选注入）

`sessionProjections.onChanged(listener)` 可用时订阅 `todos/agentTeam/goal/userQuestions`：
- 变化 → 给该 session 打 `pendingSignal = true` 标记；
- 若该会话 idle、不在 refractory/静默/预算耗尽 → 2s 防抖后触发一次 tick（等价「早搏」，受同样门控）；
- 服务不可用 → 纯定时器模式，行为不变。

## 5. HTTP 路由（沿用自建配置通道）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/heartbeat/config` | 读 v2 配置（含迁移后形态） |
| POST | `/api/heartbeat/config` | patch 合并（校验，热应用） |
| GET | `/api/heartbeat/status` | vitals + `nextBeatAt` + 暂停/静默原因 + 预算 + 最近 5 拍 |
| POST | `/api/heartbeat/control` | `{action: "beat-now"\|"snooze"\|"pause"\|"resume"\|"reset", sessionId?, minutes?}` |

全部回环路由，方法/体大小校验；`beat-now` 仍受安全闸（但忽略 quiet/预算，标记 manual）。

## 6. 客户端面板（零构建，中文/英文）

- 生命体征卡：状态（静息/工作/应激/暂停）、下次 ETA、今日预算 x/y、最近 5 拍（时间+级别+原因）。
- 控制：Beat now / Snooze 1h / Pause today / Reset（调 `/control`）。
- 配置：现有开关 + 新增 mode、quietHours、去重窗口、预算、L3 类别（默认全灰）。
- i18n：内置 zh/en 字典，按 `navigator.language` 选择；label 保持 `Heartbeat`、爱心图标不变。
- 面板任何异常走现有 ErrorBoundary，不空白。

## 7. 错误处理与降级

| 故障 | 行为 |
|---|---|
| 投影服务缺失/抛错 | 该信号忽略，其余照常；整拍无信号 → L0 |
| 压缩失败 | 跳过压缩照常投递（现有） |
| 写盘失败 | 内存态继续，warn；下次重试 |
| 配置坏 | 回退默认 + warn |
| 路由重复 | 注册失败 warn，不阻塞插件 |
| agent 无 followup/inbox | 该拍跳过 + warn |
| 多实例 | 同 agent 幂等；全局预算按进程，不跨进程同步（文档注明） |

## 8. 测试与验收

**单测（目标 ≥100，当前 74）**：
- config v2：默认值、校验、v1→v2 迁移、坏文件回退、工作区覆盖优先级；
- vitals：原子写/读、防抖、LRU、历史截断、重启冷却判定；
- sensors：各投影 diff、签名稳定性、缺失降级、pressure/activity 抑制；
- rhythm：arousal/missed/quiet/refractory/jitter 边界与钳制；
- gate：L0–L2/L4 判定、去重窗口、预算、manual 例外；
- runtime：静默不注入、信号注入含 why-now、事件触发防抖、多会话互斥；
- 热插拔：apply→dispose（timer/route/listener/slot 全清）→ 再 apply 幂等；
- 客户端契约（vm）：面板渲染不崩、i18n 切换、控制按钮 POST 正确。

**实机验收（运行中 DSH 0.2.1-rc.5）**：
1. 离线组合树校验（现有脚本）：无 duplicate id、compat gate OK；
2. `dsh plugin remove` → `/api/heartbeat/config` 404、心跳停止、会话无报错；`add` → 补挂恢复；
3. 静默拍：无信号会话挂 30 分钟，注入 0 次；
4. 事件触发：团队任务变 ready 后 ≤ 10s 内 L2 提问；
5. 面板：状态/ETA/预算/控制可用，中英文正常。

## 9. 版本与发布

- `0.6.0`；`engines.dsh` 保持 `^0.2.1-rc.5`；`files` 不变（lib/** 覆盖新模块）。
- 文档：README.md / README.zh.md 增「自主等级 / 静默拍 / 观测面板 / 配置 v2 迁移」章节；CHANGELOG `[0.6.0]`。
- 发布仍需阿周 go；三渠道（git / npm / 商店描述更新）一次完成。

## 10. 未决/风险

- ⚠️ 自定义消息卡片（按钮）依赖宿主渲染能力，未验证 → v0.6 不做，用 ask_user_question 卡片代替。
- ⚠️ L3 无沙箱：只在指令层授权，approval 兜底；文档必须写清。
- ⚠️ 多进程（多 DSH 实例）共享 vitals 文件：进程内锁 + 原子写，不强一致；文档注明。
- 风险：静默拍让「存在感」下降 → 默认 `mode: assist`，面板可显示「上次活动」，并提供 beat-now。
