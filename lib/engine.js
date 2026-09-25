/**
 * Heartbeat engine (report mode) — the four-stage beat pipeline:
 *
 *   拍点(tick)
 *     → ①采集: mechanical digests of every live session (0 model tokens)
 *     → ②判定: mechanical suspicion rules, then ONE model call only when
 *              something looks off (per-session level = ok | warn | error)
 *     → ③分发: report entries (green/gray normally, red/yellow on suspicion),
 *              strategy hits (file sensors) and optional session wake-ups
 *     → ④记账: missed-beat hard stop, backoff tiers, hourly cap, `heartbeat/beat`
 *              event broadcast
 *
 * Source sessions are never woken: they stay silent, and their status is
 * copied out of the logs they already wrote. Hard-stop stays anchored here —
 * a real user message in ANY session, or the report page being opened,
 * resets the counter; N quiet beats in a row dismantle the timer.
 *
 * @module dsh-plugin-heartbeat/engine
 */

import { digestSession, mechanicalSuspect, mechanicalLevel, truncate } from './digest.js'
import { evaluateStrategies } from './strategies.js'
import { buildHeartbeatMessage } from './runtime.js'

const JUDGE_TIMEOUT_MS = 30_000

export class HeartbeatEngine {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {object} options
   * @param {() => object} options.readConfig user config (enabled/intervalSeconds/pauseAfterMissed/…)
   * @param {() => object} options.readReportConfig report config (retention/judgment/strategies)
   * @param {object} options.reportStore HeartbeatReportStore
   * @param {() => object | undefined} [options.getFs]
   * @param {() => object | undefined} [options.getLlm]
   * @param {() => { provider: string, model: string } | undefined} [options.getDefaultModel]
   * @param {() => object | undefined} [options.getSessions]
   * @param {(session: object) => string | undefined} [options.getTitle]
   * @param {object} [options.logger]
   */
  constructor(ctx, options) {
    this.ctx = ctx
    this.logger = options.logger
    this.readConfig = options.readConfig
    this.readReportConfig = options.readReportConfig
    this.reportStore = options.reportStore
    this.getFs = options.getFs
    this.getLlm = options.getLlm
    this.getDefaultModel = options.getDefaultModel
    this.getSessions = options.getSessions
    this.getTitle = options.getTitle

    this.timer = undefined
    this.tickCount = 0
    this.missedCount = 0
    this.paused = false
    this.disposed = false
    this.lastBeatAt = undefined
    this.stopWatchers = []
    this.userActivityAt = undefined
    this.getReportMdPath = options.getReportMdPath
  }

  // ----- lifecycle -----

  start() {
    if (this.disposed) return
    const stopCreated = this.ctx.on?.('agent/created', ({ agent }) => {
      const stopInserted = agent.ctx?.on?.('agent/inbox/inserted', ({ message }) => {
        if (message?.source?.kind === 'user') this.onUserInteraction()
      })
      if (typeof stopInserted === 'function') this.stopWatchers.push(stopInserted)
    })
    if (typeof stopCreated === 'function') this.stopWatchers.push(stopCreated)
    this.arm()
  }

  dispose() {
    this.disposed = true
    this.clearTimer()
    for (const stop of this.stopWatchers) {
      try {
        stop()
      } catch {
        // best-effort
      }
    }
    this.stopWatchers = []
  }

  clearTimer() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** Interval for the next beat: backoff tier selected by missedCount. */
  currentIntervalMs(config) {
    const base = Math.max(30, Math.trunc(Number(config.intervalSeconds ?? 600)))
    const explicit = Array.isArray(config.backoffSeconds) && config.backoffSeconds.length > 0
      ? config.backoffSeconds.map((n) => Math.max(30, Math.trunc(Number(n))))
      : [base, 2 * base, 3 * base]
    const tier = Math.min(this.missedCount, explicit.length - 1)
    return explicit[tier] * 1000
  }

  arm() {
    if (this.disposed || this.paused) return
    this.clearTimer()
    const config = this.readConfig()
    if (config.enabled === false) return
    const ms = this.currentIntervalMs(config)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.tick().catch((error) => {
        this.logger?.warn?.(`heartbeat: engine tick failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, ms)
    this.timer.unref?.()
  }

  reschedule() {
    if (!this.disposed && !this.paused) this.arm()
  }

  /** Real human presence anywhere: reset missed count and revive a paused engine. */
  onUserInteraction() {
    if (this.disposed) return
    const wasPaused = this.paused
    this.missedCount = 0
    this.paused = false
    this.userActivityAt = Date.now()
    if (wasPaused) this.logger?.info?.('heartbeat: engine resumed after user activity')
    this.arm()
  }

  /** The report page was opened: counts as human presence (hard-stop anchor). */
  touch() {
    this.onUserInteraction()
  }

  /** Hard unattended stop: drop the timer; only human activity revives it. */
  pause() {
    this.clearTimer()
    if (!this.paused) {
      this.paused = true
      this.logger?.info?.('heartbeat: engine paused (unattended)')
    }
  }

  status() {
    const config = this.readConfig()
    return {
      status: config.enabled === false ? 'disabled' : this.paused ? 'paused' : 'running',
      intervalSeconds: Math.max(30, Math.trunc(Number(config.intervalSeconds ?? 600))),
      pauseAfterMissed: Math.max(0, Math.trunc(Number(config.pauseAfterMissed ?? 3))),
      missedCount: this.missedCount,
      tickCount: this.tickCount,
      lastBeatAt: this.lastBeatAt,
    }
  }

  // ----- pipeline -----

  /** @returns {Promise<void>} */
  async tick() {
    if (this.disposed) return
    const config = this.readConfig()
    if (config.enabled === false) return

    // ④ Hard stop gate: enough quiet beats → dismantle the timer.
    const pauseAfter = Math.max(0, Math.trunc(Number(config.pauseAfterMissed ?? 3)))
    if (pauseAfter > 0 && this.missedCount >= pauseAfter) {
      this.pause()
      return
    }

    // Sliding hourly cap (counted, not skipped silently).
    if (this.beatTimes === undefined) this.beatTimes = []
    const maxPerHour = Math.max(0, Math.trunc(Number(config.maxBeatsPerHour ?? 0)))
    if (maxPerHour > 0) {
      const now = Date.now()
      this.beatTimes = this.beatTimes.filter((time) => now - time < 3600_000)
      if (this.beatTimes.length >= maxPerHour) {
        this.logger?.info?.(`heartbeat: hourly cap (${maxPerHour}) reached, skipping engine beat`)
        this.arm()
        return
      }
      this.beatTimes.push(now)
    }

    this.tickCount += 1
    const now = Date.now()
    const report = this.readReportConfig()

    // ① Collect: mechanical digests for sessions with new activity or suspicion.
    const sessions = (typeof this.getSessions === 'function' ? this.getSessions()?.list?.() : undefined) ?? []
    /** @type {object[]} */
    const digests = []
    /** @type {Map<string, number>} cursors to persist once the loop is done */
    const nextCursors = new Map()
    for (const session of sessions) {
      try {
        // 尊重原作者边界（README：子 agent 不挂心跳）：subagent 会话不参与报告。
        if (session.header?.origin === 'subagent') continue
        // Cursor comes from the persisted report store, so a DSH restart does
        // not fall back to "the whole tail" and re-report old tool errors.
        const prevSeq = this.reportStore?.getCursor?.(session.id)
        const title = typeof this.getTitle === 'function' ? this.getTitle(session) : undefined
        // Window-scoped digest: only what happened since the previous report
        // contributes tool errors / the turn outcome, so a fixed historical
        // error is not reported again on every beat.
        const digest = digestSession(session, { title, now, sinceSeq: prevSeq })
        if (typeof digest.seq === 'number') nextCursors.set(session.id, digest.seq)
        const hasNew = prevSeq === undefined || (typeof digest.seq === 'number' && digest.seq > prevSeq)
        const suspect = mechanicalSuspect(digest)
        if (!hasNew && !suspect) continue
        digest.hasNewActivity = hasNew
        digests.push(digest)
      } catch {
        // a broken session contributes nothing
      }
    }
    this.reportStore?.replaceCursors?.(nextCursors)

    // ①+③ Strategies: zero-token sensors; hits become entries and may wake a session.
    const strategyHits = await evaluateStrategies(report.strategies, {
      fsService: typeof this.getFs === 'function' ? this.getFs() : undefined,
      tickCount: this.tickCount,
      log: this.logger,
    })
    for (const hit of strategyHits) {
      const strategy = hit.strategy
      this.appendEntry({
        kind: 'strategy',
        level: strategy.level ?? 'warn',
        source: strategy.label || strategy.id,
        summary: truncate(strategy.message || strategy.label || strategy.id, 200),
        detail: { strategy: strategy.id, ...hit.detail },
        strategy: strategy.id,
      })
      if (strategy.wake?.sessionId) this.wakeSession(strategy.wake.sessionId, strategy.wakePrompt ?? strategy.message)
    }

    // ② Judge: model only when something mechanical looks off.
    /** @type {Map<string, string>} */
    const levels = new Map()
    const suspects = digests.filter((digest) => digest.hasNewActivity && mechanicalSuspect(digest))
    if (suspects.length > 0) {
      const judged = await this.judge(suspects, report)
      if (judged) {
        for (const [id, level] of judged) levels.set(id, level)
      }
    }

    // ③ Distribute: one report entry per digest. Same level → refresh the
    // session's latest row in place (timestamp moves, no duplicates); a
    // changed level appends a new row, which becomes that session's status
    // flag (so a fixed problem turns the flag green again).
    for (const digest of digests) {
      const level = levels.get(digest.sessionId)
        ?? (digest.hasNewActivity && !mechanicalSuspect(digest) ? 'ok' : mechanicalLevel(digest))
      const summary = this.summaryText(digest)
      const touched = this.reportStore.touch?.(digest.sessionId, { level, summary, detail: digest })
      if (!touched) {
        this.appendEntry({
          kind: 'session',
          level,
          source: this.sourceLabel(digest),
          summary,
          detail: digest,
          sessionId: digest.sessionId,
        })
      }
    }

    this.emitBeat({ now, tickCount: this.tickCount, digests, strategyIds: strategyHits.map((hit) => hit.strategy.id) })
    this.missedCount += 1
    this.lastBeatAt = now
    this.writeMarkdown()
    this.logger?.info?.(`heartbeat: engine beat #${this.tickCount}: ${digests.length} digests, ${strategyHits.length} strategy hits, missed ${this.missedCount}`)
    this.arm()
  }

  /** Regenerate the .md report document (opened from the settings UI). */
  writeMarkdown() {
    try {
      const path = typeof this.getReportMdPath === 'function' ? this.getReportMdPath() : undefined
      if (typeof path !== 'string' || path.length === 0) return
      this.reportStore.writeMarkdown(path, {
        title: 'HeartBeat Report',
        status: this.status(),
        reportEnabled: this.readReportConfig().enabled,
      })
    } catch (error) {
      this.logger?.warn?.(`heartbeat: report markdown write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ----- helpers -----

  appendEntry(entry) {
    try {
      this.reportStore.append(entry)
    } catch (error) {
      this.logger?.warn?.(`heartbeat: report append failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  sourceLabel(digest) {
    const parts = [digest.title, digest.sessionId].filter(Boolean)
    const label = parts[0] || 'unknown'
    return digest.cwd ? `${label} · ${digest.cwd}` : label
  }

  summaryText(digest) {
    // Window-scoped: "本周期" = everything since the previous report.
    const turn = digest.turnEnd
      ? `本周期结束的轮次：${digest.turnEnd}`
      : (typeof digest.sinceSeq === 'number' ? '本周期无结束的轮次' : '最近一轮：无')
    const errors = digest.toolErrors > 0 ? `｜新增工具错误 ${digest.toolErrors}` : ''
    const decide = digest.pendingQuestion === true ? '｜有待决策' : ''
    const recent = digest.lastUserText || digest.lastAssistantText
    const idle = typeof digest.idleMin === 'number' ? `｜空闲 ${digest.idleMin} 分钟` : ''
    return truncate(`${turn}${errors}${idle}${recent ? `｜最近：${recent}` : ''}`, 240)
  }

  /**
   * One small model call to re-judge suspected digests.
   * @param {object[]} suspects
   * @param {object} report report config (judgment gate)
   * @returns {Promise<Map<string, string> | undefined>} sessionId → level, or undefined to fall back
   */
  async judge(suspects, report) {
    const judgment = report.judgment
    if (judgment?.enabled === false) return undefined
    const llm = typeof this.getLlm === 'function' ? this.getLlm() : undefined
    const route = typeof this.getDefaultModel === 'function' ? this.getDefaultModel() : undefined
    if (!llm || !route?.provider || !route.model || typeof llm.stream !== 'function') return undefined

    const payload = suspects.map((digest) => ({
      id: digest.sessionId,
      title: digest.title,
      turnEnd: digest.turnEnd,
      toolErrors: digest.toolErrors,
      user: digest.lastUserText,
      assistant: digest.lastAssistantText,
    }))
    const system = [
      '你是心跳报告的判级器。为每个会话给出一个级别：',
      'ok = 正常；warn = 异常（轮次报错、工具错误等，需要留意）；decide = 需要用户做决策。',
      '只输出一个 JSON 对象：{"levels": {"<id>": "ok|warn|decide"}}，不要输出任何其它内容。',
    ].join('\n')
    const text = JSON.stringify(payload)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS)
    try {
      const chunks = []
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        maxTokens: 256,
        signal: controller.signal,
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') chunks.push(chunk.text)
      }
      const parsed = this.parseLevels(chunks.join(''))
      if (!parsed) return undefined
      const levels = new Map()
      for (const suspect of suspects) {
        const level = parsed[suspect.sessionId]
        if (level === 'ok' || level === 'warn' || level === 'decide') levels.set(suspect.sessionId, level)
      }
      return levels.size > 0 ? levels : undefined
    } catch (error) {
      this.logger?.warn?.(`heartbeat: judgment call failed, falling back to rules: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    } finally {
      clearTimeout(timeout)
    }
  }

  parseLevels(text) {
    try {
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start < 0 || end <= start) return undefined
      const value = JSON.parse(text.slice(start, end + 1))
      if (!value || typeof value.levels !== 'object' || value.levels === null) return undefined
      return value.levels
    } catch {
      return undefined
    }
  }

  /** Wake one specific session with a strategy prompt (the only paid wake-up). */
  wakeSession(sessionId, promptText) {
    try {
      const agent = this.ctx.agents?.get?.(sessionId)
      if (!agent) {
        this.logger?.info?.(`heartbeat: strategy wake skipped, session "${sessionId}" is not live`)
        return
      }
      if (!promptText) return
      agent.followup(buildHeartbeatMessage(String(promptText)))
      this.logger?.info?.(`heartbeat: strategy woke session "${sessionId}"`)
    } catch (error) {
      this.logger?.warn?.(`heartbeat: strategy wake failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Broadcast the beat snapshot so other plugins/strategies can ride the rhythm. */
  emitBeat(payload) {
    try {
      this.ctx.emit?.('heartbeat/beat', payload)
    } catch {
      // listeners are best-effort
    }
  }
}
