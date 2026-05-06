---
status: resolved
trigger: "14.10 cancel leaves orphaned worktrees and branches after --worktree-auto tasks are cancelled"
created: "2026-05-06T00:00:00.000Z"
updated: "2026-05-06T00:00:00.000Z"
---

# Phase 1 — Analysis

| Case | Verdict | Priority | Reason |
| --- | --- | --- | --- |
| 14.10 — `cancel <task_id>` leaves orphaned worktrees and branches | Real | P0 for parallel worktree users, otherwise P1 | Every cancelled `--worktree-auto` task can leave a full checkout and task branch behind. In fan-out workflows the cleanup burden scales linearly with cancelled jobs and pollutes both disk and Git namespace. |

## Problem

`cancel <task_id>` currently means "interrupt the Codex turn, terminate the worker process, and mark the job cancelled." For tasks launched with `--worktree-auto`, users reasonably expect cancellation to also dispose of the per-task Git artifacts that exist only to isolate that job: `.codex-bridge-worktrees/<task_id>` and `subagent/codex/<task_id>`. The current handler updates job state but does not call the existing worktree-prune helper, so cancellation leaves the task's checkout and branch alive.

## Root Cause

The source already has the primitive needed for cleanup: `src/lib/git.mjs` exports `pruneWorktreeOnCancel`, and tests cover its idempotent worktree and branch removal. The defect is orchestration-level drift: `src/handlers/task.mjs::handleCancel` was updated for adapter lifecycle semantics and normalized cancel envelopes, but it never wired worktree metadata from the task registry (`readMeta(job.id).worktree`) into the cleanup helper. Command parsing also exposes only `--json`, so there is no explicit forensic opt-out.

The adapter layer is not the right fix surface. `src/adapters/codex/index.mjs::cancel` correctly owns upstream turn interruption; Git cleanup is bridge-owned lifecycle work because the bridge created the worktree and branch.

## Validation

The claim is valid for the cleanup portion. Source inspection confirms:

- `handleTask` writes `worktree` metadata to registry meta when `--worktree-auto` creates an isolated checkout.
- `handleCancel` reads stored job state, interrupts the turn, terminates the worker, writes `cancelled` state, and emits the normalized envelope.
- `handleCancel` does not read registry metadata and does not remove a worktree or branch.
- `pruneWorktreeOnCancel` exists and is already tested, but is unused by cancel.

The issue's event-stream expectation overlaps with sibling case 22. This plan treats `[CANCELLED]` event semantics as out of scope for 14.10 because the focus file itself separates monitor signaling from filesystem cleanup. The cleanup fix should not silently broaden the terminal event vocabulary in this pass.

## Blast Radius

| Impact | Who notices | When |
| --- | --- | --- |
| Disk growth from abandoned full checkouts | Heavy bridge users, parallel orchestrators | After repeated cancel/retry cycles |
| `git worktree list` clutter | Anyone using manual worktrees or bridge worktrees | Immediately after cancellation |
| Branch namespace pollution | Users and automation scanning branches | After cancelled `--worktree-auto` jobs |
| Trust erosion in cancel semantics | Orchestrators relying on cancel as recovery | First time manual cleanup is required |

## Dependencies / Overlaps

| Area | Relationship | Sequencing |
| --- | --- | --- |
| Worktree lifecycle | Direct fix surface: registry metadata plus `pruneWorktreeOnCancel` | First |
| CLI contract | Needs `--keep-worktree`, `--keep-branch`, `--keep-all` opt-outs | Same wave as cleanup |
| Cancel envelope/rendering | Should report cleanup result and preserved artifacts | Same wave |
| Event stream / Monitor | Sibling issue, not required to remove Git artifacts | Defer |
| Doctor/orphan sweeper | Backstop for historical orphans, broader tooling | Defer |

# Phase 2 — GSD Implementation Plan

## Cluster Map

| Cluster | Root cause / surface | Behavior fixed | Verification |
| --- | --- | --- | --- |
| Cancel lifecycle cleanup | `src/handlers/task.mjs`, `src/lib/git.mjs`, registry meta | Default cancel removes bridge-created worktree and task branch | CLI regression creates a real worktree task record, cancels it, then checks path and branch are gone |
| Forensic opt-outs | `src/handlers/task.mjs`, `src/commands-meta.mjs`, `plugin/commands/cancel.md` | `--keep-worktree`, `--keep-branch`, and `--keep-all` preserve requested artifacts | CLI regression checks preserve modes keep the requested artifacts and report cleanup status |
| User-facing result | `src/lib/render.mjs`, cancel JSON payload | Cancel output exposes cleanup booleans, failures, and preserved paths/branches | Existing cancel-envelope test extended for cleanup shape |

## Execution Waves

| Wave | Work | Prerequisites |
| --- | --- | --- |
| 1 | Add regression coverage for default cleanup and keep flags. | Current `pruneWorktreeOnCancel` behavior understood. |
| 2 | Wire `handleCancel` to registry worktree metadata and cleanup helper. | Wave 1 failing. |
| 3 | Update cancel command metadata and plugin command argument hint. | Wave 2 behavior stable. |
| 4 | Run focused tests, then build and full tests if generated dirty tree allows it. | Waves 1-3 complete. |

## Work Items

| Cluster | Files likely touched | Contract |
| --- | --- | --- |
| Cancel lifecycle cleanup | `src/handlers/task.mjs`, `test/cancel-envelope.test.mjs` | If registry meta has `worktree.isolation_mode === "worktree"`, cancel removes `worktree.path` and deletes `worktree.branch` unless explicitly preserved. Cleanup is best-effort and never turns a successful cancellation into a hard failure; failures are reported in warnings and payload. |
| Forensic opt-outs | `src/handlers/task.mjs`, `src/commands-meta.mjs`, `plugin/commands/cancel.md` | `--keep-all` implies both `--keep-worktree` and `--keep-branch`. `--keep-branch` is honored independently, but keeping the worktree may require keeping the branch because Git cannot delete a branch checked out in another worktree. |
| User-facing result | `src/lib/render.mjs`, `test/cancel-envelope.test.mjs` | JSON and text report whether cleanup ran, whether it succeeded, and which artifacts were preserved or removed. |

## Risk + Rollback

| Risk | Mitigation | Rollback |
| --- | --- | --- |
| Deleting a non-bridge branch | Only delete the branch recorded in registry metadata and only if it starts with `subagent/`; otherwise skip and warn. | Revert cancel handler wiring; worktree helper remains unchanged. |
| Worktree has useful forensic changes | Default matches cancel semantics; `--keep-worktree` and `--keep-all` preserve inspection path. | Revert default behavior or document temporary `--keep-all` usage. |
| Git cleanup failure masks cancellation | Cleanup failures are best-effort warnings; job still transitions to cancelled. | Remove cleanup payload additions while preserving state transition. |
| Dirty generated outputs block clean commit | Stage only task-owned source/test/command hunks; report any generated drift not safely separable. | Leave generated files untouched if they were dirty before this task. |

## Acceptance Criteria

| Case | Check |
| --- | --- |
| 14.10 | A test launches/crafts a `--worktree-auto` job record with real `meta.worktree`, runs `cancel <task_id> --json`, and verifies the worktree path no longer exists and `git branch --list <branch>` is empty. |
| 14.10 keep mode | A test runs `cancel <task_id> --keep-worktree --json` and verifies the worktree path and branch still exist, with payload cleanup marked `preserved`. |

## Verification Notes

| Check | Result |
| --- | --- |
| `node --test test/cancel-envelope.test.mjs test/git-worktree.test.mjs` | Pass: 22 tests |
| `node --test test/cancel-envelope.test.mjs` | Pass: 3 tests |
| `node --test test/git-worktree.test.mjs` | Pass: 19 tests |
| `npm run build` | Pass |
| `npm test -- --test-concurrency=1` | 412 pass, 1 fail unrelated to 14.10: `test/bridge-static.test.mjs` expects `const captureTaskDiff = () =>` while dirty `src/adapters/codex/pipeline.mjs` currently defines `const captureTaskDiff = (extraTouchedFiles = []) =>`. |

## Out of Scope

- `[CANCELLED]` event terminal semantics and Monitor self-termination from sibling case 22.
- Doctor/orphan cleanup for artifacts created by older bridge versions.
- Absolute path prompt isolation from case 09.
- Broader CLI envelope, event-stream, auto-approve, hook architecture, or scalability changes from documents 00-13 and 15.
