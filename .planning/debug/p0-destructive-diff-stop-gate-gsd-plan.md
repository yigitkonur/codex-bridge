# Phase 1 — Analysis

| Case | Validity | Severity | Decision |
|---|---|---:|---|
| `03-P0-destructive-diff-not-flagged-or-paused.md` | Valid. `runAutoPipeline` logs the first diff stat, then proceeds to review/check without a deterministic local risk classifier. | P0 | Keep P0 because the failure is rare but can destroy large work batches while unattended. |

## Problem

The bridge auto-pipeline treats the initial git diff as informational only. A run can emit a stat such as `64 files | +598 -31744` and continue into native review and later stages unless the LLM reviewer happens to object or a human watching Monitor cancels manually. The missing contract is: high-risk diffs must pause for explicit approval before any further bridge-driven write stage continues.

## Root Cause

`src/adapters/codex/pipeline.mjs` captures the initial diff with `captureGitDiff`, logs `[PIPELINE:diff:done]`, and immediately advances to auto-review. The only downstream judgment is `parseNativeReviewText(reviewResult.reviewText)`, which is probabilistic and review-content dependent. There is no deterministic threshold on `diff.files`, additions, deletions, or file count, and no pipeline-owned approval wait between diff capture and the next stage.

The existing platform already has a suitable pause primitive: `[QUESTION]` events plus disk-backed `respond` IPC. The root defect is not lack of IPC; it is that the pipeline never invokes that IPC for destructive diffs.

## Real Problem Check

The claim is source-valid, but the critique overstates one mechanism: the initial `diff` stage does not apply a proposed diff by itself; it captures the already-written task result. That does not reduce the safety issue, because the later auto-pipeline stages and merge workflows can still normalize a destructive candidate as successful. Worktree isolation limits direct checkout damage, but it does not prevent destructive worktree branches from being approved, fixed, committed, or merged later.

P0 is justified by impact rather than frequency. The practical risk is unattended fan-out: one large deletion can be missed if the orchestrator is not tailing `PIPELINE` events or does not notice the numbers.

## Blast Radius

| Surface | Impact |
|---|---|
| Background task batches | Destructive diffs can sit behind a successful-looking pipeline result unless watched live. |
| Auto-review stage | Native review may miss size/destruction because no deterministic precondition feeds it. |
| Fix/check stages | They can proceed after a risky diff, adding more writes and making audit/recovery harder. |
| Worktree/merge flow | Worktree isolation reduces filesystem blast radius, but destructive branch content can still reach the main repo through later approval/merge. |
| Monitor users | Users must visually catch a raw diff stat; that is not a reliable safety property. |

## Dependencies / Overlaps

| Related item | Relationship | Scope decision |
|---|---|---|
| `12-P1-done-block-cumulative-vs-task-diff.md` | Shared observability concern: big cumulative numbers are easy to misread. | Reference only. This plan does not change cumulative diff rendering. |
| Worktree-auto default proposals | Reduces checkout damage but does not solve approval of destructive candidate branches. | Out of scope. |
| Hook/Monitor redesign docs | Could make warnings more prominent. | Out of scope. Default event exclusion already allows new tags through. |
| Config design docs | Destructive thresholds need schema-known config keys. | In scope only for the new flat keys and docs. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Root cause | Fix surface | Contract |
|---|---|---|---|
| Diff risk classification | No deterministic size/destruction classifier after `diff` | `src/adapters/codex/pipeline.mjs` | Diffs over configured deletion or file-count thresholds are classified before review/check/fix. |
| Approval pause | Pipeline does not pause high-risk diffs | `pipeline.mjs`, existing pending-request IPC | Destructive/wide diffs emit `[PIPELINE:diff:large_change]` and `[QUESTION]`, then wait for `respond`. |
| Config/docs/tests | Thresholds need runtime validation and user-visible defaults | `runtime-options.mjs`, `config.mjs`, `skill/config.yaml`, references, tests, generated bundles | Defaults are schema-known, documented, and generated output stays in sync. |

## Sequencing

1. Add focused tests for destructive diff timeout/rejection and approval continuation.
2. Add flat config keys: `destructive_diff_mode`, `destructive_diff_lines_deleted`, `destructive_diff_files_changed`.
3. Implement local diff classifier and pipeline gate immediately after `[PIPELINE:diff:done]`.
4. Reuse `writePendingRequest` / `waitForResponse` / `respond` payload format for approval.
5. Update config/reference docs and regenerate bundled skill/plugin outputs.
6. Run `npm run build`, `npm test`, fresh diff review, then commit.

## Per-Cluster Work Items

| Cluster | Files/modules likely touched | Behavior change | Verification |
|---|---|---|---|
| Diff risk classification | `src/adapters/codex/pipeline.mjs` | Parse captured file stats; classify `destructive` when deletions exceed threshold and `wide_blast` when changed files exceed threshold. | Unit test with a low deletion threshold and synthetic git diff. |
| Approval pause | `src/adapters/codex/pipeline.mjs`, `src/lib/pending-requests.mjs` via existing API, `src/lib/session-log.mjs` formatters via existing API | `pause` mode creates pending request, emits `[QUESTION]`, waits up to `question_answer_ms`; approval continues, rejection/timeout returns `[INCOMPLETE]`. | Tests assert no review/fix call before approval and review runs after approval. |
| Config/docs/tests | `src/lib/runtime-options.mjs`, `src/lib/config.mjs`, `skill/config.yaml`, `skill/references/config-reference.md`, notification references, generated `plugin/config.yaml`, bundled scripts | Users can tune or disable the guard with schema-known keys. | Config diagnostics test accepts defaults and rejects invalid enum/thresholds; build drift check via `npm run build`. |

## Risk + Rollback Notes

| Risk | Mitigation | Rollback |
|---|---|---|
| False positives pause legitimate large refactors. | Defaults target unusually destructive changes; users can set `destructive_diff_mode: "warn"` or `"ignore"` per workspace. | Revert the classifier/gate commit or set mode to `ignore`. |
| Background jobs wait for human input and appear stalled to naive callers. | Emit `[PIPELINE:diff:large_change]` and `[QUESTION]` with concrete `respond` commands; timeout returns `[INCOMPLETE]`. | Set mode to `warn`/`ignore` while investigating. |
| New config keys drift from shipped bundle. | Run `npm run build`; include generated `plugin/config.yaml` and bundled scripts. | Rebuild from source after reverting config source. |
| Event consumers filter only known pipeline tags. | Existing default is exclusion-based; docs warn against closed vocab filters. | Consumers can add the new tag or switch to `--exclude HEARTBEAT`. |

## Acceptance Criteria

| Case | Check |
|---|---|
| `03-P0-destructive-diff-not-flagged-or-paused.md` | A diff over `destructive_diff_lines_deleted` emits `[PIPELINE:diff:large_change]` plus `[QUESTION]`, does not call auto-review/fix before approval, and returns `[INCOMPLETE]` on rejection/timeout. |
| Approved destructive diff | Responding with the approve option emits `[PIPELINE:diff:approved]` and allows normal review/check continuation. |
| Config safety | Invalid destructive-diff mode or non-positive threshold is ignored with `CONFIG_INVALID_VALUE`; defaults remain active. |

## Out of Scope

- New `approve-diff` slash command or separate approval registry.
- Sensitive path glob matching for locks, migrations, schemas, or env files.
- Worktree default changes, merge policy changes, branch protection, or cleanup lifecycle.
- Monitor UI redesign, hook architecture redesign, or event filtering policy beyond documenting the new tag.
- Broader cases from `00-13`, `15`, or non-focus files under `14-real-world-failure-cases/`.
