# Phase 5 Context: State Artifact And Recovery Resilience

## Scope

Phase 5 hardens the bridge surfaces that operators depend on after work has already started: workspace state, session logs, registry artifacts, and recovery outcomes. The phase is intentionally source-first; current source, tests, package scripts, generated-output rules, and hook/plugin manifests are the authority.

## Source Evidence

- `src/lib/state.mjs` already keys workspace state through canonical workspace roots, uses a `state.lock`, atomic state writes, stale-lock recovery, corrupt-state quarantine, raw job listing, and orphan reaping.
- `src/lib/session-log.mjs` owns append-only `.events` and `.ndjson` files, plus session diff/plan/review artifacts.
- `src/lib/registry.mjs` owns per-task `meta.json`, `review.json`, `verdict.json`, and `events.jsonl` artifacts.
- `src/codex-bridge.mjs` wires task/review/send/respond/wait/events/cancel/status/await-artifact command behavior.
- `test/state.test.mjs`, `test/state-stale-lock-toctou.test.mjs`, `test/session-log.test.mjs`, `test/registry.test.mjs`, and `test/bridge-static.test.mjs` are the relevant deterministic gates.

## Key Risks

- Relative `session_dir` values can drift if resolved against transient process cwd instead of the canonical workspace root.
- Registry consumers need stable brief/diff/event artifacts, not only session-local files.
- Failure paths need machine-readable recovery guidance instead of only prose or exit codes.
- Corrupt log lines should not make replay impossible; replay readers should preserve corrupt records as data.

## Plan Set

- `05-01`: Workspace state concurrency and canonical root proof.
- `05-02`: Session log replay and registry artifact contracts.
- `05-03`: Cancel, prune, stale-lock, corrupt-state, and missing-artifact recovery.
