# v2.2 Verification

**Status:** Complete
**Date:** 2026-05-03

## Coverage

| Area | Status | Evidence |
|---|---|---|
| Monitor/artifact ergonomics | Complete | Task aliases, `wait --any`, heartbeat previews |
| Config diagnostics | Complete | Layered diagnostics in `config show --json` |
| Update safety metadata | Complete | Structured `update_check` and `apply` payloads |
| Retention/redaction controls | Complete | Cleanup retention flags and opt-in secret redaction |
| Generated surfaces | Complete | `npm run build` regenerated skill/plugin bundles |
| Full static validation | Complete | `npm run verify:static` passed with 365 tests / 364 passed / 1 skipped and baseline contracts OK |
| Runtime smoke | Complete | `npm run smoke:runtime -- --require-codex --json` passed against `codex-cli 0.128.0` |

## Notes

Live CLI runtime smoke passed locally. A manual Claude Code UI/plugin session
is still useful before a tagged release because hook invocation is
environment-dependent.
