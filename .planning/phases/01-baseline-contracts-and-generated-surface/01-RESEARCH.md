# Phase 1: Baseline Contracts And Generated Surface - Research

## Summary

Phase 1 should add a small source-controlled contract gate instead of another prose document. The project already has `npm run build` and `npm test`; what was missing was a single maintainer command that chains them and verifies the baseline contracts all later phases depend on: generated output inventory, JSON envelope probes, and mutating-command coverage traceability.

## Source Evidence

- `package.json` originally exposed `build`, `dev`, and `test`, but no single static gate.
- `esbuild.config.mjs` bundles `src/codex-bridge.mjs` and `src/adapters/codex/broker.mjs` into both `skill/` and `plugin/`, copies prompts/schemas/templates into both layouts, copies `skill/config.yaml` into `plugin/config.yaml`, and copies `hooks/` into `plugin/hooks/` with plugin path transforms.
- `src/codex-bridge.mjs` centralizes commands in `COMMANDS` and `SUBCOMMAND_DISPATCH`.
- `src/lib/cli-errors.mjs` owns the uniform success/error JSON envelope.
- Existing tests cover many slices, but no single test asserted the Phase 1 envelope set across help, config, version, status, result, wait, events, setup, and error.

## Generated Surface Inventory

The inventory should include:

| Source | Generated outputs | Verification approach |
|--------|-------------------|-----------------------|
| `src/codex-bridge.mjs` | `skill/scripts/codex-bridge.mjs`, `plugin/scripts/codex-bridge.mjs` | Fresh `npm run build`; bundle output tracked by git drift |
| `src/adapters/codex/broker.mjs` | `skill/app-server-broker.mjs`, `plugin/scripts/app-server-broker.mjs` | Fresh `npm run build`; bundle output tracked by git drift |
| `src/prompts/adversarial-review.md` | `skill/prompts/adversarial-review.md`, `plugin/prompts/adversarial-review.md` | Byte-for-byte static copy check |
| `src/schemas/review-output.schema.json` | `skill/schemas/review-output.schema.json`, `plugin/schemas/review-output.schema.json` | Byte-for-byte static copy check |
| `src/templates/execute-instructions.md` | `skill/templates/execute-instructions.md`, `plugin/templates/execute-instructions.md` | Byte-for-byte static copy check |
| `src/templates/plan-enforcement.md` | `skill/templates/plan-enforcement.md`, `plugin/templates/plan-enforcement.md` | Byte-for-byte static copy check |
| `skill/config.yaml` | `plugin/config.yaml` | Byte-for-byte static copy check |
| `hooks/` | `plugin/hooks/` | Copy check after plugin path transforms |

## JSON Envelope Probe Plan

The static probe set should assert:

- `help --json` returns command inventory under the success envelope.
- `config show --json` returns config sources, effective config, and precedence order.
- `version --json` returns package version, active backend, and adapter capabilities.
- `setup --json` returns readiness and review-gate state without requiring real Codex in the static fixture.
- `status --json` returns workspace-root and job snapshot data.
- `result <job-id> --json` returns job and stored job data.
- `wait <job-id> --json` returns terminal event metadata.
- `events <job-id> --json` returns event stream metadata without leaking raw event text into JSON mode.
- Unknown subcommand with `--json` returns a structured error envelope.

## Mutating Command Coverage Map

Commands that mutate state, registry, workspace, hooks, or external installer behavior are:

`setup`, `update`, `review`, `adversarial-review`, `task`, `task-worker`, `send`, `steer`, `respond`, `status` in prune/cleanup modes, `cancel`, `verdict`, `merge`, and `iterate`.

The baseline map should list success and failure test files for each. When static tests cannot prove a live app-server round trip, the map should name the gap explicitly instead of claiming false coverage.

## Risks/Gaps

- Static tests do not prove authenticated Codex app-server behavior. Phase 6 must own live setup/task/review/events smoke.
- `iterate` is intentionally staged today; Phase 3 must replace the baseline gap with real orchestration tests.
- `send`, `steer`, and `respond` are backend-dependent runtime paths; static tests should verify envelope/contract shape and leave live support proof to smoke tests.
- Bundle outputs include inlined `package.json` data, so package script changes cause generated CLI diffs.

## Recommended Verification

Run:

```bash
npm run verify:static
```

Expected result:

- Build succeeds for both `skill/` and `plugin/` layouts.
- Full `node --test test/*.test.mjs` suite passes.
- `npm run baseline:contracts -- --check` prints `Baseline contracts: OK`.

## RESEARCH COMPLETE
