---
plan: 06-03
phase: 06-release-readiness-and-runtime-smoke
status: complete
completed: 2026-05-03
requirements:
  - REL-03
  - REL-04
---

# 06-03 Summary

## Delivered

- Added `scripts/runtime-smoke.mjs` with static-only, optional live, and `--require-codex` fail-closed modes.
- Added `npm run smoke:runtime`.
- Live smoke creates an isolated git workspace and probes setup, foreground task, result, events, and adversarial review.
- Retained and revalidated update-command and auto-apply diagnostic coverage.

## Validation

- `node --test test/release-readiness.test.mjs test/update-command.test.mjs test/auto-apply.test.mjs` passed with 8/8 tests.
- `npm run smoke:runtime -- --require-codex --json` passed against `codex-cli 0.125.0`.
- `npm run verify:static` passed with 354 tests / 353 passed / 1 skipped and baseline contracts OK.
- `git diff --check` passed.

