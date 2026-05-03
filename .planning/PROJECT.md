# codex-bridge

## What This Is

`codex-bridge` is a Node 22+ ESM package that exposes a Claude Code plugin/skill surface for delegating implementation, review, monitoring, and closed-loop follow-up work to OpenAI Codex. The current implementation centers on `src/codex-bridge.mjs`, a Codex app-server client/broker runtime under `src/adapters/codex/`, shared state/config/review helpers under `src/lib/`, optional Claude hooks under `hooks/`, and generated installable bundles under `skill/` and `plugin/`.

The v2.0.0 GSD milestone completed on 2026-05-03 and is archived. There is no active implementation milestone at the moment. Current project truth comes from source files, tests, package metadata, manifests, hooks, workflows, generated bundles, and the archived GSD evidence under `.planning/milestones/`.

## Core Value

Claude Code can hand work to Codex and regain reliable, inspectable control through stable commands, events, artifacts, reviews, and merge gates.

## Requirements

### Validated

- ✓ CLI command surface exposes task, follow-up, review, status, result, wait, events, cancel, setup, config, version, update, verdict, and merge-oriented commands through a machine-readable help envelope — existing.
- ✓ Runtime defaults are implemented in source with plan mode, `gpt-5.4`, `xhigh` effort, auto-review enabled, danger-full-access sandbox policy, and configurable turn/pipeline/question budgets — existing.
- ✓ Config loading supports default, installed skill/plugin, workspace-root, and cwd layers with `config show --json` reporting sources — existing.
- ✓ Codex backend capabilities are declared and validated through an adapter registry, with current support limited to the `codex` backend — existing.
- ✓ Codex app-server communication uses newline-delimited JSON messages without a `jsonrpc` request field, shared broker lifecycle, and socket/pipe endpoint helpers — existing.
- ✓ Background jobs, status/result/wait/events/cancel, job state, and session `.events`/`.ndjson` artifacts are implemented and covered by tests — existing.
- ✓ Native review, adversarial review prompt construction, structured review schema handling, and auto-pipeline review/fix/check orchestration are implemented enough for current command usage — existing.
- ✓ Per-task artifact registry, structured briefs, verdict persistence, and gated worktree merge primitives exist for trust-budgeted workflows — existing.
- ✓ Dual generated layouts are produced by `npm run build`: legacy `skill/` and packaged `plugin/` outputs, with CI checking for generated drift — existing.
- ✓ Optional Claude hooks exist for session lifecycle cleanup and stop-time review gate behavior, with project-scoped lock-file activation and plugin-data state handling — existing.
- ✓ Phase 1 added `npm run verify:static`, chaining build, full Node tests, and baseline contract checks — validated in Phase 1.
- ✓ Phase 1 added a machine-readable generated-surface inventory for authored sources that require `skill/` or `plugin/` output updates — validated in Phase 1.
- ✓ Phase 1 added deterministic JSON envelope probes for help, config, version, status, result, wait, events, setup, and error output — validated in Phase 1.
- ✓ Phase 1 added a mutating-command coverage map with success/failure test references and named baseline gaps — validated in Phase 1.
- ✓ Phase 2 routes supported Codex task dispatch, resume, respond, steer, cancel, result, and event operations through the backend adapter lifecycle — validated in Phase 2.
- ✓ Phase 2 exposes setup backend/capability state and keeps backend precedence covered across explicit backend, environment, task metadata, routing, config layers, and defaults — validated in Phase 2.
- ✓ Phase 2 validates foreground task, send/resume, background task, wait, result, events, and unsupported-backend behavior with static tests plus authenticated smoke probes — validated in Phase 2.
- ✓ Phase 3 normalizes native/adversarial review output, persists task-bound `review.json`, records branch-bound verdicts, filters pending verdicts, enforces approved-head merge safety, and implements the closed-loop `iterate` workflow — validated in Phase 3.
- ✓ Phase 3 hardens auto-pipeline review/fix/check proof with explicit stage, budget, partial, missing-item, and fail-closed blank/invalid review or completion handling — validated in Phase 3.
- ✓ Phase 4 keeps the packaged plugin surface internally consistent while explicitly preserving its noncanonical alpha metadata relationship — validated in Phase 4.
- ✓ Phase 4 hardens hook and monitor automation with registered lifecycle hooks, safe Monitor parsing, Stop gate timeout/lock behavior, and spoof-resistance tests — validated in Phase 4.
- ✓ Phase 5 hardens canonical workspace state, append-only replayable session logs, stable per-task artifacts, and structured recovery outcomes — validated in Phase 5.
- ✓ Phase 6 adds source-built release packaging, checksums, CI static gates, update diagnostics, and authenticated runtime smoke covering setup, task, result, events, and adversarial review — validated in Phase 6.

### Active

- [ ] Define fresh v2.x requirements with `$gsd-new-milestone` before planning or executing new implementation phases.
- [ ] Decide whether to promote the packaged plugin from noncanonical alpha to canonical marketplace surface.
- [ ] Harden auto-update safety and installer integrity beyond the current diagnostic/rate-limit guarantees.
- [ ] Add retention/redaction controls for large or sensitive session and registry artifacts.
- [ ] Prepare future non-Codex backend support only after fresh requirements define the compatibility contract.

### Out of Scope

- Non-Codex backend implementation before the `codex` adapter contract is complete — the current loader only ships `codex`, and premature backend claims would create false support.
- Windows production support guarantees — endpoint parsing exists, but broker lifecycle and hooks are primarily exercised on local Unix-like paths.
- Replacing Node built-in tests with a larger framework — the package currently has zero runtime dependencies and a broad `node --test` suite.
- Treating generated bundle files as primary edit targets — source files and build config are the authority for generated output.

## Context

The package is ESM-only and declares Node `>=22.0.0` in `package.json`. It uses `esbuild` to bundle `src/codex-bridge.mjs` and `src/adapters/codex/broker.mjs` into both `skill/` and `plugin/`, and uses `js-yaml` for config loading. The CI workflow runs `npm run verify:static`, generated drift checks, output-existence checks, bundled CLI sanity probes, and the static runtime smoke harness.

The command surface is broad. `help --json` reports commands for task dispatch, send/steer/respond, native and adversarial review, staged iteration, status/result/wait/events/cancel, setup/version/update/config/auth, artifact waiting, verdicts, and merge. `version --json` reports schema version `1.0`, package version `2.0.0`, active backend `codex`, and adapter capabilities such as plan mode, background jobs, auto-pipeline, adversarial review, worktree support, and artifact registry.

State is intentionally split. Project/workspace job state lives under a plugin-data-derived root keyed by canonical workspace root. Session logs live under the configured `session_dir`, defaulting to `~/.codex-bridge/sessions`, with append-only `.events` and `.ndjson` files. Per-task registry artifacts live under `~/.codex-bridge/jobs` unless overridden for tests.

The risk profile is mostly contract drift. Source changes can require generated bundle updates, command/help/schema changes can break plugin surfaces, hook changes can stall Claude shutdown, and app-server protocol changes can invalidate tests that only simulate local behavior. Future work should preserve small, source-first changes followed by `npm run verify:static`; release work should also run `npm run smoke:runtime -- --require-codex --json`.

The v2.0.0 milestone archive is in `.planning/milestones/`. The audit passed with 28/28 requirements satisfied, 6/6 phases verified, and 8/8 cross-phase flows complete. The root-level duplicate audit was removed after confirming it was identical to the archived copy. The current codebase map in `.planning/codebase/` was refreshed on 2026-05-02; future planning should refresh maps again before major v2.x work.

## Constraints

- **Runtime**: Node.js `>=22.0.0`, ESM modules, no CommonJS migration unless package metadata and tests change together.
- **Dependencies**: Keep runtime dependency footprint minimal; current package has dev dependencies only (`esbuild`, `js-yaml`).
- **Generated Artifacts**: Source changes touching CLI, Codex adapter, lib helpers, prompts, schemas, templates, hooks, skill/plugin config, or plugin surfaces must be followed by `npm run build`.
- **Verification**: Standard static gate is `npm run build` plus `npm test`; app-server round trips require an authenticated Codex install and cannot be proven by static tests alone.
- **State Safety**: Preserve synchronous append/write semantics where session, state, registry, and hook code rely on deterministic filesystem behavior.
- **Protocol Safety**: Preserve app-server request shape and method names unless protocol tests and type declarations change with the implementation.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Initialize as brownfield GSD project | The repository already has source, generated bundles, tests, workflows, and release surfaces. | Completed during initialization |
| Treat implementation as source of truth | Existing prose may be stale; user explicitly requested direct exploration and no repository Markdown trust. | Ongoing |
| Use coarse phases with research, plan checks, and verification | The project has high cross-surface contract risk, so fewer larger phases with strong verification are easier to keep coherent. | Ongoing |
| Commit planning docs by default | GSD docs should travel with the project unless the user later opts out. | Ongoing |
| Make baseline contracts executable | Later phases need a gate that fails on contract drift instead of a stale checklist. | Completed in Phase 1 |
| Route supported runtime controls through the adapter | The backend abstraction must be real before adding review-loop or plugin hardening on top of it. | Completed in Phase 2 |
| Bind review verdicts to task artifacts and branch heads | Review, verdict, merge, and iterate must share the same reviewed tree to avoid approving unreviewed work. | Completed in Phase 3 |
| Keep auto-pipeline incomplete rather than optimistic on ambiguous review/check output | Blank native reviews and malformed completion checks should preserve artifacts and request attention instead of reporting success. | Completed in Phase 3 |
| Keep packaged plugin alpha status explicit until promotion is deliberate | The root package is canonical while `plugin/` stays a noncanonical alpha surface with tested metadata. | Completed in Phase 4 |
| Anchor state and sessions to canonical workspace roots | Multi-process and worktree flows need stable state/session lookup regardless of launcher cwd. | Completed in Phase 5 |
| Require live runtime smoke before release completion | Static tests cannot prove app-server setup/task/review/events behavior. | Completed in Phase 6 |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition**:
1. Requirements invalidated? Move to Out of Scope with reason.
2. Requirements validated? Move to Validated with phase reference.
3. New requirements emerged? Add to Active.
4. Decisions to log? Add to Key Decisions.
5. "What This Is" still accurate? Update if drifted.

**After each milestone**:
1. Full review of all sections.
2. Core Value check: still the right priority?
3. Audit Out of Scope: reasons still valid?
4. Update Context with current state.

---
*Last updated: 2026-05-03 after v2.0.0 milestone completion*
