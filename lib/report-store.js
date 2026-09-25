/**
 * Heartbeat report store: a ring buffer of report entries persisted as one
 * JSON file under <dshHome>/heartbeat-reports.json.
 *
 * The file is a cache for the settings-page report view — it is NOT part of
 * the session log and does not survive machine moves. Writes are atomic
 * (tmp + rename) and best-effort: an unwritable disk degrades to memory-only.
 *
 * @module dsh-plugin-heartbeat/report-store
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const REPORT_FILENAME = 'heartbeat-reports.json'

export function defaultReportPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), REPORT_FILENAME)
}

export class HeartbeatReportStore {
  /**
   * @param {{ path?: string, retention?: number }} [options]
   */
  constructor(options = {}) {
    this.path = options.path ?? defaultReportPath()
    this.retention = Math.max(10, Math.trunc(Number(options.retention ?? 200)))
    /** @type {object[]} */
    this.entries = []
    /** @type {Record<string, number>} sessionId → last reported session seq */
    this.cursors = {}
    this.load()
  }

  /** Read the file if present; corrupt files start empty instead of failing. */
  load() {
    try {
      if (!existsSync(this.path)) return
      // Tolerate a UTF-8 BOM (see lib/store.js).
      const raw = JSON.parse(readFileSync(this.path, 'utf8').replace(/^\uFEFF/, ''))
      if (raw && Array.isArray(raw.entries)) this.entries = raw.entries
      if (raw && raw.cursors && typeof raw.cursors === 'object' && !Array.isArray(raw.cursors)) {
        this.cursors = raw.cursors
      }
    } catch {
      // keep last good state (or empty)
    }
  }

  snapshot() {
    return [...this.entries]
  }

  /** Last reported session seq, or undefined when this session is new. */
  getCursor(sessionId) {
    const value = this.cursors[sessionId]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  /**
   * Replace the persisted cursors with the live sessions' current seqs.
   * Persisting them is what stops a DSH restart from treating months-old
   * tool errors as "this window" (the in-memory map alone cannot survive).
   * @param {Map<string, number>} map
   */
  replaceCursors(map) {
    const next = {}
    for (const [sessionId, seq] of map) {
      if (typeof seq === 'number' && Number.isFinite(seq)) next[sessionId] = seq
    }
    this.cursors = next
    this.persist()
  }

  /** Append one entry (newest last), evicting the oldest beyond retention. */
  append(entry) {
    const record = { id: randomUUID(), time: Date.now(), ...entry }
    this.entries.push(record)
    if (this.entries.length > this.retention) {
      this.entries.splice(0, this.entries.length - this.retention)
    }
    this.persist()
    return record
  }

  /** Change retention at runtime and prune immediately (no restart needed). */
  setRetention(value) {
    const next = Math.max(10, Math.trunc(Number(value)))
    if (!Number.isFinite(next) || next === this.retention) return this.retention
    this.retention = next
    if (this.entries.length > next) {
      this.entries.splice(0, this.entries.length - next)
    }
    this.persist()
    return this.retention
  }

  /** Drop every entry (user-initiated cleanup from the settings UI). */
  clear() {
    this.entries = []
    this.persist()
  }

  /**
   * Refresh one session's LATEST row in place when the level is unchanged —
   * a持续 problem stays ONE row whose timestamp moves instead of stacking
   * duplicates. A row from an older generation is never touched.
   * @returns {boolean} whether the newest row was refreshed
   */
  touch(sessionId, patch) {
    const latest = this.latestFor(sessionId)
    if (!latest) return false
    if (latest.level !== patch.level) return false
    latest.time = Date.now()
    if (patch.summary !== undefined) latest.summary = patch.summary
    if (patch.detail !== undefined) latest.detail = patch.detail
    this.persist()
    return true
  }

  /** Newest session-kind entry of one session (the row that carries its flag). */
  latestFor(sessionId) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]
      if (entry.sessionId === sessionId && entry.kind === 'session') return entry
    }
    return undefined
  }

  persist() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ entries: this.entries, cursors: this.cursors }, null, 2)}\n`)
      renameSync(tmp, this.path)
    } catch {
      // memory-only fallback
    }
  }

  /**
   * Regenerate the .md report document opened from the settings UI.
   * @param {string} mdPath absolute path of the markdown file
   * @param {{ title?: string, status?: object, reportEnabled?: boolean }} [meta]
   */
  writeMarkdown(mdPath, meta = {}) {
    const lines = []
    lines.push(`# ${meta.title ?? 'HeartBeat Report'}`)
    lines.push('')
    const status = meta.status ?? {}
    const statusText = meta.reportEnabled === false
      ? '心跳汇总未开启'
      : status.status === 'paused'
        ? '已暂停（连续无人回应）'
        : status.status === 'disabled'
          ? '已停用'
          : `运行中 · 第 ${status.tickCount ?? 0} 拍`
    lines.push(`> ${statusText} ｜ 生成于 ${new Date().toISOString()}`)
    lines.push('')
    const levelName = { ok: '🟢 正常', decide: '🔵 需决策', warn: '🟡 异常', info: '⚪ 信息' }
    if (this.entries.length === 0) {
      lines.push('尚无心跳报告。')
    } else {
      for (const entry of [...this.entries].reverse()) {
        const time = new Date(entry.time).toISOString().replace('T', ' ').slice(0, 19)
        lines.push(`## ${levelName[entry.level] ?? entry.level} · ${entry.source ?? '—'} · ${time}`)
        lines.push('')
        if (entry.summary) lines.push(entry.summary)
        if (entry.detail && typeof entry.detail === 'object') {
          const detail = entry.detail
          const bits = []
          if (detail.cwd) bits.push(`工作区：\`${detail.cwd}\``)
          if (detail.turnEnd) bits.push(`最近一轮：${detail.turnEnd}`)
          if (typeof detail.toolErrors === 'number') bits.push(`工具错误：${detail.toolErrors}`)
          if (typeof detail.idleMin === 'number') bits.push(`空闲：${detail.idleMin} 分钟`)
          if (bits.length) lines.push(bits.join(' ｜ '))
          if (detail.lastUserText) lines.push(`> 最近用户：${detail.lastUserText}`)
          if (detail.lastAssistantText) lines.push(`> 最近助手：${detail.lastAssistantText}`)
        }
        lines.push('')
      }
    }
    try {
      mkdirSync(dirname(mdPath), { recursive: true })
      writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8')
    } catch {
      // best-effort
    }
  }
}
