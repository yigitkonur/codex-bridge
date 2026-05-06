# Phase 1 — Analysis

## Focus Case 14.20 — Stall Detection Has No Early Warning

| Field | Analysis |
|---|---|
| Problem | The bridge can identify a no-action stall only at the terminal threshold. After Codex has produced at least one actionable item, `runBridgeTask` counts barren checkpoint windows, but it surfaces nothing until the count reaches `CODEX_BRIDGE_STALL_CHECKPOINTS` and emits terminal `[ERROR] | StallDetected`. |
| Root cause | Stall state is internal to `src/lib/task-runtime.mjs`. The checkpoint loop increments `barrenCheckpoints`, then jumps directly to `formatErrorEvent(... StallDetected)` at the terminal threshold. `src/lib/session-log.mjs` has no `[STALL_WARNING]` formatter, and docs describe only `[WARNING]` for the command-family circuit breaker plus terminal stall detection. |
| Is it real? | Yes. P1 is justified for long-running and fan-out orchestration because the default Monitor excludes noisy liveness/detail tags and fully empty checkpoint windows are skipped instead of rendered. The default filter still passes `[STALL_WARNING]`, so no dedicated filter change is needed for this case. |
| Blast radius | Orchestrators watching a long task get no explicit "no actionable progress" signal before terminal stall. They either wait until `[ERROR] | StallDetected`, manually inspect raw events/NDJSON, or cancel based on guesswork. Parallel task waves compound the wall-clock loss. |
| Dependencies / overlaps | Shares observability surface with default Monitor filtering and status-progress cases, but this case can be fixed locally by adding a non-terminal event to the existing stall detector. It must not change `TERMINAL_TAGS`; `[STALL_WARNING]` is advisory and must keep Monitor open. |

## Validated Contract

| Contract Point | Decision |
|---|---|
| Progress heuristic | Preserve the existing actionable-only heuristic: `commandExecution`, `fileChange`, and `plan` reset the barren counter. Assistant messages can appear in checkpoints but do not count as actionable progress. |
| Warning timing | Emit `[STALL_WARNING]` once per barren checkpoint window after the first actionable item, while `barrenCheckpoints < CODEX_BRIDGE_STALL_CHECKPOINTS`. |
| Terminal timing | Keep `[ERROR] | StallDetected` at the existing configured threshold and keep the current Monitor self-close semantics for `[ERROR]`. |
| Default visibility | No default filter change is required because `[STALL_WARNING]` is not in `DEFAULT_MONITOR_EXCLUDE`; it passes through the default Monitor command automatically. |
| Configuration | No new config key is needed. Existing `CODEX_BRIDGE_CHECKPOINT_MS` controls warning cadence; existing `CODEX_BRIDGE_STALL_CHECKPOINTS` controls terminal threshold. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Shared surface | Cases | Fix |
|---|---|---|---|
| Stall-warning event contract | `src/lib/session-log.mjs`, `src/lib/task-runtime.mjs`, runtime tests | 14.20 | Add a distinct non-terminal `[STALL_WARNING]` formatter, emit it from the existing checkpoint loop before terminal stall, and persist matching NDJSON. |
| Monitor/default event truth | `src/lib/session-log.mjs`, `src/handlers/inspect.mjs`, event-filter tests | 14.20 | Keep terminal tags unchanged and prove the default exclusion filter preserves `[STALL_WARNING]`. |
| User-facing documentation | `skill/**`, `plugin/skills/codex-bridge/**`, `.planning/codebase/ADAPTERS.md`, adapter type surface | 14.20 | Add `[STALL_WARNING]` to the canonical vocabulary and references without broad hook/status redesign. |

## Sequencing

1. Runtime event primitive -> verify with `test/session-log.test.mjs`.
2. Checkpoint emission -> verify with fake Codex runtime and tiny checkpoint intervals in `test/handler-runtime.test.mjs`.
3. Monitor filter/docs surface -> verify with `test/events-exclude-heartbeat.test.mjs` and `test/plugin-surfaces.test.mjs`.
4. Build generated bundles -> verify `npm run build`.
5. Full regression -> verify `npm test`; if unrelated concurrent failures remain, record them separately.

## Per-Cluster Work Items

| Cluster | Files / modules | Behavior change | Verification |
|---|---|---|---|
| Stall-warning event contract | `src/lib/session-log.mjs`, `src/lib/task-runtime.mjs` | Barren checkpoint windows emit `[STALL_WARNING]` with threshold, remaining time, last actionable summary, recommendation, and tail command. Terminal `[ERROR] | StallDetected` remains unchanged at threshold. | Unit formatter test confirms non-terminal tag and body; runtime test asserts `[STALL_WARNING]` appears before `StallDetected`. |
| Monitor/default event truth | `src/lib/session-log.mjs`, `test/events-exclude-heartbeat.test.mjs` | `[STALL_WARNING]` is not terminal and is not filtered by the default Monitor command. | Filter test includes `[STALL_WARNING]`; session-log test asserts `TERMINAL_TAG_REGEX` does not match it. |
| User-facing documentation | `skill/SKILL.md`, `skill/references/{monitor-patterns,notification-format,config-reference,ndjson-guide}.md`, plugin reference mirrors, `.planning/codebase/ADAPTERS.md`, `src/adapters/index.d.ts` | Docs describe warning-then-terminal semantics and classify `[STALL_WARNING]` as non-terminal recovery/progress. | Static plugin-surface assertions plus grep review for stale "stall only terminal" language. |

## Risk + Rollback Notes

| Risk | Mitigation / rollback |
|---|---|
| Warning noise on legitimate long reasoning | Preserve the existing grace period: the barren counter starts only after the first actionable item. Warning cadence is at checkpoint cadence, not heartbeat cadence. |
| Consumers treat warning as terminal | Do not add `STALL_WARNING` to `TERMINAL_TAGS`; tests assert the terminal regex ignores it. |
| Docs drift from runtime | Add tests for runtime event order and packaged docs. `npm run build` refreshes generated CLI bundles after source changes. |
| Concurrent agents touched same docs | Keep edits additive and line-local; do not rewrite surrounding sections. Rollback is reverting the STALL_WARNING additions without affecting other case work. |

## Acceptance Criteria

| Case | Check |
|---|---|
| 14.20 | A fake long-running task with one initial `commandExecution`, tiny checkpoint interval, and `CODEX_BRIDGE_STALL_CHECKPOINTS=3` writes `[STALL_WARNING]` before `[ERROR] | StallDetected`; default `events --exclude HEARTBEAT` preserves `[STALL_WARNING]`; docs classify it as non-terminal. |

## Out of Scope

- Changing the definition of actionable progress to count assistant messages.
- Adding YAML config keys for warning thresholds.
- Reworking status-progress shape or case 23.
- Reworking default checkpoint filtering or case 24 beyond noting the current source already uses exclusion filtering.
- Rewriting hook architecture, Monitor auto-arm behavior, or broader docs from feedback files 00-13/15.
