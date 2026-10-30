# Contributing to dsh-plugin-heartbeat

Thanks for helping make DeepSeek Harness agents feel more alive. This is a small,
zero-build plugin, so contributing is mostly about **tests and careful host-contract
work** rather than tooling.

## Ground rules

- **Zero build**: `lib/` is the runtime code exactly as shipped — plain ESM, no
  bundler, no TypeScript step. `lib/client.js` runs unbundled in the DSH web
  client. Don't add a build step, don't add a generated `dist/`.
- **Plugin boundary**: this plugin is a pure Cordis plugin. It must never import
  from other plugins (including `dsh-plugin-memory`). Cross-plugin coordination
  happens only through the documented shared JSON file
  (`<dshHome>/proactive-cooldown.json`) implemented independently on each side.
- **No new runtime dependencies**: runtime code may use `node:*` builtins and the
  host-provided peer packages (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`).
  Adding a dependency changes `package.json` and needs maintainer sign-off.
- **Fail soft**: a bad pulse, bad config file or missing host service must log a
  warning and continue. Never throw out of a timer, route or event listener.
- **Host contract is not public API**: `agent.followup` / `agent.inbox` /
  `sessionProjections` are driver surfaces. Touching them means re-verifying the
  guards (subagent sessions, child-active silence, projection wire views).

## Requirements

- Node.js **18+** locally; CI runs the suite on Node **20** and **22**.
- Git, and ideally a DSH Desktop **0.2.1-rc.5** installation for manual checks.
- No lockfile is committed on purpose (peer-only dependencies); just
  `npm install` in the checkout.

## Local development

```sh
git clone https://github.com/LittleBlackTong/dsh-plugin-heartbeat.git
cd dsh-plugin-heartbeat
npm install                 # peer packages used by the tests
node --test                 # full suite; 172 tests on main today
npm pack --dry-run          # inspect the exact npm package contents
```

No-arg `node --test` discovers `test/*.test.mjs`. Useful focused runs:

```sh
node --test test/runtime.test.mjs
node --test test/wiring-v06.test.mjs test/proactive-lock.test.mjs
```

`node scripts/rehearse.mjs` is a maintainer pre-flight that loads the plugin
**as the profile loads it** (from a linked profile, with a hard-coded profile
path at the top of the script) and drives one heartbeat tick through a fake
agent. Adjust the path for your machine; it is not part of CI.

## Test requirements

- **TDD is the house style**: add or extend a `test/*.test.mjs` case first, watch
  it fail for the right reason, then implement. A behaviour change without a
  test is not ready.
- **The whole suite must be green** — CI runs `node --test` on Node 20 and 22.
- **Do not weaken existing assertions.** The suite pins hard-won regressions:
  subagent sessions are never attached, child-active work keeps pulses silent,
  projections are read through the wire view, pending beats are replaced in
  place, and the L0/L1/L2/L4 gate semantics. Deleting or loosening one of those
  assertions needs a maintainer-approved reason in the PR.
- Prefer the existing test doubles: fake agents/inboxes, injected clocks
  (`now`), injected sensors/gate/lock, and `t.mock.timers` instead of real
  sleeps. The suite must stay fast and deterministic.
- New user-facing config keys need: a default in `lib/schema.js`, persistence
  coverage in `test/config-store-v2.test.mjs` (including v1→v2 migration when
  relevant), and the composition `Config` schema in `lib/index.js`.

### Client UI testing: the honest status

`lib/client.js` (the settings panel / header pill half) is covered by
**contract and static tests only** — tests load the client module in a `vm` with
a fake `window.__ModuleLoader__`/DOM and assert registration, slot declarations,
locale dictionaries and rendering functions. **There are no real DOM,
render-snapshot or browser tests.** Any UI change therefore needs manual
verification in a running DSH (Settings → Heartbeat; the conversation header
while a child subagent runs) and a screenshot in the PR. Treat this gap as a
known limitation, not as something a unit test proves.

## Manual testing against a real host (optional but recommended)

1. Clone the repo somewhere stable.
2. In a DSH profile directory (e.g. `~/.dsh/profiles/desktop`), add the checkout
   as a link dependency and to the profile's bundle list in `package.json`:

   ```jsonc
   {
     "dependencies": {
       "dsh-plugin-heartbeat": "link:/absolute/path/to/dsh-plugin-heartbeat"
     },
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "dsh-plugin-heartbeat"]
       }
     }
   }
   ```

3. Run `npm install` inside the profile directory, then restart DSH (a profile
   with `patchReload: live` also picks up bundle-patch edits live).
4. Use **Settings → Heartbeat** to tune the config; `GET /api/heartbeat/status`
   and `GET /api/heartbeat/config` show the live state.
5. **Do not** hand-write an `insert:` entry for this plugin into the profile's
   `cordis.patch.yml`: the package's `dsh.bundle` manifest already mounts it and
   a duplicate id crashes profile startup (`duplicate loader entry id`).

## Commit and PR style

- Small, focused PRs: one logical change per PR.
- Commit subjects follow the history style: `feat: …`, `fix: …`, `docs: …`,
  `test: …`, `chore: …`. Include the version only in release commits
  (maintainers do those).
- Fill in the PR template, including the exact `node --test` counts and a
  screenshot for UI changes.
- **Do not** bump `package.json` version, do not edit `CHANGELOG.md`, and do not
  run `npm publish` — releases are maintainer-run. Docs (`README.md` /
  `README.zh.md`) should be updated together, in both languages, when
  user-visible behaviour changes.
- Read the design notes under `docs/specs/` and `docs/plans/` before changing the
  autonomy layer (sensors → rhythm → gate → delivery → vitals).

## Releasing (maintainers only)

1. Merge the release PR after green CI.
2. Update `package.json`, `CHANGELOG.md`, README(s); commit the version bump.
3. `git push` (no tags) and `npm publish`; verify the published tarball.
4. No separate release branch is needed; `npm` is the distribution channel.

Questions: open an issue, or mention the maintainer in the PR.
