# Security Policy

## Supported versions

Security fixes are applied to the latest published minor line. Older versions may
not receive fixes; please upgrade before reporting.

| Version | Supported |
| --- | --- |
| 0.7.x (latest) | ✅ |
| < 0.7 | ❌ |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

- Preferred: open a private report via GitHub Security Advisories —
  <https://github.com/LittleBlackTong/dsh-plugin-heartbeat/security/advisories/new>
- Alternative email: `security@example.com`
  <!-- Placeholder: replace with a real maintainer address before publicising this file. -->

Useful details: the plugin version (npm version or git commit), DSH version, OS,
the relevant config (redacted), reproduction steps and the potential impact.
We aim to acknowledge a report within 7 days and to coordinate disclosure after
a fix ships.

## Data and privacy

The plugin is local-first. It has **no telemetry and makes no third-party network
requests**. Everything it does happens inside the DSH process on your machine.

Files it writes:

| Path | Content |
| --- | --- |
| `<dshHome>/heartbeat.json` (default `~/.dsh/heartbeat.json`) | user configuration |
| `<dshHome>/heartbeat-vitals.json` | runtime state: pulse history/levels, dedupe ledger, timestamps, daily budget |
| `<dshHome>/proactive-cooldown.json` | shared speech-right lock with `dsh-plugin-memory` (only `version`, `speaker`, `at`) |

It also reads session projections (todos / team board / goal / child-agent
catalog) from the live session and keeps them in memory only. Injected heartbeat
messages become part of the prompts sent to **your configured model provider** —
that provider relationship is governed by DSH and the provider's policy, not by
this plugin.

The browser half (`lib/client.js`) only calls the plugin's own loopback routes on
the DSH web server (`/api/heartbeat/config`, `/api/heartbeat/status`,
`/api/heartbeat/control`). It loads no remote assets.

## Permission and sandbox boundary

- The plugin runs **in-process inside the DSH host** with the host's privileges.
  It is a plugin, not a sandbox.
- **L3 grants (`l3Allow`) are instruction-level only.** They change what the
  heartbeat prompt tells the model it may do without asking first. They are *not*
  a sandbox, do not bypass host approvals, and irreversible/dangerous tool calls
  are still stopped by the host's approval layer. Keep grants narrow.
- Heartbeat delivery uses the agent-loop driver surface (`agent.followup` /
  `agent.inbox`). Any signature change there is a compatibility risk, not a
  security feature; verify against your DSH version before deploying.
- Treat `<dshHome>/heartbeat*.json` as sensitive: they can reveal session ids,
  working directories and usage patterns. Don't commit them or paste them
  unredacted into issues.

## Scope

In scope: vulnerabilities in this plugin's code (path handling, config parsing,
lock-file handling, unintended data exposure, prompt/injection issues caused by
the plugin's own text).

Out of scope: vulnerabilities in DSH itself or in the model providers (report
those upstream), and risks arising from a user deliberately granting broad L3
permissions or installing untrusted third-party plugins alongside this one.

## Dependency posture

Runtime code depends only on `node:*` builtins and host-provided peer packages
(`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`); there are no bundled
third-party runtime dependencies. The test suite has no runtime dependency
beyond those peers.
