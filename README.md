# dsh-plugin-heartbeat

**English** ｜ [中文](README.zh.md)

<p align="center">
  <a href="https://github.com/LittleBlackTong/dsh-plugin-heartbeat"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-LittleBlackTong%2Fdsh--plugin--heartbeat-blue?logo=github"></a>
  <a href="https://www.npmjs.com/package/dsh-plugin-heartbeat"><img alt="npm" src="https://img.shields.io/npm/v/dsh-plugin-heartbeat?logo=npm"></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-green">
</p>

> An autonomic heartbeat for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): it pulses in silence, reads the session's own projections, and only opens a turn when something actually changed — a report (L1), a decision question (L2), or an escalation (L4). No signal, no message.

A Cordis plugin for DeepSeek Harness. v0.5 made the heartbeat *task-aware*; **v0.6.0 turns it from a metronome into an autonomic nervous system**: every pulse reads the session silently, measures arousal, and speaks only when there is a reason. When there is nothing to say, the pulse is recorded in its vitals and nothing is injected at all.

## Heads-up: the default behaviour changed in v0.6.0

- **0.5.x**: one message every `intervalSeconds`, whether or not anything happened (the task snapshot was re-read and repeated).
- **0.6.0**: a **silent pulse** by default — no signal, no turn, no injected message. It speaks at L1/L2/L4 only when it detects a change worth a message (see the level table below).
- The config file is now **v2**: `intervalSeconds` → `baseIntervalSeconds`, plus rhythm / quiet-hours / dedupe / budget / L3 / workspace fields. An existing v1 `heartbeat.json` is **migrated automatically** on load — nothing to do.
- Runtime state now lives in `<dshHome>/heartbeat-vitals.json` (separate from the config, so hand-editing the config never pollutes runtime state). It survives restarts, and after a restart the plugin stays quiet for `restartCooldownSeconds` (default 5 minutes) before it may speak again.
- The settings sidebar label follows the App language — **心跳** in Chinese, **Heartbeat** in English — with the same stroked-heart icon.

## How it works

A host-plane Cordis plugin attaches one runtime to every **root agent** (subagents are skipped), including sessions that already exist when the plugin is hot-mounted.

Each pulse runs the same four steps — the plugin itself never asks an LLM to decide:

```
sensors → rhythm → gate → action
```

- **Sensors** (`lib/sensors.js`): synchronously read the session's public projections — `todos`, `agentTeam`, `goal`, `userQuestions`, plus `contextPressure` — and **diff them against what the last pulse saw**. Only changes become signals, each with a weight; the weights sum into an **arousal** score (0–8). Repeating the same todo list on every beat is exactly the noise v0.6 removes.
- **Rhythm** (`lib/rhythm.js`): the next interval is `baseInterval × (1 + missed) × mood(arousal)`, clamped to 30 s – 24 h, where higher arousal shortens the interval (arousal 4 → one third). Quiet hours suspend pulses entirely, a refractory window enforces a minimum silence after a delivery, and a small deterministic jitter stops several sessions from firing on the same tick.
- **Gate** (`lib/gate.js`): decides **L0 (silent) / L1 (report) / L2 (ask) / L4 (escalation)**, applies the dedupe window and the daily budget, and refuses to speak when you just spoke, when context pressure is high, during quiet hours, or while paused/snoozed.
- **Action** (`lib/runtime.js`): for L1/L2/L4 it optionally compacts long history first, then injects one message carrying a **why-now line**, the task snapshot (when `taskNudge` is on) and a level-specific instruction. An **L0 pulse injects nothing** — it only records a row in the vitals history.

Delivery mechanics (unchanged from v0.5):

- **agent idle** → a fresh turn opens immediately;
- **agent busy** → the message parks in the `next-turn` inbox and is claimed when the current turn ends — at most one pending beat, replaced in place (`inbox.replace`), never stacked;
- consecutive unanswered beats trigger a **hard stop** after `pauseAfterMissed` (default 3); only a real message from you revives the heartbeat and resets its phase;
- an optional sliding **hourly cap** (`maxBeatsPerHour`) protects against the "sporadic replies keep resetting the backoff" worst case.

**Event-driven beats (new in v0.6)**: when the host exposes `sessionProjections.onChanged`, a change in `todos` / `agentTeam` / `goal` / `userQuestions` marks the session and runs **one extra pulse after a 2 s debounce** — still through every gate (dedupe, budget, quiet hours). Without that service the plugin falls back to pure timer mode.

## Autonomy levels (L0–L4)

| Level | Behaviour | Default in v0.6 |
|---|---|---|
| **L0** | Silent pulse: read, diff, record — **inject nothing** | ✅ the default for every tick without a signal |
| **L1** | Open a turn and **report** progress / risks / blockers only | ✅ when there are progress-only signals |
| **L2** | Open a turn and **ask** (`ask_user_question`) whether to act / which option | ✅ when a decision-bearing signal appears |
| **L3** | Within **granted categories**, proceed without asking first | ⛔ **off by default** (`l3Allow: []`); instruction-level authorization only |
| **L4** | Same ask as L2 but with **escalated wording** when a decision signal has already gone unanswered (`missed ≥ 2`) — frequency never increases | ✅ |

Signals that require a decision (and therefore L2/L4): a team task becoming **ready**, a team task becoming **blocked**, the goal entering **blocked / paused**, and a **pending unanswered user question**. Progress-only signals (a team task completed, todos changing) produce L1.

### L3 in one paragraph

L3 is a **per-category grant list** — `read` (search / read files), `test` (run tests / lint / build), `notes` (write workspace docs / notes), `continue` (continue an already-agreed draft). It is empty by default, so v0.6 behaves as "ask, never act". When you grant categories, L2/L4 messages carry one extra line authorizing the agent to proceed inside those categories only; everything else still asks first. **L3 is not a sandbox**: publishing, deploying, deleting, `rm`, git push and any external write are never whitelisted, and irreversible operations are still stopped by the host's approval flow. The grant only changes the instruction, not the host's safety checks.

## Signals, dedupe and budgets

| Signal | Source (projection diff) | Dedupe key | Weight |
|---|---|---|---|
| Team task became ready | `agentTeam` | `team:<id>:ready` | +5 |
| Team task became blocked | `agentTeam` | `team:<id>:blocked` | +4 |
| Goal blocked / paused | `goal` | `goal:<id>:<phase>` | +4 |
| Pending user question | `userQuestions` | `question:<callId>` | +3 |
| Todos changed (open items) | `todos` | `todos:<signature>` | +2 |
| Team task completed | `agentTeam` | — (reported, not deduped) | +1 |

`arousal = clamp(Σ weights, 0, 8)`; as arousal rises the interval shortens.

What suppresses a pulse before it can speak (all in `lib/gate.js`):

- **you just spoke** (< 2 minutes ago) — the heartbeat defers to you;
- **a child subagent / teammate is still working** — the root is idle only because it waits for delegated work, so the pulse is recorded as `L0 · child-active` and nothing is injected or compacted (v0.6.1; set `quietWhileChildrenActive: false` to restore the old behaviour);
- **context pressure > 0.9** — no extra turns near the context limit;
- **quiet hours** (default `23:00–08:00`, configurable; `null` disables them);
- **disabled / snoozed / paused**, or `mode: "silent"`;
- **dedupe**: a signal key already asked inside `dedupeWindowMinutes` (default 90) is dropped;
- **daily budget**: at most `maxBeatsPerDay` (default 12, `0` = unlimited) delivered beats per calendar day, counted process-wide across sessions.

The one exception is the panel's **Beat now** button: a manual beat skips the politeness gates (quiet hours, budget, dedupe, "user recently spoke", an active child session) but still picks its level and still checks that the agent has a usable driver surface.

## Task inspection (the snapshot in the message)

Since v0.5 a beat can carry a compact task snapshot; the sensors reuse the same projections, so the message and the signals cannot disagree.

| Projection | Read | Snapshot rule |
|---|---|---|
| `todos` | session todo list (`content` / `status`) | only `in_progress` / `pending`; `completed` dropped |
| `agentTeam` | Agent Team board (`subject` / `status` / `blockedBy`) | open items only, sorted "ready → in progress → blocked"; blockers named |
| `goal` | persistent goal (`objective` / `phase`) | only `active` / `paused` / `blocked` phases |

Two things to know:

- the `agentTeam` projection is **only registered when the Agent Team optional package is enabled** — without it the read degrades silently;
- the `todos` projection **resets at the start of every turn**: a beat sees the todos of the most recent turn, not a session-wide long-term list.

Robustness:

- missing projection service / missing session / a throwing projection → the signal or the snapshot degrades; a beat is never lost to a failed read;
- the task block is hard-capped at **800 characters**; `taskNudgeMaxItems` caps items per bucket (default 5, range 1–20);
- the plugin **only reads** projections; it never edits your todos, board or goal;
- a custom `prompt` without `{{tasks}}` gets the block appended.

## Vitals and manual control

The **Settings → Heartbeat** panel shows the heartbeat's own life signs, fed by `GET /api/heartbeat/status` (refreshed every 10 s):

- **state**: running / snoozed / paused (and the reason);
- **next check**: the next ETA computed from the current rhythm;
- **today's budget**: delivered beats vs `maxBeatsPerDay`;
- **recent pulses**: the last 5 rows with time, level (L0–L4) and reason — this is where "why didn't it speak?" is answered.

Buttons (POST `/api/heartbeat/control`):

| Action | Effect |
|---|---|
| **Beat now** | force one pulse immediately (manual: skips the politeness gates, still picks a level) |
| **Snooze 30m** | no pulses for 30 minutes (`minutes` is configurable through the API, 1–1440) |
| **Pause** | stop this session's heartbeat until resumed |
| **Resume** | lift pause / snooze and re-arm from the current rhythm |
| **Reset** | clear snooze + pause and resume |

Routes (loopback, plugin-owned):

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/heartbeat/config` | read the v2 config / patch it (validated, hot-applied) |
| GET | `/api/heartbeat/status` | config summary, today's budget, per-session vitals + `nextBeatAt` + last 5 pulses |
| POST | `/api/heartbeat/control` | `{action: "beat-now" \| "snooze" \| "pause" \| "resume" \| "reset", sessionId?, minutes?}` |

Every control action targets the given `sessionId`, or all live sessions when omitted.

The panel's wording is localised through DSH's own locale layer: the client half injects `locale`, registers a `heartbeat` namespace with zh/en packs and declares `locale: 'heartbeat'` on the settings section, so the panel follows **Settings → General → Language** and re-renders immediately when you switch the app language (it does not guess from the browser). The sidebar label follows the same setting — 中文「心跳」/ English `Heartbeat` — and the heart-icon claim re-runs after a language switch, so the mark always sits on the current row.

## Install

```sh
dsh plugin --profile <profile> add dsh-plugin-heartbeat
```

(The package declares a `dsh.bundle` manifest, so `dsh plugin add` mounts it into the profile's bundles layer automatically; one-click install in dsh-market uses the same path.)

Restart DSH. Then use **Settings → Heartbeat** to change the mode, interval, quiet hours, dedupe window, budget, L3 grants and task inspection at any time; saving applies hot (no restart).

> ⚠️ **Don't** hand-write `- insert: {id: dsh-heartbeat, ...}` into the profile's `cordis.patch.yml`: it collides with the bundle manifest's automatic mount and the whole profile fails to start with
> `duplicate loader entry id "dsh-heartbeat"` (real incident on 2026-08-18, colliding with the memory plugin's entry). Runtime config lives in `<dshHome>/heartbeat.json`; override composition keys (such as `prompt`) with an **id-only override entry, no insert** — see below.

## Settings sidebar icon

The settings sidebar entry carries a **stroked heart** mark: a 16×16 grid, `stroke-width: 1.3` (the shared `ICON_MEDIUM_STROKE`), pure-black alpha painted through `mask-image` so the visible colour follows `currentColor` in both light and dark themes. It matches the dsh-plugin-memory icon spec exactly. The official `settings.section` slot projects only id / order / label — there is no icon field — so the plugin claims its own nav row by the exact **localized** label text (`心跳` or `Heartbeat`), mirrors it with a `MutationObserver` (re-claimed after a language switch — the claim key changes with the label — or a remount) and cleans everything up on dispose.

## Version requirements

- **DSH: official 0.2.1-rc.5 series.** `package.json` declares `engines.dsh: "^0.2.1-rc.5"`; the host gates with semver (`includePrerelease: true`), so mind prerelease semantics: `^0.2.1` / `>=0.2.0` **do not match** `0.2.1-rc.5`; only `^0.2.1-rc.5` does. It also covers the eventual 0.2.1 stable, while `0.3.0-rc.1` is judged incompatible.
- **session format v4** (official 0.1.7+). The heartbeat source uses the producer-owned kind `plugin:heartbeat`; v4's native admission rejects the v3 `{kind:'plugin', plugin:'heartbeat'}` wrapper. The v4 and v3 allowlists are mutually exclusive.
- **0.4.2 is the last v3-compatible version**; **from 0.5.0 the plugin supports only the official DSH 0.2.1-rc.5 series**. 0.3.x is not supported yet.
- **Use 0.6.2 or later**: the published 0.6.1 misreads session projections — `stateOf()` returns raw state, so the `subagent` identity `{}` was treated as "this is a subagent" and **no heartbeat attached at all**, while the child-active gate never fired. 0.6.2 reads the wire view first and validates shapes; upgrade.
- **Verified on a real host** (DSH Desktop 0.2.1-rc.5, v0.6.0 build loaded after restart):
  - `GET /api/heartbeat/status` → 200 with both live sessions (`sessionId` / `cwd` / `nextBeatAt` / budget / history), and `/api/heartbeat/config` returns the **v2** config;
  - an existing v1 `heartbeat.json` was migrated automatically (`intervalSeconds` → `baseIntervalSeconds`, plus the new mode / quiet-hours / budget fields) and `heartbeat-vitals.json` was created;
  - **silent pulses work**: with the interval temporarily at 60 s, both sessions recorded an `L0 · no new signal · delivered: false` vitals row while the daily budget stayed at 0 (zero injections); the 600 s / jitter 60 s config was restored afterwards;
  - **hot-plug**: `dsh plugin remove` while running turned `/status` from 200 into 401 (route gone, no crash), and `add` brought it back to 200 with the session restored;
  - **control route**: an unknown action returns 400, `snooze` sets `snoozeUntil`, `reset` clears it;
  - the sidebar heart and the `Heartbeat` section render correctly.
  **Not separately verified on a live host** (unit tests only): event-driven latency (≤10 s), pre-beat compaction, and a real L2 question delivery. The v0.6 autonomy layer is covered by the 129-test suite.

## Configuration (v2)

The user config lives in `<dshHome>/heartbeat.json` (written by the panel or by hand; validated with schemastery). Composition config is the base layer, the user file overrides it, and a matching `workspaces` entry overrides both.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `mode` | `"assist"` | `"assist"` = speak on signals; `"silent"` = never speak (pulses still run and are recorded) |
| `baseIntervalSeconds` | `600` | base pulse interval (30–86400 s); the per-missed backoff tiers scale from it |
| `pauseAfterMissed` | `3` | hard stop after N unanswered beats (0 = off); your next message revives it |
| `backoffSeconds` | `null` | explicit backoff tier array (`null` = derive `[base, 2×base, 3×base]`) |
| `compactBeforeBeat` | `true` | fold long history into a checkpoint before speaking (best-effort) |
| `maxBeatsPerHour` | `0` | sliding hourly cap on delivered beats (0 = off) |
| `maxBeatsPerDay` | `12` | daily budget of delivered beats (0 = unlimited), shared across sessions in the process |
| `dedupeWindowMinutes` | `90` | never re-ask the same signal key inside this window (0 = off) |
| `refractorySeconds` | `300` | minimum silence after a delivery before the next beat |
| `jitterSeconds` | `60` | deterministic per-session jitter (0–600 s) so sessions spread out |
| `restartCooldownSeconds` | `300` | after a restart, stay silent this long even if signals are waiting |
| `quietHours` | `{"start":"23:00","end":"08:00"}` | never speak inside this window (overnight windows supported; `null` disables) |
| `quietWhileChildrenActive` | `true` | stay silent (`L0 · child-active`) while a child subagent / teammate session is still working; manual Beat now is the exception (v0.6.1) |
| `taskNudge` | `true` | include the task snapshot + ask instruction in beats |
| `taskNudgeMaxItems` | `5` | per-bucket item cap in the task snapshot (1–20) |
| `l3Allow` | `[]` | granted L3 categories: `read` / `test` / `notes` / `continue` |
| `prompt` | `null` | custom prompt template (`{{time}}` / `{{tasks}}` / `{{reason}}`); `null` = built-in per-level prompt |
| `workspaces` | `{}` | per-workspace overrides keyed by the session's absolute cwd |

A `workspaces` entry accepts: `enabled`, `mode`, `baseIntervalSeconds`, `quietHours` (object or `null`), `maxBeatsPerDay`, `l3Allow`. Precedence: composition config < user config < matching workspace override.

**v1 → v2 migration**: a v1 file (`intervalSeconds`, no `version`) is migrated on load — `intervalSeconds` becomes `baseIntervalSeconds`, the other fields keep their meaning, missing keys take the v2 defaults — and is written back as v2. A corrupt config file is ignored (the last good config stays in memory, defaults on the next start); unrecognised keys are not persisted. Runtime state is separate: `<dshHome>/heartbeat-vitals.json`.

Custom heartbeat prompt (composition config, **no `insert`**, to avoid duplicating the bundle layer):

```yaml
- id: dsh-heartbeat
  config:
    prompt: |
      【Heartbeat】{{time}} — why now: {{reason}}
      {{tasks}}
      Report progress/risks briefly; ask before doing anything.
```

`{{time}}`, `{{tasks}}` and `{{reason}}` are substituted. A template without `{{tasks}}` gets the task block appended; a template without `{{reason}}` gets the why-now line appended.

## Development

```sh
node --test
```

No-arg `node --test` discovers `test/*.test.mjs`; the suite covers `runtime`, `tasks`, `sensors`, `rhythm`, `gate`, `vitals`, `config-store-v2`, `prompt-levels`, `wiring-v06`, `settings-nav-icon` and `client-half` — **129 tests** at the moment.

Design and implementation notes live in the repo (not shipped in the npm package): `docs/specs/2026-10-30-heartbeat-v0.6-design.md` and `docs/plans/2026-10-30-heartbeat-v0.6.md`.

## Known limits

- The heartbeat only exists while the DSH process is alive (it stops when the app quits).
- Each root agent has its own runtime; **subagent conversations never get a heartbeat** (identity-guarded — see below).
- **By default the heartbeat is quiet**: if nothing changes, it says nothing. "Presence" now comes from the panel's vitals view and the Beat now button, not from scheduled chatter — raise `mode`/dedupe/quiet settings if you want more voice.
- **Never speaks over delegated work (v0.6.1)**: while a child subagent / teammate session is running, the root agent is idle only because it is waiting. A heartbeat at that moment would inject a new turn mid-work, and the client presents the running child as part of the active turn — the new turn would hide it, so you could no longer tell that background work is still running (and pre-beat compaction could fold the live turn away). Pulses therefore record `L0 · child-active` and inject nothing until every child settles; **Beat now** still forces one beat.
- **Never attached to a subagent conversation (v0.6.1)**: teammate / subagent sessions are `mode: "continuable"` children, and a user can re-open or resume one from the sidebar as if it were a top-level chat. Per host semantics such a **resumed child can count as a root** (no owner), which is why `attach()` reads the session's `subagent` projection identity and skips any non-empty one (log `heartbeat: skip subagent session`); a running runtime also checks the identity on every tick and disposes itself if it ever finds it is on a subagent session. Real-host check: all live runtimes were user root sessions, and scanning teammate child-session logs found 0 heartbeat injections (the `plugin:heartbeat` strings in those logs are tool output / doc content, not injected messages). One caveat that is not the plugin's call: **fork-type** subagents inherit the parent's history, so a heartbeat message already present before the fork is carried into the seed — that's fork semantics; spawn-type subagents are unaffected.
- L3 is **not a sandbox** — it only changes the instruction; irreversible actions are still stopped by host approval.
- Runtime state (`heartbeat-vitals.json`) is process-local with atomic writes and a short debounce; two DSH processes sharing one home are best-effort, not strongly consistent.
- Event-driven beats need `sessionProjections.onChanged`; without it the plugin is timer-only (same gating, just less reactive).
- When the plugin is hot-mounted after sessions are already open, it does one idempotent catch-up attach over existing root agents; sessions opened afterwards go through `agent/created`.
- The plugin depends on the **agent-loop driver surface** `agent.followup` / `agent.inbox` — not part of DSH's public API catalog — and is pinned to DSH 0.2.x; if the host changes the implementation, at worst one beat is dropped with a warning.
- `taskNudge: false` removes both the snapshot and the inspection/ask instruction from beats.
- Zero coupling with dsh-plugin-memory; when both are installed their messages share the same inbox queue and do not conflict.
- **Version requirement**: official DSH 0.2.1-rc.5 series, session format v4; `engines.dsh: "^0.2.1-rc.5"` — see "Version requirements" above.

## License

MIT
