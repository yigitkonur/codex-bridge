# Phase 1 — Analysis

## Case 14.17 — No `wait --any` / `wait --all` primitives

| Field | Assessment |
|---|---|
| Validity | Real problem, partly mitigated in current checkout |
| Severity | P1 is appropriate; not P0 because jobs can still be polled with `status --watch`, `events`, or shell loops |
| Current state before this plan | Single-job `wait` existed, and `wait --any` existed for first terminal event only. Missing pieces were `wait --all`, `--jobs`, `--predicate`, `[QUESTION]` wakeups, partial timeout payloads, and complete docs/tests. |

## What The Problem Actually Is

Codex Bridge can fan out many background jobs, but the CLI did not provide a complete fan-in primitive for an explicit job cohort. Orchestrators needed two operations: wait until any job becomes actionable, and wait until all selected jobs reach terminal state. The current surface only partially covered that: single-job `wait` blocked on terminal tags, and `wait --any` returned the first terminal tag among N jobs. It could not wake on `[QUESTION]`, could not wait for all listed jobs, could not accept a list through `--jobs`, and could not express `terminal` vs `interrupt` vs `error` predicates.

## Root Cause

The event stream and job registry were built around single-job observation first: `events --follow` tails one `.events` file; Monitor owns one stream; `status --watch` polls a workspace-wide status table. The CLI grew single-job `wait` and then a narrow `--any` terminal scanner, but it never generalized the event-matching contract into a reusable N-target predicate engine. Documentation then continued recommending `status --watch` and `await-artifact`, which hid the gap but did not solve explicit cohort fan-in.

## Is It A Real Problem?

Yes. The critique overstates one historical detail for this checkout: `wait --any` already existed, so the case is no longer "no `--any` at all." The validated defect is narrower and still important: the existing `--any` was terminal-only, polling-like, and not enough for the orchestrator loop described in the case. `wait --all` was absent, `--predicate` was absent, and `[QUESTION]` could not wake the parent. P1 remains accurate because every parallel orchestrator needs this shape and otherwise duplicates fragile shell polling.

## Blast Radius

| Surface | What Breaks | Who Notices | When |
|---|---|---|---|
| Parallel task orchestration | Fan-out has no first-class fan-in barrier | Agents coordinating multiple Codex jobs | After launching N background jobs |
| Interactive jobs | `[QUESTION]` does not wake `wait --any` | Orchestrators and users waiting for input prompts | When Codex calls `requestUserInput` |
| Failure handling | Hand-rolled `running.length === 0` loops conflate success, failure, cancellation, and incomplete states | Automation scripts | During aggregation after a wave |
| Docs/help | Skill docs steer to status-table polling instead of a composable wait primitive | First-time users and slash-command agents | While reading SKILL.md or command help |

## Dependencies / Overlaps

| Related Area | Relationship |
|---|---|
| Monitor single-job constraint | Shared user pain, but not the same fix. Monitor remains single stream; `wait` provides CLI fan-in. |
| Event stream truth | `wait` must trust `.events` terminal/interrupt tags and keep the event vocabulary aligned with `TERMINAL_TAGS`. |
| Cancel lifecycle | Terminal wait should include cancellation. That requires `[CANCELLED]` to be a terminal event, not only a job status. |
| Status table | `status --watch` remains useful for humans but should not be the only machine-readable fan-in path. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Root Cause | Fix Surface |
|---|---|---|
| Wait predicate engine | `wait` did not model "match event predicate over N targets" | `src/handlers/inspect.mjs`, `src/commands-meta.mjs`, tests |
| Terminal event vocabulary | `wait` must consume the current terminal event vocabulary consistently | `src/lib/session-log.mjs`, wait/help/docs tests |
| Documentation contract | Public docs described single-job wait or status polling | `plugin/commands/wait.md`, `README.md`, `skill/SKILL.md`, `skill/references/command-reference.md`, monitor references |
| Generated bundles | Distributed CLI must match source | `skill/scripts/codex-bridge.mjs`, `plugin/scripts/codex-bridge.mjs` via `npm run build` |

## Sequencing

| Wave | Work | Prerequisite | Verification |
|---|---|---|---|
| 1 | Add failing tests for `wait --all`, `--jobs`, `--predicate`, interrupt wakeups, timeout partials, error predicate, invalid inputs | Read focus case and current handler | `node --test test/wait-any-all-primitives.test.mjs` fails before implementation |
| 2 | Implement shared N-target event matcher with `fs.watch` plus file-creation fallback | Wave 1 | Focused wait tests pass |
| 3 | Align `wait` predicates, help, and docs with existing terminal tags, including `[CANCELLED]` | Wave 2 | Wait/help/docs tests pass |
| 4 | Update help, slash command, skill docs, README, command reference | Wave 2 | Help/docs tests pass; manual `--help` includes new flags |
| 5 | Rebuild generated bundles and run test suite | Waves 1-4 | `npm run build`, `npm test` |

## Per-Cluster Work Items

| Cluster | Files / Modules | Behavior Change | Contract Fixed | Verification |
|---|---|---|---|---|
| Wait predicate engine | `src/handlers/inspect.mjs`, `src/commands-meta.mjs` | `wait` defaults to `--all`, accepts `--any`, repeatable `--jobs`, positional ids, and `--predicate terminal|interrupt|error|both`; returns partial details on timeout | Explicit job cohort fan-in without hand polling | Focused CLI tests parse JSON envelopes and exit codes |
| Terminal event vocabulary | `src/lib/session-log.mjs`, `src/handlers/inspect.mjs`, command help/docs | `wait` treats the same terminal tags as the event stream, including `[CANCELLED]` | Terminal means DONE/ERROR/INCOMPLETE/PLAN/CANCELLED | Wait predicate tests plus help output |
| Documentation contract | `plugin/commands/wait.md`, `README.md`, `skill/SKILL.md`, `skill/references/command-reference.md` | Docs point parallel agents to `wait --any --predicate both` and `wait --all` | Public command surface matches runtime | Static/docs tests plus manual help |
| Generated bundles | `skill/scripts/codex-bridge.mjs`, `plugin/scripts/codex-bridge.mjs` | Installable layouts include the same wait behavior | Release artifact parity | `npm run build`; generated diff present |

## Risk + Rollback Notes

| Risk | Mitigation | Rollback |
|---|---|---|
| Existing scripts depend on single-job `wait` payload | Preserve legacy payload when one target uses default terminal predicate without explicit `--all` | Revert `handleWait` changes only; keep tests to show contract loss |
| `[PLAN]` is both interrupt and terminal | Keep `[PLAN]` in `TERMINAL_TAGS` while also matching it for `interrupt` predicates | Revert predicate mapping, not terminal tag definition |
| Including `[CANCELLED]` in wait predicates changes fan-in completion for cancelled jobs | Cancellation is already terminal in the shared event vocabulary; tests/docs pin wait behavior to that vocabulary | Revert the wait predicate mapping if downstream callers need cancellation handled separately |
| `fs.watch` can miss file creation | Keep 500 ms fallback for absent event files | Revert to previous single-job watcher only if N-target watcher regresses |

## Acceptance Criteria

| Case | Acceptance Check |
|---|---|
| 14.17 | `codex-bridge wait --all --jobs "task-a task-b" --json` returns after both jobs emit terminal tags and includes summary plus per-job rows. |
| 14.17 | `codex-bridge wait --any --predicate both task-a task-b --json` returns on `[QUESTION]`, `[PLAN]`, `[DONE]`, `[ERROR]`, `[INCOMPLETE]`, or `[CANCELLED]` with the matching job id and event path. |
| 14.17 | `codex-bridge wait --any --predicate error ...` ignores `[DONE]` and returns on `[ERROR]` or `[INCOMPLETE]`. |
| 14.17 | Timeout exits with code 7 / `WAIT_TIMEOUT` and includes matched and pending targets in the JSON error details. |
| 14.17 | Passing the same job by job id and thread id waits once, not until a phantom duplicate target times out. |
| 14.17 | A wait started before the `.events` file exists returns when the file is later created with a matching event. |
| 14.17 | `wait --help`, `/codex-bridge:wait`, SKILL docs, README, and generated bundles advertise the same flags and predicates. |

## Out Of Scope

- General Monitor fanout or multi-stream Monitor redesign.
- Broader hook architecture changes from files 10-13.
- Status table redesign beyond preserving `status --watch`.
- Result transcript, runner envelope, worktree, base-ref, pipeline timeout, or destructive-diff findings from other `14-real-world-failure-cases` files.
- Further changes to cancel lifecycle beyond consuming the existing terminal-tag vocabulary.
- Changing the repository-wide exit-code taxonomy; timeout remains exit 7 and usage remains exit 2.
