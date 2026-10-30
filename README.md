# dsh-plugin-heartbeat

**English** ｜ [中文](README.zh.md)

<p align="center">
  <a href="https://github.com/LittleBlackTong/dsh-plugin-heartbeat"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-LittleBlackTong%2Fdsh--plugin--heartbeat-blue?logo=github"></a>
  <a href="https://www.npmjs.com/package/dsh-plugin-heartbeat"><img alt="npm" src="https://img.shields.io/npm/v/dsh-plugin-heartbeat?logo=npm"></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D18-green">
</p>

> A heartbeat plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): wakes the agent on a configurable interval so it proactively reports progress, risks, and blockers — and, before each beat, inspects the session's own todos, team board and goal so it can ask whether to act — or just checks in.

A Cordis plugin for DeepSeek Harness: put a timed alarm on your agent so it **proactively** speaks up — progress, risks, blockers, or just a casual check-in. Since v0.5.0 every beat also runs a **task inspection**: it reads the session's todos, team board and goal, folds them into a compact snapshot, and lets the agent ask whether you want it to act. In the spirit of OpenClaw's heartbeat mode.

## How it works

- Host-plane Cordis plugin: listens for `agent/created` and attaches an independent timer to every **root agent** (subagents are skipped).
- **Hot-mount catch-up (v0.5.0)**: when the plugin is mounted/reloaded while sessions are already live (`dsh plugin add`, market install, profile live reload all do this), `agent/created` alone would never see those sessions. So `apply()` also does one **idempotent catch-up attach** over `ctx.agents.roots()`; existing sessions start beating too (subagents still skipped).
- Each beat injects a synthetic user message through `agent.followup()` (session format v4 producer-owned kind: `source.kind === 'plugin:heartbeat'`):
  - **agent idle** → a fresh turn opens immediately, so it speaks up on its own;
  - **agent busy** → the message parks and is claimed the moment the current turn ends — **no interruption, nothing lost**;
  - several busy ticks → only one pending message is kept (`inbox.replace` in place, no backlog).
- **Backoff (v0.4.0)**: 10 minutes initially; 20 then 30 while nobody answers (`[base, 2×base, 3×base]`, overridable with `backoffSeconds`). The longer the silence, the rarer the noise.
- **Hard stop (v0.4.0, token guard)**: after `pauseAfterMissed` (default 3) beats with no human reply the timer is **torn down completely** — nothing is ever delivered again; only your next message revives it, restarting from the initial 10-minute tier. Every real message resets the phase, so heartbeats only speak in genuine silence.
- **Light wake-up (v0.4.0)**: before delivery the plugin asks the host compaction service to fold long history into a checkpoint summary (`compactBeforeBeat`, on by default; a failure never blocks delivery), and the injected instruction says "no tools, no history replay, ≤5 sentences" — each beat costs as little context as possible.
- **Hourly cap (optional)**: `maxBeatsPerHour` (default 0 = off) caps beats in any 60-minute window, against the "sporadic replies keep resetting backoff" worst case.
- **Task inspection (v0.5.0)**: before each beat it reads the session projections (todos / team board / goal), folds open items into a snapshot, and instructs the agent to **ask only, never start work**. See the next section.
- Injected messages render as a collapsed context chip in the transcript, not a full user bubble.

## Task inspection (v0.5.0)

A heartbeat no longer has to guess from "the last conversation". Before each beat the plugin synchronously reads the host's **session projections** (`ctx.sessionProjections`) and folds the result into a compact snapshot injected with the beat:

| Projection | What it reads | What enters the snapshot |
|---|---|---|
| `todos` | session todo list (`content` / `status`) | only `in_progress` / `pending`; `completed` dropped |
| `agentTeam` | Agent Team board (`subject` / `status` / `blockedBy`) | open items only, sorted "ready → in progress → blocked"; blockers are named |
| `goal` | persistent goal (`objective` / `phase`) | only `active` / `paused` / `blocked` phases |

Two things to know before reading that table:

- the `agentTeam` projection is **only registered when the Agent Team optional package is enabled**; without it the read degrades automatically — no error, and no team section in the snapshot;
- the `todos` projection **resets at the start of every turn**: a beat sees the todos of the most recent turn, not a session-wide long-term list — don't treat it as a persistent TODO store.

After the snapshot comes one instruction: if something is "worth doing but nobody has called it", use the `ask_user_question` tool (or just ask in the reply) to ask the user "want me to do it now?" — at most 3 suggestions, one sentence each; **ask, never start work**.

Robustness:

- no `sessionProjections` service, no session binding, or a throwing projection → **degrades to a hint** and the beat is still delivered; a failed task inspection never drops a beat.
- the task block (snapshot + ask instruction) is hard-capped at **800 characters**; `taskNudgeMaxItems` caps items per bucket (default 5, range 1–20) — the inspection is a garnish, not a burden.
- the plugin **only reads** projections: it never edits your todos, team board or goal; real changes still go through the normal tooling.
- a custom `prompt` without the `{{tasks}}` placeholder gets the task block appended at the end (v0.4.x custom prompts keep working).

Settings (toggle in the **Heartbeat** section):

| Key | Default | Meaning |
|---|---|---|
| `taskNudge` | `true` | whether to run task inspection; when off, no snapshot and no inspection / ask instruction |
| `taskNudgeMaxItems` | `5` | max items per bucket in the snapshot (1–20) |

Turning `taskNudge` off doesn't disable the heartbeat: the message degrades to the generic "report progress / ask / small talk" prompt, shorter than the inspection version.

## Install

```sh
dsh plugin --profile <profile> add dsh-plugin-heartbeat
```

(The package declares a `dsh.bundle` manifest, so `dsh plugin add` mounts it into the profile's bundles layer automatically; one-click install in dsh-market uses the same path.)

Restart DSH. Then use **Settings → Heartbeat** to change the interval, switch, pause threshold and task inspection at any time; saving applies hot (no restart).

> ⚠️ **Don't** hand-write `- insert: {id: dsh-heartbeat, ...}` into the profile's `cordis.patch.yml`: it collides with the bundle manifest's automatic mount and the whole profile fails to start with
> `duplicate loader entry id "dsh-heartbeat"` (real incident on 2026-08-18, colliding with the memory plugin's entry). Runtime config lives in `<dshHome>/heartbeat.json`; override composition keys (such as `prompt`) with an **id-only override entry, no insert** — see below.

## Settings sidebar icon

The settings sidebar entry carries a **stroked heart** mark: a 16×16 grid, `stroke-width: 1.3` (the shared `ICON_MEDIUM_STROKE`), pure-black alpha painted through `mask-image` so the visible color follows `currentColor` in both light and dark themes. It matches the dsh-plugin-memory icon spec exactly. The official `settings.section` slot projects only id / order / label — there is no icon field — so the plugin claims its own nav row by exact label text, mirrors it with a `MutationObserver` (re-claimed after a language switch or remount) and cleans everything up on dispose.

## Version requirements

- **DSH: official 0.2.1-rc.5 series.** `package.json` declares `engines.dsh: "^0.2.1-rc.5"`; the host gates with semver (`includePrerelease: true`), so mind prerelease semantics: `^0.2.1` / `>=0.2.0` **do not match** `0.2.1-rc.5`; only `^0.2.1-rc.5` does. It also covers the eventual 0.2.1 stable, while `0.3.0-rc.1` is judged incompatible.
- **session format v4** (official 0.1.7+). The heartbeat source uses the producer-owned kind `plugin:heartbeat`; v4's native admission rejects the v3 `{kind:'plugin', plugin:'heartbeat'}` wrapper with `format v4 message requires a producer-owned source kind` (wrapped as `code: "UNKNOWN"`, shown as `... source kind UNKNOWN` — `UNKNOWN` is the error code, not a kind). The v4 and v3 allowlists are mutually exclusive.
- **0.4.2 is the last v3-compatible version**; **from 0.5.0 the plugin supports only the official DSH 0.2.1-rc.5 series** (session format v4 + the host APIs verified offline). Older 0.2.x without `sessionProjections` degrades automatically but is not verified version by version; 0.3.x is not supported yet.
- **Verified on a real host** (DSH Desktop 0.2.1-rc.5, live): **heartbeat delivery + task snapshot injection** work — in a real session both `todos` and the Agent Team board were injected with correct `ready` / `blockedBy`, source `plugin:heartbeat` passed v4 admission, and the settings panel `GET/POST /api/heartbeat/config` was exercised live and applied hot. Note: the pre-beat compaction path is covered by unit tests only and was not separately observed on a live host.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch (user layer lives in `<dshHome>/heartbeat.json`) |
| `intervalSeconds` | `600` | initial beat period (clamped to 30–86400 s); later backoff tiers are ×2 / ×3 |
| `pauseAfterMissed` | `3` | hard-stop threshold: after N beats with no human reply the timer is torn down; your next message revives it and restarts from the initial tier. `0` = off |
| `taskNudge` | `true` | task inspection: read the session's todos / team board / goal each beat and inject the snapshot + ask instruction; both disappear when off (user-layer configurable) |
| `taskNudgeMaxItems` | `5` | per-bucket item cap in the task snapshot, 1–20 (user-layer configurable) |
| `backoffSeconds` | unset | explicit backoff tier array (e.g. `[600, 900, 1800]`, composition only) |
| `compactBeforeBeat` | `true` | fold history into a checkpoint summary before delivery (composition only; skipped when no compaction service) |
| `maxBeatsPerHour` | `0` | beat cap per 60-minute sliding window (`0` = off, composition only) |
| `prompt` | built-in | instruction template delivered on each beat; `{{time}}` → current time, `{{tasks}}` → task snapshot (composition only) |
| `configFile` | `<dshHome>/heartbeat.json` | user config path (`enabled` / `intervalSeconds` / `pauseAfterMissed` / `taskNudge` / `taskNudgeMaxItems`) |

Custom heartbeat prompt (composition config, **no `insert`**, to avoid duplicating the bundle layer):

```yaml
- id: dsh-heartbeat
  config:
    prompt: |
      【Heartbeat】the current time is {{time}}. Take a look at the recent
      conversation and the todos: report progress if any, risks if any;
      otherwise a single line. 5 sentences at most.
```

To place the task block exactly where you want it, put `{{tasks}}` in your custom prompt; omit it and the block is appended at the end while `taskNudge` is on.

> Why not the generic settings namespace? DSH's settings wire serves only a hard-coded allowlist (`WEB_SETTINGS_NAMESPACES`); a plugin cannot expose its own namespace to the browser for writes. This plugin therefore hosts `GET/POST /api/heartbeat/config` in the host process; the **Heartbeat** section in Settings talks to that route directly, and writes apply hot.

## Development

```sh
node --test
```

No-arg `node --test` discovers `test/*.test.mjs` (`runtime.test.mjs` + `tasks.test.mjs` + `settings-nav-icon.test.mjs` + `client-half.test.mjs`) — 74 tests at the moment.

## Known limits

- The heartbeat only exists while the DSH process is alive (it stops when the app quits).
- Each session (root agent) has its own timer; subagents never get a heartbeat.
- When the plugin is hot-mounted/reloaded after sessions are already open, it does one idempotent catch-up attach over existing root agents (no double timers); sessions opened afterwards still go through `agent/created`.
- The heartbeat **does not interrupt** running work; it speaks up as soon as the current turn ends.
- The heartbeat is a "report", not a "new task": the default prompt tells it not to start work on its own.
- Task inspection also only asks: actually doing the items still needs your go-ahead in the beat's question.
- `taskNudge: false` is a full switch: no task snapshot and no inspection / ask instruction in the beat — only the generic report prompt remains.
- The task snapshot comes from host session projections and is a **read-only** live view; hosts without that service (older DSH) degrade to a prompt-only heartbeat instead of erroring.
- One already-queued beat (while the agent was busy) is consumed when the current turn ends — there is never a new beat after that hard stop.
- Zero coupling with dsh-plugin-memory; when both are installed, their messages queue in the same inbox and do not conflict.
- The plugin depends on the **agent-loop driver surface** `agent.followup` / `agent.inbox` — not part of DSH's public API catalog — and is pinned to DSH 0.2.x; if the host changes the implementation, at worst one beat is dropped with a warning instead of throwing from the timer.
- **Version requirement**: official DSH 0.2.1-rc.5 series, session format v4; `package.json` declares `engines.dsh: "^0.2.1-rc.5"` — see "Version requirements" above.

## License

MIT
