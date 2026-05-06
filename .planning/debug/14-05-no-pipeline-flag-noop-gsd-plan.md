# Phase 1 — Analysis

| Case | Validity | Severity | Precise problem |
|---|---|---:|---|
| 14.05 `--no-pipeline` silently no-ops write tasks | Real, with corrected mechanism | P0 for batch orchestration | A zero-exit `task --write --no-pipeline` could emit `[DONE]` even when the Codex turn touched no files. If the workspace already had dirty files, cumulative diff stats made the no-op look successful. |

## What the problem actually is

`--no-pipeline` is intended as a way to skip slow review/fix/check validation. In the live runtime, the main Codex turn still runs before any pipeline branch, and Codex edits happen during that turn. The defect was not a skipped "diff application" stage; the pipeline diff stage captures and reports git state. The actual failure was that a write-mode turn with no touched files and no new git delta still received a success terminal.

## Root cause

- `request.noPipeline` bypassed `runAutoPipeline` entirely.
- The direct success path captured `git diff` and emitted `[DONE]` unconditionally for any zero-exit turn.
- The captured diff was workspace-cumulative, so pre-existing dirty files could appear as task output.
- No guard compared task-start git state plus current-turn `touchedFiles` before terminal rendering.

## Is it a real problem?

Yes. The source-backed mechanism differs from the report, but the trust failure is real: a write task can be terminal-successful without producing task-local work. P0 is justified for multi-agent batches because one bad flag choice can multiply false success across many jobs. It is not data loss in the sense of overwriting files; it is orchestration-state corruption and wasted worker budget.

## Blast radius

| Surface | Breakage | Who notices |
|---|---|---|
| Background write tasks | Jobs appear completed with no task-local edits | Batch orchestrators, CI-like loops |
| Event stream | `[DONE]` masks no-op | Monitor consumers |
| Result/diff artifacts | Dirty workspace stats look like produced work | Review/merge operators |
| Recovery | User reruns only after forensic inspection of `touchedFiles`/git state | Humans and supervising agents |

## Dependencies / overlaps

This overlaps with cumulative diff truth problems and terminal-tag truth problems, but the in-scope fix is local: no-pipeline semantics and write-mode no-work detection. Timeout defaults, broader event-stream redesign, and unrelated hook/manifest failures are out of scope.

# Phase 2 — GSD Implementation Plan

## Cluster map

| Cluster | Root cause | Files/modules | Contract fixed |
|---|---|---|---|
| Diff-only no-pipeline | `--no-pipeline` removed all pipeline observability | `src/lib/task-runtime.mjs`, `src/adapters/codex/pipeline.mjs` | `--no-pipeline` keeps diff capture and terminal pipeline close while skipping review/fix/check |
| No-op write guard | Zero-output write turns could emit `[DONE]` | `src/lib/task-runtime.mjs`, `src/adapters/codex/pipeline.mjs`, `src/lib/work-delta.mjs` | Write-mode tasks with no touched files and no git-state delta emit `[INCOMPLETE] no_files_touched` |
| Regression/docs | Tests and docs encoded old ambiguity | `test/handler-runtime.test.mjs`, `test/auto-pipeline-turn-watchdog.test.mjs`, `test/session-log.test.mjs`, `skill/*`, generated bundles | Observable behavior is pinned and documented |

## Sequencing

1. Diagnosis and falsification: verify code path and correct the report mechanism.
2. Regression first: add `--write --no-pipeline` tests for diff-only success and no-op incomplete with pre-existing dirty state.
3. Runtime fix: pass task-start work fingerprint and touched files into pipeline; make no-work incomplete before `[DONE]`.
4. Docs/build: update skill references, run `npm run build`.
5. Verification: targeted runtime/pipeline/static suites; full suite.

## Work items

| Work item | Behavior change | Verification |
|---|---|---|
| Run diff-only pipeline for `--no-pipeline` | Emits `[PIPELINE:diff]`, `[PIPELINE:diff:done]`, `[PIPELINE:done]`; skips review/fix/check turns | `node --test test/handler-runtime.test.mjs` |
| Detect no-op write tasks | If `--write` has no current-turn touched files and git state equals task start, emit `[INCOMPLETE]` with `no_files_touched` | `no-pipeline write task with no new work is incomplete despite preexisting diff` |
| Preserve task-vs-workspace diff truth | Task diff and workspace diff stay separately rendered when the workspace began dirty | `node --test test/auto-pipeline-turn-watchdog.test.mjs test/session-log.test.mjs` |
| Rebuild generated surfaces | Bundled skill/plugin CLIs include runtime changes | `npm run build`; baseline contract tests |

## Risk + rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Legitimate no-change write tasks now report incomplete | This is intentional for `--write`; use read-only/default task for inspection-only prompts | Revert the no-work guard hunk |
| Pre-existing dirty files confuse task output | Work fingerprint comparison avoids treating unchanged dirty state as new work | Revert to direct diff capture only |
| Diff-only pipeline changes event expectations | Tests pin `[PIPELINE:diff]` and skipped validation stages | Disable diff-only path and retain no-work direct guard |

## Acceptance criteria

| Case | Check |
|---|---|
| 14.05 | A `task --write --no-pipeline` that edits a file emits `[DONE]` with `[PIPELINE:diff]` but no review/check stages. |
| 14.05 | A `task --write --no-pipeline` with no touched files and unchanged git state emits `[INCOMPLETE] no_files_touched`, even if the workspace had pre-existing dirty files. |
| 14.05 | `PIPELINE_SKIPPED` records skipped validation stages and retained diff capture. |

## Verification result

Implemented and verified with `npm run build` plus targeted runtime/pipeline/static/baseline/broker suites: `node --test test/handler-runtime.test.mjs test/auto-pipeline-turn-watchdog.test.mjs test/session-log.test.mjs test/bridge-static.test.mjs test/baseline-contracts.test.mjs test/broker-lifecycle.test.mjs` passed with 87 passing, 0 failing. Full `npm test` was attempted on this branch; all in-scope tests passed, but pre-existing `test/git-worktree.test.mjs` merge/worktree cleanup cases failed on the stale local main lineage.

## Out of scope

- Changing default pipeline timeout budgets.
- Redesigning terminal envelope semantics for all error classes.
- Fixing cumulative workspace diff reporting outside the no-pipeline/no-work guard.
- Hook manifest/path failures unrelated to this focus case.
- Any non-focus files from `00-13`, `15`, or the flat `14` summary.
