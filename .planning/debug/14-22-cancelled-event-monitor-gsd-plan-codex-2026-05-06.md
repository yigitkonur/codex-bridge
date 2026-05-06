# Phase 1 — Analysis

## Focus Case

| Case | Validity | Priority | Verdict |
|---|---:|---:|---|
| `14.22 - cancel doesn't emit [CANCELLED] event; attached Monitors run until their own timeout` | Real | P1 | Fix in cancel/event-stream contract |

## What The Problem Actually Is

`cancel <jobId>` transitions the job registry to `cancelled` and terminates the backing process, but the job's task-scoped `.events` file does not receive a terminal lifecycle event. Monitor and `events --follow` are intentionally scoped to `.events`, not to the registry. When a job is cancelled, the worker process stops producing events and the file becomes silent, so attached Monitors keep waiting until their own timeout.

The defect has two parts:

1. Cancellation is a terminal job lifecycle transition, but it is not appended to the task event stream.
2. The canonical terminal vocabulary did not include `CANCELLED`, so even a future `[CANCELLED]` line would not have released `events --follow`, `wait`, or shell fallback consumers until the terminal matcher changed.

## Root Cause

| Layer | Root Cause | Evidence |
|---|---|---|
| State vs event split | The registry and process lifecycle are updated by `handleCancel`, while Monitor tails only `~/.codex-bridge/sessions/<threadId>.events`. No bridge-side event append happened on cancel. | `src/handlers/task.mjs` updated job state and emitted the cancel envelope, but had no `logEvent(...)` call for cancellation. |
| Terminal vocabulary | `TERMINAL_TAGS` and `TERMINAL_TAG_REGEX` omitted `CANCELLED`. | `src/lib/session-log.mjs` terminal set was `DONE`, `ERROR`, `INCOMPLETE`, `PLAN`. |
| Fallback consumer drift | Monitor's shell fallback had a hardcoded terminal case list, separate from the exported terminal tag array. | `src/lib/envelope-helpers.mjs` broke on `DONE|ERROR|INCOMPLETE|PLAN` only. |
| Result fallback mismatch | Cancelled job status mapped to fallback terminal tag `ERROR`, which would conflict with a real `[CANCELLED]` event after fixing the stream. | `src/adapters/codex/index.mjs` treated `cancelled` like `failed`/`orphaned`. |

## Is It A Real Problem?

Yes. The focused claim is accurate against current source behavior. It is correctly a P1, not a P0: cancellation still kills the worker and updates registry state, so the task is stopped, but attached monitors remain misleadingly alive until timeout. The impact is user-facing orchestration noise, resource retention, and delayed false timeout notifications, not data loss by itself.

The report's broader cleanup language overlaps sibling cancel-worktree cleanup work. That overlap is real, but the in-scope defect is narrower: event-stream truth for cancellation and terminal consumer recognition of `CANCELLED`.

## Blast Radius

| Surface | What Breaks | Who Notices | When |
|---|---|---|---|
| `events --follow` / Monitor | Stream does not close on cancel; later timeout looks like a stall. | Orchestrators and users watching background jobs. | Any running job with a known `threadId` and an attached Monitor. |
| `wait` / fan-in predicates | Cancel cannot be represented as a terminal event in the event-backed primitive. | Multi-job orchestrators. | Parallel job cancellation or wait-any/all flows. |
| Human forensics | Event history shows the last checkpoint/progress line but not the actual cancellation. | Maintainers investigating old sessions. | After cancellation, especially when logs are reviewed later. |
| Result consistency | Once `[CANCELLED]` exists, fallback status must agree with the event terminal tag. | Tooling reading `result --json`. | Cancelled jobs whose event file is missing or partially written. |

## Dependencies / Overlaps

| Related Case | Relationship | In This Plan? |
|---|---|---|
| `10-P0-cancel-leaves-worktrees-and-branches.md` | Shares the cancel handler and cleanup envelope. Current source already has worktree cleanup behavior; this case only needs to report cleanup in the cancellation event. | No new cleanup work. |
| `14-P1-monitor-on-n-jobs-anti-pattern.md` | Cancellation event reduces phantom monitors, but does not change Monitor's single-job design or fan-in guidance. | No fan-in redesign. |
| Event-stream truth cases | Same invariant: every terminal lifecycle state must have a terminal event. | Yes, for `CANCELLED` only. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Shared Root Cause / Surface | Files / Modules | Contract Fixed |
|---|---|---|---|
| C1 Terminal vocabulary | `CANCELLED` absent from canonical terminal matching | `src/lib/session-log.mjs`, `src/adapters/codex/index.mjs`, `src/lib/envelope-helpers.mjs` | `CANCELLED` is a terminal tag for `events --follow`, `wait`, Monitor hints, shell fallback, and result fallback. |
| C2 Cancel event append | Cancel changed registry/process state but not `.events` | `src/handlers/task.mjs`, `test/cancel-envelope.test.mjs` | `cancel <jobId>` appends `[CANCELLED]` to the task event stream before returning success when `threadId` is known. |
| C3 User-facing contract docs | Public references listed stale terminal tags | `skill/SKILL.md`, `skill/references/*`, `plugin/commands/*`, `plugin/skills/*`, `.planning/codebase/ADAPTERS.md`, hook text | Operators see `CANCELLED` as a terminal lifecycle event everywhere Monitor guidance appears. |
| C4 Generated bundles | Source/hook changes must ship in installable layouts | `skill/scripts/codex-bridge.mjs`, `plugin/scripts/codex-bridge.mjs`, `plugin/hooks/*` | Build output matches source. |

## Sequencing

| Wave | Prerequisite | Work | Verify |
|---|---|---|---|
| 1. Reproduce | Read focus report and trace source | Add regression: start `events --follow`, run `cancel`, assert no timeout and `[CANCELLED]` appears in `.events`. | `node --test test/cancel-envelope.test.mjs` fails before fix. |
| 2. Event contract | Wave 1 red | Add `formatCancelledEvent`, include `CANCELLED` in terminal tags/regex, update result fallback status mapping. | Focused regression passes; session-log terminal tag test passes. |
| 3. Cancel writer | Wave 2 | In `handleCancel`, resolve session dir, append cancellation event with reason, duration, stop/cleanup summary, and result action. | Focused regression passes and event file contains `[CANCELLED]`. |
| 4. Consumer/doc sync | Wave 2 | Update Monitor fallback, hook handoff text, command metadata, monitor references, and adapter vocabulary docs. | Static tests and `rg` checks show stale terminal lists removed or deliberately historical. |
| 5. Generated output | Waves 2-4 | Run build to refresh bundled CLI and plugin hook copies. | `npm run build`; generated diff present where expected. |
| 6. Full gate | Waves 1-5 | Run project test suite and fresh-context review. | `npm test`; review finds no blocking issue. |

## Per-Cluster Work Items

| Cluster | Behavior Change | Verification Method | Risk / Rollback |
|---|---|---|---|
| C1 | `TERMINAL_TAGS` becomes `DONE, ERROR, INCOMPLETE, PLAN, CANCELLED`; regex and adapter phase mapping agree. | `test/session-log.test.mjs`; `events --follow` regression. | Risk: consumers treating cancelled as error may see a clearer terminal tag. Rollback by reverting terminal set and adapter cancelled mapping. |
| C2 | Cancel appends a `[CANCELLED] <threadId> cancelled at <ts>` block with reason, duration, stop state, cleanup summary, warnings, and detail command. | New `cancel emits CANCELLED and releases events follow` test. | Risk: event write silently fails if session path is unavailable; cancel still completes and warns if `threadId` is missing. |
| C3 | Monitor docs and command/hook surfaces include `CANCELLED` as terminal. | Static `rg` plus existing plugin/docs tests. | Risk: broad docs churn. Rollback only the docs/hook text if wording proves noisy; keep source contract. |
| C4 | Bundled source contains the same cancellation event behavior as `src/`. | `npm run build`; generated drift tests in `npm test`. | Rollback by rebuilding after reverting source. |

## Acceptance Criteria

| Case | One-Line Check |
|---|---|
| 14.22 | A running job with `events --follow --json` attached exits without timeout after `cancel <jobId>`, and the job `.events` file contains a terminal `[CANCELLED]` line. |

## Out Of Scope

- Worktree or branch cleanup policy beyond reporting the existing cleanup result in `[CANCELLED]`.
- Multi-job Monitor fan-in redesign; use `wait --any/--all` and status fan-in primitives for N jobs.
- Hook architecture redesign from docs `10-13`.
- Any failure cases from non-focus files, including flat `14-real-world-failure-cases.md` items not represented by this per-issue focus file.
- Changes to cancellation authorization, destructive-diff gates, or external PR/deploy behavior.
