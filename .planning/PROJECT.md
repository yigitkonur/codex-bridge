# codex-bridge

## What This Is

`codex-bridge` is a Node 22+ ESM package that exposes a Claude Code plugin/skill surface for delegating implementation, review, monitoring, and closed-loop follow-up work to OpenAI Codex. The current implementation centers on `src/codex-bridge.mjs`, a Codex app-server client/broker runtime under `src/adapters/codex/`, shared state/config/review helpers under `src/lib/`, optional Claude hooks under `hooks/`, and generated installable bundles under `skill/` and `plugin/`.

This GSD initialization is for a brownfield project. Current project truth comes from source files, tests, package metadata, manifests, hooks, and CI workflows; repository Markdown is not trusted unless a future phase verifies it against implementation.

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

### Active

- [ ] Close the backend-adapter abstraction gap so runtime command dispatch, streaming, result, and cancellation no longer depend on direct Codex-only paths where the adapter contract advertises a future seam.
- [ ] Finish the closed-loop iterate/reviewer/verdict workflow so task -> review -> verdict -> fix/merge can run end to end instead of returning staged manual instructions.
- [ ] Promote the packaged plugin surface from alpha/scaffold status to a canonical, internally consistent v2 install surface, or explicitly keep it noncanonical with tests and metadata aligned.
- [ ] Harden hook and monitor automation around real Claude plugin boundaries, including spoof-resistant monitor arming, Stop hook timeouts, and session/subagent wake-up paths.
- [ ] Add authenticated runtime smoke coverage for app-server round trips that static Node tests cannot prove.
- [ ] Keep generated skill/plugin artifacts, package metadata, and release packaging synchronized after every source or surface change.

### Out of Scope

- Non-Codex backend implementation before the `codex` adapter contract is complete — the current loader only ships `codex`, and premature backend claims would create false support.
- Windows production support guarantees — endpoint parsing exists, but broker lifecycle and hooks are primarily exercised on local Unix-like paths.
- Replacing Node built-in tests with a larger framework — the package currently has zero runtime dependencies and a broad `node --test` suite.
- Treating generated bundle files as primary edit targets — source files and build config are the authority for generated output.

## Context

The package is ESM-only and declares Node `>=22.0.0` in `package.json`. It uses `esbuild` to bundle `src/codex-bridge.mjs` and `src/adapters/codex/broker.mjs` into both `skill/` and `plugin/`, and uses `js-yaml` for config loading. The CI workflow runs `npm ci`, `npm run build`, `npm test`, generated drift checks, output-existence checks, and bundled CLI sanity probes.

The command surface is broad. `help --json` reports commands for task dispatch, send/steer/respond, native and adversarial review, staged iteration, status/result/wait/events/cancel, setup/version/update/config/auth, artifact waiting, verdicts, and merge. `version --json` reports schema version `1.0`, package version `2.0.0`, active backend `codex`, and adapter capabilities such as plan mode, background jobs, auto-pipeline, adversarial review, worktree support, and artifact registry.

State is intentionally split. Project/workspace job state lives under a plugin-data-derived root keyed by canonical workspace root. Session logs live under the configured `session_dir`, defaulting to `~/.codex-bridge/sessions`, with append-only `.events` and `.ndjson` files. Per-task registry artifacts live under `~/.codex-bridge/jobs` unless overridden for tests.

The risk profile is mostly contract drift. Source changes can require generated bundle updates, command/help/schema changes can break plugin surfaces, hook changes can stall Claude shutdown, and app-server protocol changes can invalidate tests that only simulate local behavior. Future work should preserve small, source-first changes followed by `npm run build` and `npm test`.

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
| Initialize as brownfield GSD project | The repository already has source, generated bundles, tests, workflows, and release surfaces. | — Pending |
| Treat implementation as source of truth | Existing prose may be stale; user explicitly requested direct exploration and no repository Markdown trust. | — Pending |
| Use coarse phases with research, plan checks, and verification | The project has high cross-surface contract risk, so fewer larger phases with strong verification are easier to keep coherent. | — Pending |
| Commit planning docs by default | GSD docs should travel with the project unless the user later opts out. | — Pending |

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
*Last updated: 2026-04-30 after initialization*
