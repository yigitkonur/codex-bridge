# Phase 6 Verification

## Requirement Audit

| Requirement | Status | Evidence |
|---|---:|---|
| REL-01: CI rejects stale generated bundles and missing packaged outputs | Complete | `.github/workflows/build.yml` runs `npm run verify:static`, generated-drift checks, packaged-output checks, and static runtime-smoke harness; `test/release-readiness.test.mjs` pins workflow behavior. |
| REL-02: Release packaging builds from source and attaches checksummed artifacts | Complete | `scripts/package-release.mjs`, `npm run release:package`, `.github/workflows/release.yml`, archive/checksum/release-note tests. |
| REL-03: Authenticated runtime smoke covers setup, task, review, and event streaming | Complete | `scripts/runtime-smoke.mjs`; local live run passed with `codex-cli 0.125.0` for setup, foreground task, result, events, and adversarial review. |
| REL-04: Update checks and auto-apply paths are rate-limited, non-blocking, and diagnostic | Complete | Existing `src/lib/update-check.mjs` and `src/codex-bridge.mjs` diagnostics retained; `test/update-command.test.mjs`, `test/auto-apply.test.mjs`, and full static gate passed. |

## Validation

- Targeted release tests: `node --test test/release-readiness.test.mjs test/update-command.test.mjs test/auto-apply.test.mjs` passed with 8/8 tests.
- Live runtime smoke: `npm run smoke:runtime -- --require-codex --json` passed with `codex-cli 0.125.0`; probes covered source/skill/plugin CLI envelopes, setup, foreground task, result, events, and adversarial review.
- Full static gate: `npm run verify:static` passed with 354 tests / 353 passed / 1 skipped and `Baseline contracts: OK`.
- Diff whitespace: `git diff --check` passed.

## Notes

- CI static smoke uses `--static-only` so public CI does not require an authenticated Codex install.
- Release-time live proof uses `--require-codex` so missing Codex or app-server support fails instead of silently skipping.
