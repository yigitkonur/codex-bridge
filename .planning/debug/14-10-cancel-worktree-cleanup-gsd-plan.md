# Phase 1 — Analysis

## Focus Case

| Case | Validation | Severity | Decision |
|---|---|---:|---|
| 14.10 `cancel <task_id>` leaves worktrees and branches | Real defect. Current `cancel` reaps the worker and marks job state `cancelled`, but it does not connect recorded `--worktree-auto` metadata to the existing git cleanup primitive. | P0 for multi-agent hygiene; P1 for single-job correctness | Fix filesystem/git cleanup in `cancel`; keep monitor `[CANCELLED]` emission out of this slice because the focus file cross-references it as sibling issue 22. |

## Problem

`task --write --worktree-auto` creates a bridge-owned git worktree at `<repo>/../.codex-bridge-worktrees/<task_id>` and a `subagent/<backend>/<task_id>` branch. When the user later runs `cancel <task_id>`, the command only interrupts the Codex turn, terminates the worker process tree, and updates state. The checkout and branch remain registered in Git, so repeated cancel/retry loops accumulate phantom worktrees and branches.

## Root Cause

The architecture has the data and primitive needed for cleanup, but they are not wired into the cancel lifecycle:

| Layer | Current behavior | Gap |
|---|---|---|
| Task dispatch | Persists `job.worktree`, `registryTaskId`, and registry `meta.json` for `--worktree-auto` jobs. | Metadata is only consumed by review/merge/iterate paths. |
| Git lifecycle | `pruneWorktreeOnCancel` removes worktrees and deletes branches idempotently. | The function has no branch-preservation option and is not called from `cancel`. |
| Cancel handler | Resolves active job, calls adapter cancel, terminates process tree, writes cancelled job state. | Does not read registry worktree metadata, does not remove git artifacts, and does not report cleanup status. |
| CLI contract | `cancel --help` advertises process cancellation only. | Users get no warning that artifacts remain and no way to intentionally preserve/clean. |

## Is It Real?

Yes. The source confirms `handleCancel` updates state but never calls `pruneWorktreeOnCancel`; `pruneWorktreeOnCancel` is used by merge only. The claim is not overstated for parallel-agent use: every cancelled worktree task leaves one checkout plus one branch, so cleanup cost is linear in cancelled jobs. The P0 label is justified for orchestration sessions because the defect silently corrupts the operator's git hygiene over time. For a single manual cancel, impact is closer to P1/P2 because the job is stopped successfully and the leftover artifacts are recoverable.

The `[CANCELLED]` event part is a real adjacent issue, but this implementation treats it as out of scope for this branch because the focus file points to issue 22 for monitor semantics. This branch fixes the filesystem/git lifecycle part of 14.10.

## Blast Radius

| Surface | Who notices | Manifestation |
|---|---|---|
| Disk | Users running repeated cancelled worktree tasks | `.codex-bridge-worktrees/task-*` grows until manually removed. |
| Git worktree registry | Operators and agents inspecting repo state | `git worktree list` contains stale cancelled jobs. |
| Branch namespace | Users, merge/review tooling, branch scans | `subagent/*/task-*` branches pile up after cancelled dispatches. |
| Recovery UX | Orchestrators | `cancel` succeeds but does not mean "task artifacts are gone"; users need custom cleanup scripts. |

## Dependencies / Overlaps

| Related area | Relationship | Sequencing |
|---|---|---|
| Issue 22 cancel event terminal tag | Shares the cancel handler, but fixes monitor/event truth rather than git cleanup. | Can follow after this cleanup work; should update session-log terminal semantics separately. |
| Worktree path isolation issues | More cancels happen when a bad prompt or path strategy forces redo loops. | Independent root cause; cleanup reduces accumulated damage during those loops. |
| Merge cleanup | Uses the same `pruneWorktreeOnCancel` primitive. | Preserve default merge behavior while adding a `keepBranch` option for cancel only. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Root cause / fix surface | Files |
|---|---|---|
| Cancel lifecycle cleanup | `handleCancel` lacks worktree metadata lookup and prune call. | `src/codex-bridge.mjs` |
| Git prune contract | Cleanup primitive always deletes branches; cancel needs `--keep-branch`. | `src/lib/git.mjs` |
| Operator feedback | Help/render/docs do not describe default cleanup or preservation flags. | `src/codex-bridge.mjs`, `src/lib/render.mjs`, `plugin/commands/cancel.md`, `skill/SKILL.md`, `plugin/skills/codex-bridge/SKILL.md` |
| Regression coverage | No test proves cancel removes or preserves worktree artifacts. | `test/cancel-envelope.test.mjs`, `test/git-worktree.test.mjs` |
| GSD traceability | Need one scoped deliverable for the focus case. | `.planning/debug/14-10-cancel-worktree-cleanup-gsd-plan.md` |

## Sequencing

1. Add cancel flags and metadata-driven cleanup after process termination.
2. Extend `pruneWorktreeOnCancel` with `keepBranch` while preserving merge defaults.
3. Surface cleanup result in JSON, recovery details, stored job detail, state index, registry meta, and human render.
4. Update command and skill docs so operators know cleanup is default and `--keep-*` is explicit forensic mode.
5. Add focused tests for default cleanup and `--keep-worktree`, plus isolate git-worktree temp roots so parallel tests do not share `.codex-bridge-worktrees`.
6. Run focused tests, build generated bundles, then run the full test suite before commit.

## Per-Cluster Work Items

| Cluster | Behavior fixed | Contract | Verification |
|---|---|---|---|
| Cancel lifecycle cleanup | `cancel <task_id>` removes bridge-owned worktree and `subagent/*/<task_id>` branch by default. | Cancel means stop worker and clean task-owned git artifacts unless caller opts out. | Integration test creates real git repo, worktree, registry meta, running job, then asserts path and branch are gone after cancel. |
| Preservation flags | `--keep-worktree` preserves checkout and branch; `--keep-branch` preserves branch while removing checkout; `--keep-all` preserves both. | Forensic leftovers require explicit CLI intent. | Test asserts `--keep-worktree` leaves path and branch present and reports preservation. |
| Git prune primitive | Existing merge cleanup still deletes branch by default; cancel can keep branch. | `keepBranch=false` remains current behavior. | Existing `git-worktree` prune and merge tests plus new cancel tests. |
| Feedback/doc surface | Help, slash command hints, JSON payload, recovery details, rendered report, and docs show cleanup behavior. | Users and agents can discover the new default and opt-out flags. | `node src/codex-bridge.mjs cancel --help`; static/build checks. |

## Risk + Rollback Notes

| Risk | Mitigation | Rollback |
|---|---|---|
| Deleting non-bridge branches from bad metadata | Branch deletion is limited to names starting `subagent/`; non-bridge branches are preserved and warned. | Revert the cancel handler cleanup call; process cancellation remains intact. |
| Removing a user path from corrupt metadata | Cleanup requires bridge-owned signals: `isolation_mode=worktree`, `subagent/` branch, or `.codex-bridge-worktrees/` path. | Revert helper and docs; `pruneWorktreeOnCancel` default remains compatible. |
| `--keep-worktree` with branch deletion is incoherent because Git cannot delete a checked-out branch | Treat `--keep-worktree` as also preserving the branch and warn the caller. | None needed; this is the safe Git behavior. |
| Merge cleanup regression | `keepBranch` defaults to false, so merge callers retain prior behavior. | Existing tests catch branch-retention drift. |

## Acceptance Criteria

| Case | Acceptance check |
|---|---|
| 14.10 | A cancelled `--worktree-auto` job reports `cleanup.succeeded=true`, removes its `.codex-bridge-worktrees/<task_id>` checkout, and deletes its `subagent/*/<task_id>` branch; `--keep-worktree` intentionally preserves both and reports `reason=preserved-by-user`. |

## Out of Scope

| Item | Reason |
|---|---|
| `[CANCELLED]` terminal event and monitor shutdown semantics | Covered by sibling issue 22, not this focus implementation slice. |
| `doctor --worktrees` orphan scan/cleanup | Useful backstop for historical orphans, but broader CLI work outside the focus fix. |
| Absolute-path prompt/worktree isolation fixes | Separate root cause referenced by issue 09. |
| Broad hook architecture, dispatch, event stream redesign, and roadmap items from docs 00-13 or 15 | Reference material only; not derived as work for this focus branch. |

## Verification Notes

Implemented in this branch and verified with focused cancel/worktree tests, build, and full suite before commit.
