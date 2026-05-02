# Phase 3 Context: Review Verdict And Iterate Loop

## Phase Scope

Phase 3 turns the existing review, auto-pipeline, verdict, merge, and iterate surfaces into a closed loop that users can trust. The phase starts from current source truth: native/adversarial review execution exists, auto-pipeline exists, verdict and approved-head merge are partially implemented, and `iterate` still returns a staged `not-yet-orchestrated` envelope.

The phase is complete only when users can run task-bound reviews, persist structured review artifacts, record branch-bound verdicts, merge only an approved unchanged reviewed head, and run `iterate` as real task -> review -> verdict -> follow-up orchestration or receive an explicit incomplete result with preserved artifacts.

## Requirements Covered

| Requirement | Phase 3 responsibility |
|---|---|
| REVW-01 | Native and adversarial review over working-tree or branch context produce structured actionable output. |
| REVW-02 | Auto-pipeline exposes review, conditional fix, check, budget, and partial-completion state explicitly. |
| REVW-03 | Verdicts can be recorded, pending verdicts can be inspected, and merge is allowed only for an approved unchanged reviewed branch head. |
| REVW-04 | `iterate` orchestrates task -> review -> verdict -> follow-up without manual assembly. |

## Source-Grounded Starting Point

- `src/codex-bridge.mjs` already has `executeReviewRun`, `handleReviewCommand`, `handleVerdict`, `handleMerge`, and `handleIterate`.
- `handleReviewCommand` currently supports `--base`, `--scope`, `--model`, `--cwd`, `--backend`, `--brief`, repeatable `--concern`, and review execution options, but no explicit `--task <task_id>` binding.
- `executeReviewRun` runs native review through `runAppServerReview` and adversarial review through `runAppServerTurn` with `src/schemas/review-output.schema.json`, but does not yet persist a normalized `review.json` artifact.
- `src/lib/registry.mjs` persists `meta.json`, `verdict.json`, and events; comments reserve `review.json`, but there are no `writeReview` or `readReview` helpers yet.
- `src/adapters/codex/pipeline.mjs` runs diff, review, optional fix, and completion-check stages with budgets. Invalid completion-check JSON currently has a false-positive path that can mark completion as true.
- `readVerdictPayloadFromStdin` exists in `src/codex-bridge.mjs`, but `handleVerdict` does not parse the `--payload-stdin` flag yet.
- `handleMerge` already requires an approved verdict and reviewed branch SHA match through `mergeSubagentBranch`; Phase 3 must make public verdict writing reliably provide that branch SHA.
- `handleIterate` currently returns `status: "not-yet-orchestrated"` and points the user at a manual workflow.
- `scripts/baseline-contracts.mjs` explicitly records the current `iterate` staged implementation as a Phase 3 baseline gap.
- `plugin/commands/verdict.md` advertises `--payload-stdin`, and `plugin/agents/codex-bridge-reviewer.md` instructs agents to use it, so implementation is behind the documented surface.

## Planning Decisions

| Decision | Rationale |
|---|---|
| D-01: Add explicit `--task <task_id>` to `review` and `adversarial-review`. | Task-bound review context should come from registry metadata, not positional text guessing. |
| D-02: Normalize all review output into a shared `review_result` shape. | Native review text and adversarial JSON need one artifact contract for verdicts, iterate, and future state recovery. |
| D-03: Persist task-bound review output as `review.json`. | Requirement STAT-03 is later, but Phase 3 needs stable artifacts to prove the review -> verdict link. |
| D-04: Treat invalid or inconclusive completion-check output as incomplete. | Auto-pipeline must fail closed; false-positive complete results break review-gated workflows. |
| D-05: Wire `verdict --payload-stdin` and preserve untrusted review text as JSON data. | Plugin and reviewer surfaces already promise this safer path. |
| D-06: Verdicts that enable merge must carry the reviewed branch head SHA. | Merge safety depends on comparing the approved head to the current branch head. |
| D-07: Replace the `iterate` staged envelope with a real orchestrator and explicit incomplete statuses. | REVW-04 requires actual loop orchestration, not a manual next-action hint. |
| D-08: Rebuild generated runtime bundles after source/plugin surface changes. | `skill/scripts/`, `plugin/scripts/`, prompts, schemas, templates, and config must stay generated from source. |

## Boundaries And Deferrals

- In scope: deterministic static tests, task-bound review context, normalized review artifacts, verdict stdin, approved-head merge proof, auto-pipeline completion-state proof, and `iterate` loop orchestration.
- In scope: generated runtime bundles when source files change.
- Out of scope: adding another backend, changing the app-server protocol, replacing Node's built-in test runner, or hand-editing generated runtime bundles.
- Deferred to Phase 6: authenticated live review smoke against a real Codex install.
- Deferred to future v2 scope: PR creation after local approval and multi-job monitor auto-arm.

## Execution Order

1. `03-01` defines and persists review-result contracts. It unblocks verdict and iterate because those flows need a stable review artifact.
2. `03-02` hardens auto-pipeline completion and partial-state reporting. It can run after `03-01` and may reuse shared review parsing.
3. `03-03` wires verdict stdin, branch-bound approval, merge proof, and `iterate`. It depends on `03-01` and benefits from `03-02` status contracts.
