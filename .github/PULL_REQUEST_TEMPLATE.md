## Summary

<!-- What does this PR change, and why? One paragraph is enough. Link the
issue it fixes (`Fixes #123`) when there is one. -->

## Type of change

- [ ] Bug fix
- [ ] New feature / behaviour change
- [ ] Prompt / wording change
- [ ] Documentation
- [ ] Tests only
- [ ] Chore / refactor (no behaviour change)

## Changes

<!-- Bullet list of the meaningful changes. Mention new or changed config keys,
routes, persisted-state fields and prompt templates explicitly. -->

-
-

## Test evidence

<!-- Paste the exact output counts, not just "tests pass".
`node --test` → all pass; the suite is at 172 tests on main today.
For a UI change, also attach a screenshot from a running DSH
(Settings → Heartbeat) — see CONTRIBUTING.md for the client-test caveat. -->

```text
$ node --test
ℹ tests ...   ℹ pass ...   ℹ fail 0
```

- [ ] New/updated tests cover the behaviour change (existing assertions were not weakened)
- [ ] `npm pack --dry-run` still contains the expected files
- [ ] Larger changes verified against a real DSH 0.2.1-rc.5 host

## Impact and compatibility

<!-- Host version, session format, config migration, L3 / approval behaviour.
Write "none" when the change is invisible to users. -->

- Host / session-format impact:
- Config or persisted-state migration:
- L3 / approval boundary impact:

## Documentation

- [ ] README / README.zh.md updated when user-visible behaviour changed
- [ ] CHANGELOG entry left to the maintainer during release (do not bump the version here)

## Checklist

- [ ] I did not edit `package.json` version or publish anything
- [ ] No secrets, tokens or private conversation content in the diff
- [ ] The change is limited to the plugin boundary (no cross-plugin imports, no host edits)
