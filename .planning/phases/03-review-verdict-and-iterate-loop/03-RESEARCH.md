# Phase 3 Research: Review Verdict And Iterate Loop

## Research Summary

The repo already has most primitives for the review loop, but they are not connected into one trustworthy user path. The strongest risks are contract drift between documented plugin surfaces and CLI implementation, false-positive completion in auto-pipeline, unpersisted review artifacts, and `iterate` advertising a command that does not yet orchestrate.

The implementation should be source-first and test-backed:

- add shared review-result normalization under `src/lib/`;
- extend registry helpers for `review.json`;
- bind reviews to task metadata with explicit `--task`;
- make auto-pipeline fail closed on invalid completion checks;
- wire stdin verdict payloads and reviewed branch SHA persistence;
- replace staged `iterate` with a deterministic loop helper that can be tested without live Codex.

## Current Review Behavior

Native review is already routed through the Codex adapter via `runAppServerReview`. Adversarial review is already routed through `runAppServerTurn` with a JSON schema. The gap is not whether review can run; the gap is that downstream commands do not receive a durable, normalized artifact with review kind, findings, summary, target, task id, and reviewed branch head.

Implementation guidance:

- create `src/lib/review-result.mjs` instead of scattering parsing in CLI and pipeline code;
- normalize native markdown findings and adversarial JSON findings into one `review_result`;
- preserve original review text or raw model output in a data field for audit, but keep rendered CLI output concise;
- store task-bound review artifacts through `writeReview(taskId, reviewResult)`.

## Current Registry Behavior

`src/lib/registry.mjs` is already the right home for task artifacts. It validates task IDs, creates per-task directories, writes JSON atomically, timestamps controlled records, and has tests for corrupt JSON handling. Adding review helpers should follow the existing `writeMeta/readMeta` and `writeVerdict/readVerdict` shape.

Implementation guidance:

- `writeReview(taskId, review)` should reject non-object payloads and write `review.json`;
- `readReview(taskId)` should return `null` when absent and throw `RegistryReadError` on corrupt JSON;
- store registry-controlled `schema_version` and `ts`;
- add registry tests mirroring verdict tests.

## Current Auto-Pipeline Behavior

`src/adapters/codex/pipeline.mjs` already tracks completed stages, failing stage, fix-stage touched files, event logs, and per-stage/total budgets. It includes a current false-positive risk: if completion-check returns invalid JSON, the catch block can set `complete: true`.

Implementation guidance:

- invalid completion-check JSON must produce `complete: false`;
- `completionSummary` should be deterministic, for example `completion-check invalid-json`;
- `missing_items` should contain an actionable explanation with the parse error;
- check-stage failure should still preserve completed stages, budget values, and artifact state.

## Current Verdict And Merge Behavior

`handleMerge` already enforces the right safety model: verdict must exist, verdict must be approved, and the branch head must match the approved reviewed head. The public path into that safety model is incomplete because `--payload-stdin` is advertised but not parsed, and `--set` does not capture branch SHA fields.

Implementation guidance:

- parse boolean `payload-stdin` in `handleVerdict`;
- reject conflicting modes such as `--payload-stdin` with `--set` or `--discard`;
- accept `branch_head_sha`, `reviewed_branch_head_sha`, or `branchHeadSha`, normalize to one stored field, and validate a 40-character hex SHA;
- preserve untrusted review text and finding text as JSON data, never as shell command text;
- extend `verdicts --pending` output to make approval/merge readiness visible.

## Current Iterate Behavior

`handleIterate` is intentionally staged. Phase 3 should introduce an internal orchestration helper so tests can drive the loop without launching a real Codex app-server.

Implementation guidance:

- `runIterateLoop` should accept dependency-injected task, review, verdict, and follow-up runners for tests;
- prompt input should start a worktree-backed task with write enabled;
- task-id input should resume from registry metadata and verdict state;
- every iteration should persist or read a review artifact, write a verdict, and either approve, launch follow-up, or return explicit incomplete state;
- result statuses should be concrete, for example `approved`, `needs-attention`, `must-fix`, `iteration-limit`, `task-failed`, `review-failed`, or `verdict-failed`;
- the old `not-yet-orchestrated` status should disappear from runtime tests and baseline coverage.

## Verification Strategy

Minimum verification for Phase 3 execution:

- focused unit tests for review-result normalization;
- registry tests for `review.json`;
- plugin-surface tests for `--task`, `--payload-stdin`, and non-staged `iterate`;
- auto-pipeline tests for invalid completion-check JSON and explicit partial state;
- git worktree tests for approved-head merge drift rejection using public verdict payloads;
- static baseline contracts updated to remove the `iterate` staged gap only after orchestration is real;
- `npm run build`;
- `npm run verify:static`.

Authenticated review smoke remains Phase 6 and must not be claimed from static tests.
