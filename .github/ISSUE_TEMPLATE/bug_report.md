---
name: Bug report
about: Something is broken or behaves unexpectedly
title: '[bug] '
labels: bug
---

## What happened

<!-- A clear and concise description of the bug. -->

## Steps to reproduce

1.
2.
3.

## Expected behaviour

<!-- What you expected to happen instead. -->

## Actual behaviour

<!-- What actually happened. If the heartbeat stayed silent or injected
something unexpected, say which level / reason you saw. -->

## Environment

- **DSH version**: <!-- e.g. DSH Desktop 0.2.1-rc.5, or `dsh --version` -->
- **dist/dsh-plugin-heartbeat version**: <!-- npm version, or the git commit when running from a checkout -->
- **OS**: <!-- e.g. macOS 15.1 (arm64), Ubuntu 24.04, Windows 11 -->
- **Node.js version**: <!-- `node --version`, only relevant for running the tests/CLI directly -->
- **Install method**: <!-- `dsh plugin --profile <profile> add dsh-plugin-heartbeat` / dsh-market / `link:` to a checkout -->

## Relevant configuration

<!-- Redact anything private. `GET /api/heartbeat/config` (Settings → Heartbeat)
or the relevant keys from `<dshHome>/heartbeat.json`. -->

```json
```

## Logs / screenshots

<!-- Paste the relevant lines from the DSH log, or attach a screenshot.
The last few rows of `heartbeat-vitals.json` and `GET /api/heartbeat/status`
are usually the most useful. Never paste API keys or private conversation
content. -->

```text
```

## Additional context

<!-- Anything else that might matter: other installed plugins, whether a
dsh-plugin-memory message was delivered around the same time, whether the
session was resumed / hot-mounted, etc. -->
