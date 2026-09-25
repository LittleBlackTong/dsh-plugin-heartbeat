/**
 * Mechanical session digests — zero model tokens.
 *
 * The digest is assembled from data the session log ALREADY contains: the
 * last real user message, the last visible assistant conclusion, the most
 * recent turn outcome and tool-error count. No LLM call is involved, so
 * reporting every session every beat is free; the model is only invited
 * (by the engine) when `mechanicalSuspect()` flags something.
 *
 * @module dsh-plugin-heartbeat/digest
 */

/** Visible prose of a message content array (text blocks only). */
export function visibleText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Collapse whitespace and truncate for digest display. */
export function truncate(text, max = 160) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * Summarize one live Session into a digest entry.
 *
 * Window semantics (the fix for "every beat reports old tool errors"):
 * `opts.sinceSeq` is the session's seq at the previous report. Tool errors and
 * the turn outcome are counted ONLY inside that window — what happened since
 * the last beat — while the context fields (last user/assistant text, last
 * activity, idle time) always describe the session's current tail. A pending
 * decision is state-scoped instead: it stays until a real user message lands
 * after the question, because an unanswered question is still unanswered.
 *
 * @param {object} session a dsh-session Session (header / ownEvents / seq / id)
 * @param {{ title?: string, now?: number, sinceSeq?: number }} [opts]
 * @returns {object} digest entry
 */
export function digestSession(session, opts = {}) {
  const events = []
  try {
    const own = session.ownEvents?.() ?? []
    events.push(...own.slice(-240))
  } catch {
    // defensive: a broken session contributes an empty digest
  }
  const sinceSeq = typeof opts.sinceSeq === 'number' ? opts.sinceSeq : undefined

  /** @type {string | undefined} */
  let turnEnd
  let lastUserText = ''
  let lastAssistantText = ''
  let toolErrors = 0
  let lastActivityTime = 0
  let lastUserTime = 0
  // State-scoped, order-based: a question is pending until a REAL user message
  // appears after it (event order is the log order; no seq needed).
  let pendingQuestion = false
  let windowEvents = 0

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const time = typeof event.time === 'number' ? event.time : 0
    const seq = typeof event.seq === 'number' ? event.seq : 0
    const inWindow = sinceSeq === undefined ? true : seq > sinceSeq
    if (inWindow) windowEvents += 1
    if (time) lastActivityTime = Math.max(lastActivityTime, time)
    const data = event.data
    if (!data || typeof data !== 'object') continue
    switch (event.type) {
      case 'turn/end': {
        if (!inWindow) break
        const kind = data.reason?.kind
        if (typeof kind === 'string') turnEnd = kind
        break
      }
      case 'user/message': {
        // Only REAL user messages; injected plugin/context messages never count.
        if (data.source?.kind !== 'user') break
        pendingQuestion = false
        const text = visibleText(data.content)
        if (text) {
          lastUserText = text
          lastUserTime = time
        }
        break
      }
      case 'assistant/message': {
        const text = visibleText(data.message?.content ?? data.content)
        if (text) lastAssistantText = text
        break
      }
      case 'tool/call': {
        // The agent asked the user a structured question → needs a decision.
        if (data.name === 'ask_user_question') pendingQuestion = true
        break
      }
      case 'tool/result': {
        if (!inWindow) break
        if (data.error || data.message?.isError) toolErrors += 1
        break
      }
      default:
        break
    }
  }

  const header = session.header ?? {}
  const now = opts.now ?? Date.now()
  return {
    sessionId: session.id,
    title: opts.title,
    cwd: header.cwd,
    agentPreset: header.agentPreset,
    seq: session.seq,
    sinceSeq,
    windowEvents,
    lastActivityTime: lastActivityTime || undefined,
    lastUserTime: lastUserTime || undefined,
    idleMin: lastActivityTime ? Math.max(0, Math.round((now - lastActivityTime) / 60000)) : undefined,
    lastUserText: truncate(lastUserText),
    lastAssistantText: truncate(lastAssistantText),
    turnEnd,
    toolErrors,
    pendingQuestion,
  }
}

/** Mechanical suspicion pre-filter: does this digest deserve a model glance? */
export function mechanicalSuspect(digest) {
  return (
    digest.turnEnd === 'error'
    || digest.turnEnd === 'blocked'
    || digest.turnEnd === 'max-tokens'
    || (typeof digest.toolErrors === 'number' && digest.toolErrors > 0)
    || digest.pendingQuestion === true
  )
}

/**
 * Mechanical fallback level, used when no model is available or it fails.
 * Palette: `ok` = green (normal), `decide` = blue (needs a user decision),
 * `warn` = yellow (session anomaly). Three states only — the red/error level
 * was removed by design.
 */
export function mechanicalLevel(digest) {
  if (digest.pendingQuestion === true) return 'decide'
  if (digest.turnEnd === 'error' || digest.turnEnd === 'blocked') return 'warn'
  if (digest.turnEnd === 'max-tokens' || (typeof digest.toolErrors === 'number' && digest.toolErrors > 0)) return 'warn'
  return 'ok'
}
