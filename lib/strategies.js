/**
 * Follow-the-beat strategies: sensors evaluated at every tick (or every N
 * ticks) at zero model cost. A hit becomes a report entry with its own level
 * and can optionally wake a specific session.
 *
 * v2 ships one sensor kind — `file` — exactly for the "at heartbeat time,
 * check whether a file changed / appeared / disappeared" use case:
 *   - `changed`: report only when mtime or size moved since the first sighting;
 *   - `exists` / `missing`: report on presence state (every matching tick).
 *
 * @module dsh-plugin-heartbeat/strategies
 */

const SEEN = new WeakMap()

function stateFor(strategy) {
  const entry = SEEN.get(strategy) ?? { mtime: undefined, size: undefined }
  SEEN.set(strategy, entry)
  return entry
}

/**
 * @param {readonly object[]} strategies strategy list from composition config
 * @param {{ fsService?: object, tickCount: number, log?: object }} ctx
 * @returns {Promise<Array<{ strategy: object, detail: object }>>} hits
 */
export async function evaluateStrategies(strategies, { fsService, tickCount, log }) {
  const hits = []
  if (!Array.isArray(strategies) || strategies.length === 0 || !fsService) return hits
  for (const strategy of strategies) {
    try {
      const every = Math.max(1, Math.trunc(Number(strategy.every ?? 1)))
      if (tickCount % every !== 0) continue
      const hit = await evaluateOne(strategy, fsService)
      if (hit) hits.push({ strategy, detail: hit.detail })
    } catch (error) {
      log?.warn?.(`heartbeat: strategy "${strategy?.id}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return hits
}

async function evaluateOne(strategy, fsService) {
  const sensor = strategy?.sensor
  if (!sensor || sensor.kind !== 'file' || typeof sensor.path !== 'string' || sensor.path.length === 0) return undefined

  const target = await fsService.resolve(sensor.path, {}).catch(() => undefined)
  const stat = target ? await fsService.stat(target).catch(() => undefined) : undefined
  const mtime = stat ? Number(stat.mtimeMs ?? Date.parse(stat.mtime ?? '')) : Number.NaN
  const size = stat ? Number(stat.size ?? 0) : undefined

  const mode = sensor.mode ?? 'changed'
  if (mode === 'exists') return stat !== undefined ? { detail: { exists: true } } : undefined
  if (mode === 'missing') return stat === undefined ? { detail: { exists: false } } : undefined

  // mode === 'changed'
  const prev = stateFor(strategy)
  const firstSighting = prev.mtime === undefined
  const changed = !firstSighting && (mtime !== prev.mtime || size !== prev.size)
  prev.mtime = mtime
  prev.size = size
  if (firstSighting) {
    return undefined // record the baseline, report only future changes
  }
  if (!changed) return undefined
  return {
    detail: {
      path: sensor.path,
      exists: stat !== undefined,
      mtime: Number.isFinite(mtime) ? new Date(mtime).toISOString() : undefined,
      size,
    },
  }
}
