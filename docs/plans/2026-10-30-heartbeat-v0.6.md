# dsh-plugin-heartbeat v0.6.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the heartbeat plugin from a timer-driven alarm into an autonomic nervous system: silent pulses, signal-triggered activation (L0–L4), change detection + dedupe, persisted vitals, observable/controllable panel, fully hot-pluggable.

**Architecture:** Five layers inside the existing plugin package — `sensors.js` (cheap host-side projection reads + diffs), `rhythm.js` (interval from arousal/missed/quiet/refractory), `gate.js` (L0/L1/L2/L4 + dedupe + budgets), `vitals.js` (per-session runtime state persisted to a separate JSON file), `runtime.js` (pipeline + delivery). Config moves to schema v2 with automatic v1 migration. No host changes, no imports from other plugins.

**Tech Stack:** ESM (zero build), `@deepseek-ai/schemastery`, cordis plugin (`ctx.inject` optional services), `node:test` + `node:vm` for the browser half.

**Spec:** `docs/specs/2026-10-30-heartbeat-v0.6-design.md`

## Global Constraints

- Plugin-only: no host/core changes, no imports from other plugins, no shared private files with memory/schedule/goal.
- Only optional injections: `sessionProjections`, `compaction`, `webServer`; `agents` is required.
- Every failure degrades to a `warn` + L0/L1 fallback; never throw into the host.
- `engines.dsh: "^0.2.1-rc.5"` stays; package `files` stays `lib/**`, `types/**`, `cordis.patch.yml`, changelog/readmes/license.
- Version target `0.6.0`; default behavior change documented (silent pulses).
- L3 (`l3Allow`) defaults to `[]`; semantics are instruction-level only, approval is the real guard.
- Tests must pass: `node --test` (target ≥ 100 cases; currently 74).
- Hot-plug acceptance: add/remove leaves no timers/routes/listeners/slots behind; re-add is idempotent.

---

### Task 1: Config v2 + v1→v2 migration

**Files:**
- Modify: `lib/schema.js`, `lib/store.js`, `lib/index.js` (config resolution), `types/index.d.ts`
- Test: `test/config-store-v2.test.mjs`

**Interfaces:**
- Consumes: existing `HeartbeatConfigStore` API (`get()`, `update(patch)`, `watch(cb)`, `path`).
- Produces: `SettingsSchema` (v2 fields), `migrateConfigV1toV2(raw) -> v2`, `HeartbeatConfigStore#get() -> v2 config`, `resolveEffectiveConfig(config, workspaceCwd) -> effective`.

- [ ] **Step 1: Write failing tests**

```js
// test/config-store-v2.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsSchema, migrateConfigV1toV2 } from '../lib/schema.js'
import { HeartbeatConfigStore } from '../lib/store.js'

test('v2 defaults: mode assist, quiet hours, budgets, l3Allow empty', () => {
  const resolved = SettingsSchema({})
  assert.equal(resolved.mode, 'assist')
  assert.equal(resolved.baseIntervalSeconds, 600)
  assert.deepEqual(resolved.l3Allow, [])
  assert.equal(resolved.maxBeatsPerDay, 12)
  assert.equal(resolved.dedupeWindowMinutes, 90)
  assert.equal(resolved.refractorySeconds, 300)
  assert.equal(resolved.quietHours.start, '23:00')
})

test('migrateConfigV1toV2 keeps user values and maps intervalSeconds', () => {
  const v2 = migrateConfigV1toV2({ enabled: false, intervalSeconds: 180, pauseAfterMissed: 5, taskNudge: false })
  assert.equal(v2.version, 2)
  assert.equal(v2.enabled, false)
  assert.equal(v2.baseIntervalSeconds, 180)
  assert.equal(v2.pauseAfterMissed, 5)
  assert.equal(v2.taskNudge, false)
})

test('store loads a v1 file, migrates it and writes v2 back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-v2-'))
  const file = join(dir, 'heartbeat.json')
  writeFileSync(file, JSON.stringify({ enabled: true, intervalSeconds: 300, pauseAfterMissed: 2 }))
  const store = new HeartbeatConfigStore({ path: file })
  assert.equal(store.get().version, 2)
  assert.equal(store.get().baseIntervalSeconds, 300)
  store.update({ dedupeWindowMinutes: 30 })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2)
})

test('workspace override beats global, global beats defaults', () => {
  const effective = resolveEffectiveConfig(
    SettingsSchema({ baseIntervalSeconds: 600, workspaces: { '/w': { baseIntervalSeconds: 120 } } }),
    '/w',
  )
  assert.equal(effective.baseIntervalSeconds, 120)
})
```

- [ ] **Step 2: Run to fail** — `node --test test/config-store-v2.test.mjs` → FAIL (missing exports/fields).
- [ ] **Step 3: Implement** — extend `SettingsSchema` with v2 keys (see spec §4.6); add `migrateConfigV1toV2(raw)`; `HeartbeatConfigStore.load()` detects `version !== 2`/legacy shape and migrates, then persists v2; `update()` merges v2 patch; add `resolveEffectiveConfig(config, cwd)` in `store.js` (workspace overrides by `session.header.cwd`, unknown keys preserved).
- [ ] **Step 4: Run to pass** — the new file passes; existing `test/runtime.test.mjs` config-store assertions updated where the shape changed.
- [ ] **Step 5: Commit** — `feat: config schema v2 with automatic v1 migration`.

---

### Task 2: Vitals store (runtime state, atomic + debounced)

**Files:**
- Create: `lib/vitals.js`
- Test: `test/vitals.test.mjs`

**Interfaces:**
- Produces: `new VitalsStore({ path, now?, debounceMs?, historyLimit?, askedLimit?, restartCooldownSeconds? })` with
  - `get(sessionId) -> { lastPulseAt, lastDeliveredAt, missedCount, paused, pausedReason, snoozeUntil, seen, asked, history }`
  - `recordPulse(sessionId, { level, reason, delivered }) -> void`
  - `markDelivered(sessionId, keys) -> void`
  - `setSeen(sessionId, seen) -> void`
  - `setPaused(sessionId, paused, reason) -> void`
  - `snooze(sessionId, untilMs) -> void`
  - `bumpBudget(nowMs) -> { day, beats }`, `budgetLeft(config, nowMs) -> number`
  - `restartCooldownActive(sessionId, nowMs) -> boolean`
  - `flush()`, `dispose()`

- [ ] **Step 1: Write failing tests**

```js
// test/vitals.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VitalsStore } from '../lib/vitals.js'

const tmpPath = () => join(mkdtempSync(join(tmpdir(), 'hb-vitals-')), 'heartbeat-vitals.json')

test('records history with cap and asked entries with LRU', () => {
  const store = new VitalsStore({ path: tmpPath(), historyLimit: 3, askedLimit: 2 })
  for (let i = 0; i < 5; i += 1) store.recordPulse('s', { level: 'L1', reason: `r${i}`, delivered: true })
  assert.deepEqual(store.get('s').history.map((row) => row.reason), ['r2', 'r3', 'r4'])
  store.markDelivered('s', ['a', 'b', 'c'])
  assert.deepEqual(Object.keys(store.get('s').asked).sort(), ['b', 'c'])
})

test('persists and reloads across instances', () => {
  const path = tmpPath()
  const first = new VitalsStore({ path })
  first.recordPulse('s', { level: 'L2', reason: 'team:task-3:ready', delivered: true })
  first.flush()
  const second = new VitalsStore({ path })
  assert.equal(second.get('s').history.length, 1)
  assert.equal(second.get('s').history[0].level, 'L2')
})

test('restart cooldown suppresses immediately after reload', () => {
  const path = tmpPath()
  const now = 1_000_000
  const first = new VitalsStore({ path, now: () => now })
  first.recordPulse('s', { level: 'L1', reason: 'x', delivered: true })
  first.flush()
  const second = new VitalsStore({ path, now: () => now + 60_000, restartCooldownSeconds: 300 })
  assert.equal(second.restartCooldownActive('s', now + 60_000), true)
  assert.equal(second.restartCooldownActive('s', now + 301_000), false)
})

test('daily budget rolls over at local midnight', () => {
  const now = new Date('2026-10-30T10:00:00')
  const store = new VitalsStore({ path: tmpPath(), now: () => now.getTime() })
  assert.equal(store.bumpBudget(now.getTime()).beats, 1)
  assert.equal(store.budgetLeft({ maxBeatsPerDay: 2 }, now.getTime()), 1)
  const tomorrow = new Date('2026-10-31T09:00:00')
  assert.equal(store.budgetLeft({ maxBeatsPerDay: 2 }, tomorrow.getTime()), 2)
})

test('writes atomically and debounces repeated writes', () => {
  const path = tmpPath()
  const store = new VitalsStore({ path, debounceMs: 10 })
  store.recordPulse('s', { level: 'L0', reason: 'none', delivered: false })
  store.flush()
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(raw.version, 1)
  assert.equal(raw.sessions.s.lastPulseAt > 0, true)
})
```

- [ ] **Step 2: Run to fail** — module missing.
- [ ] **Step 3: Implement `lib/vitals.js`** — version 1 file, `sessions[id]` shape per spec §4.5, atomic write (`tmp`+`rename`), debounce timer (unref), `asked` LRU trim, history cap, corrupt file → empty state, `flush()` on dispose, restart cooldown from persisted `lastDeliveredAt`.
- [ ] **Step 4: Run to pass**.
- [ ] **Step 5: Commit** — `feat: persisted vitals store for heartbeat runtime state`.

---

### Task 3: Sensors — projection diffs, arousal, suppression

**Files:**
- Create: `lib/sensors.js`
- Modify: `lib/tasks.js` (expose snapshot without instruction)
- Test: `test/sensors.test.mjs`

**Interfaces:**
- Produces: `collectSignals({ projections, session, config, vitals, now }) -> { signals: Signal[], arousal: number, lastUserActivityAt: number|undefined, pressure: number, seen: object }`
  - `Signal = { key, kind: 'team-ready'|'team-blocked'|'team-completed'|'todos'|'goal'|'question', weight, text }`
- `signatureOf({ todos, team, goal, questions }) -> { todos: string, team: string, goal: string, questions: string }`

- [ ] **Step 1: Write failing tests** (fake `projections.stateOf`, fake vitals `get/setSeen`):

```js
test('new ready team task produces a dedupe key', () => {
  const projections = { stateOf: (_s, key) => ({
    todos: null,
    agentTeam: { tasks: [{ id: 'task-3', subject: '发布', status: 'pending', blockedBy: [] }] },
    goal: { current: null },
    userQuestions: { questions: [] },
  })[key] }
  const result = collectSignals({ projections, session: { id: 's' }, config: {}, vitals: { get: () => ({}), setSeen: () => {} }, now: 0 })
  assert.ok(result.signals.some((signal) => signal.key === 'team:task-3:ready'))
  assert.ok(result.arousal >= 5)
})

test('nothing changed since last seen produces no signals', () => {
  // vitals.seen already equals signatureOf(...) -> signals empty, arousal 0
})
```

- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement** — canonical signatures (stable JSON of ids+status+content hashes); diff vs `vitals.get(id).seen`; weights per spec §4.1; suppress signals when `pressure > 0.9` (return `pressure` and let gate decide); compute `lastUserActivityAt` from an injectable source (`options.lastUserActivityAt` supplied by runtime).
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit** — `feat: signal sensors with change detection`.

---

### Task 4: Rhythm + gate

**Files:**
- Create: `lib/rhythm.js`, `lib/gate.js`
- Test: `test/rhythm.test.mjs`, `test/gate.test.mjs`

**Interfaces:**
- `computeIntervalMs({ config, missed, arousal, now, lastDeliveredAt }) -> number`
- `inQuietHours(quietHours, date) -> boolean` (supports overnight windows)
- `decide({ config, vitals, sessionId, signals, arousal, pressure, now, manual }) -> { level: 'L0'|'L1'|'L2'|'L4', reason, keys, suppressedBy?: string }`

- [ ] **Step 1: Write failing tests**

```js
test('arousal shortens the interval, missed lengthens it', () => {
  const base = computeIntervalMs({ config: { baseIntervalSeconds: 600 }, missed: 0, arousal: 0, now: 0, lastDeliveredAt: 0 })
  const excited = computeIntervalMs({ config: { baseIntervalSeconds: 600 }, missed: 0, arousal: 4, now: 0, lastDeliveredAt: 0 })
  const tired = computeIntervalMs({ config: { baseIntervalSeconds: 600 }, missed: 2, arousal: 0, now: 0, lastDeliveredAt: 0 })
  assert.equal(base, 600_000)
  assert.ok(excited < base)
  assert.ok(tired > base)
})

test('overnight quiet hours are detected', () => {
  assert.equal(inQuietHours({ start: '23:00', end: '08:00' }, new Date('2026-10-30T01:00:00')), true)
  assert.equal(inQuietHours({ start: '23:00', end: '08:00' }, new Date('2026-10-30T12:00:00')), false)
})

test('gate picks L2 for decision signals, L1 for progress only', () => {
  const decision = decide({ config: { mode: 'assist', dedupeWindowMinutes: 90 }, vitals: fakeVitals(), sessionId: 's', signals: [{ key: 'team:task-3:ready', kind: 'team-ready', weight: 5 }], arousal: 5, pressure: 0.1, now: 1_000_000 })
  assert.equal(decision.level, 'L2')
  const progress = decide({ config: { mode: 'assist' }, vitals: fakeVitals(), sessionId: 's', signals: [{ key: 'todos:x', kind: 'todos', weight: 2 }], arousal: 2, pressure: 0.1, now: 1_000_000 })
  assert.equal(progress.level, 'L1')
})

test('dedupe window drops repeated keys and empty result is L0', () => {
  // asked[key].lastAt within window -> L0 with suppressedBy 'dedupe'
})

test('daily budget exhaustion forces L0', () => {
  // budgetLeft 0 -> L0 budget
})
```

- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement** — formulas per spec §4.2/§4.3; `rhythm` clamps 30 000–86 400 000 ms, applies jitter (+0..60 s deterministic from sessionId+now to keep tests stable), refractory deferral; `gate` order: enabled/snooze/quiet/pressure → dedupe → priority (decision > progress) → mode (silent → L0) → escalation (missed ≥ 2 on decision signal → L4) → budget.
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit** — `feat: arousal-driven rhythm and activation gate`.

---

### Task 5: Message composition (snapshot + why-now + level instructions)

**Files:**
- Modify: `lib/tasks.js` (`renderTaskSnapshot(snapshot)`, keep `renderTaskNudge` as wrapper for compatibility), `lib/prompt.js` (`{{reason}}`, level-aware default prompt), `types/index.d.ts`
- Test: `test/tasks.test.mjs`, `test/prompt-levels.test.mjs`

**Interfaces:**
- `renderTaskSnapshot(snapshot) -> string` (snapshot only, no instruction; ≤800 chars)
- `renderHeartbeatText({ prompt, now, taskBlock, reason, level, mode, l3Allow }) -> string`

- [ ] **Step 1: Failing tests** — L2 text contains `ask_user_question` and the reason line; L1 text must NOT contain `ask_user_question`; `{{reason}}` substitution; custom prompt without placeholders gets reason+task appended.
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement** — extract snapshot rendering; default prompt gains `为什么现在叫你：{{reason}}`; instructions switch by level; L3 sentence appears only when `l3Allow.length > 0`.
- [ ] **Step 4: Run to pass** (existing tasks/prompt tests updated).
- [ ] **Step 5: Commit** — `feat: level-aware heartbeat messages with why-now`.

---

### Task 6: Runtime pipeline integration

**Files:**
- Modify: `lib/runtime.js`
- Test: `test/runtime-v06.test.mjs` (new), keep `test/runtime.test.mjs` green

**Interfaces:**
- `new HeartbeatRuntime(agent, { readConfig, getCompaction, getProjections, getVitals, logger, agents, now? })`
- `tick()` → pipeline; returns `Promise<void> | undefined` as today.
- `forceBeat(trigger)` for manual beat-now.
- `noteSignal()` for event-driven wake.

- [ ] **Step 1: Failing tests** — no signals → `followup` never called, vitals history L0; decision signal → one delivery with why-now; dedupe second tick within window → L0; missed escalation → L4 text; restart cooldown → first tick L0; quiet hours → L0; disposal clears timers; compaction path still works (existing tests).
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement** — replace `deliverBeat` path with `sensors → rhythm → gate → deliver`; persist vitals on every pulse; keep existing backoff/missed/hard-stop semantics; `runtime.pendingId` stays; add `dispose()` flushing vitals.
- [ ] **Step 4: Run to pass** (all existing runtime tests updated for the new readConfig shape).
- [ ] **Step 5: Commit** — `feat: autonomic heartbeat pipeline (silent pulses + signal activation)`.

---

### Task 7: HTTP routes + plugin wiring

**Files:**
- Modify: `lib/index.js`
- Test: `test/routes-v06.test.mjs`

**Interfaces:**
- Routes: `GET/POST /api/heartbeat/config`, `GET /api/heartbeat/status`, `POST /api/heartbeat/control`.
- `apply(ctx, config)` wires config store, vitals store, routes, and the root-agent attach loop; dispose flushes + unregisters.

- [ ] **Step 1: Failing tests** — config GET returns v2 shape; status returns `{ state, nextBeatAt, pausedReason, budget: { used, max }, history }`; control actions mutate vitals through a fake runtime registry (`beat-now` calls `forceBeat`, `snooze` sets snoozeUntil, `pause`/`resume`); unknown action → 400.
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement** — extract a tiny router table; reuse existing body parsing; keep duplicate-route warn; register status/control only when `webServer` exists; wire `sessionProjections.onChanged` (optional) to `runtime.noteSignal()` with 2 s debounce; graceful dispose.
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit** — `feat: status/control routes and vitals-aware wiring`.

---

### Task 8: Client panel — vitals, controls, i18n

**Files:**
- Modify: `lib/client.js`
- Test: `test/client-half.test.mjs` (extend vm harness)

**Interfaces:**
- Consumes: `GET /api/heartbeat/status`, `GET/POST /api/heartbeat/config`, `POST /api/heartbeat/control`.
- Produces: panel rendered strings via `navigator.language` (zh default, en fallback); buttons call control endpoint; no crash when status fetch fails.

- [ ] **Step 1: Failing vm tests** — panel renders status/ETA/budget/history rows from a mocked fetch; clicking "Beat now" issues `POST /api/heartbeat/control` with `{action:'beat-now'}`; zh/en labels switch; fetch failure shows error text (ErrorBoundary stays).
- [ ] **Step 2: Run to fail.**
- [ ] **Step 3: Implement** — split panel into `VitalsCard` + `ConfigForm` + `Controls`; add `STRINGS` dict; keep existing config rows and heart icon claim untouched.
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit** — `feat: vitals panel with manual controls and i18n`.

---

### Task 9: Docs, version, hot-plug live verification

**Files:**
- Modify: `README.md`, `README.zh.md`, `CHANGELOG.md`, `package.json` (0.6.0)
- Test: manual + existing suites

- [ ] **Step 1:** README/README.zh: add "Autonomic levels / silent pulses / why-now / vitals panel / config v2 migration" sections; document L3 semantics + approval guard; document plugin boundary/hot-plug.
- [ ] **Step 2:** CHANGELOG `[0.6.0]` with Added/Changed/Fixed/Tests; note default behavior change.
- [ ] **Step 3:** `node --test` ≥100 green; `npm pack --dry-run` includes new lib files.
- [ ] **Step 4:** Offline composition check (existing script): no duplicate ids, compat gate OK.
- [ ] **Step 5:** Live hot-plug on the running DSH 0.2.1-rc.5: `dsh plugin remove dsh-plugin-heartbeat` → `/api/heartbeat/config` 404 + no beats; `add` → status 200 + attach. Record evidence.
- [ ] **Step 6:** (requires 阿周 go) release: git push, npm publish 0.6.0, store yml description update.

## Self-Review

- Spec coverage: §2 boundary/hot-plug → Task 7/9; §3 levels → Task 4/5; §4.1 sensors → Task 3; §4.2 rhythm → Task 4; §4.3 gate → Task 4; §4.4 message → Task 5; §4.5 vitals → Task 2; §4.6 config → Task 1; §4.7 event-driven → Task 7; §5 routes → Task 7; §6 panel → Task 8; §7 errors → embedded in each task; §8 tests → each task + Task 9; §9 release → Task 9.
- No placeholders: each task names exact files, interfaces, failing tests, and commit message.
- Type consistency: `collectSignals` returns `{signals, arousal, pressure, seen}`; `decide` consumes `signals/arousal/pressure`; `renderHeartbeatText` consumes `level/mode/l3Allow/reason/taskBlock`; vitals API names reused across tasks.
