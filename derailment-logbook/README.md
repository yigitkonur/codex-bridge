# Derailment Logbook

Records where the `codex-bridge` skill (SKILL.md + references) sent the executor off the rails when walking each `test-gherkin/*.feature` scenario using only the skill docs + the bundled `skill/scripts/codex-bridge.mjs`.

Tags per observation:

- `[STUCK]` — skill text stops being actionable, executor cannot continue
- `[GUESSED]` — skill didn't say; executor had to improvise
- `[BROKE]` — skill told executor to run X; X failed
- `[NICE]` — a sentence / example saved the executor from a mistake (keep it)

Harness: a small HTML/CSS/JS project lives at `.tmp/mini-site/`. Prompts point Codex at it to provoke authentic behavior.

Scope: sequential, no subagents. Executor is the primary Claude session.

## Index

| Feature | File(s) | Top finding |
|---|---|---|
| 01 task-lifecycle | 01-default-plan-sync-task.md · 02-events-and-ndjson-divergence.md · 03-task-cli-surface-checks.md | `--write` ignored under default `mode: plan`; 7 min wasted turn |
| 02 question-answer-flow | 01-respond-static-validation.md | Live-question scenarios unreachable from skill docs alone |
| 03 auto-pipeline | 01-pipeline-fix-contradiction.md | `[PIPELINE:fix]` documented but unreachable on default path |
| 04 notifications-and-events | 01-thread-id-format-mismatch.md · 02-ndjson-coverage-vs-docs.md | Thread IDs are UUIDs, not `thr_abc`; NDJSON writes only 3 tag families |
| 05 timeout-and-stuck-detection | 01-timeout-message-drift.md | "10 min stuck" in SKILL vs 120 s idle watchdog |
| 06 error-classification | 01-error-code-spec-drift.md | `TooManyRetries` / `NotSteerable` don't exist in source |
| 07 cli-commands | 01-send-thread-id-crash.md | `send thr_abc …` crashes to exit 1 with a raw UUID-parse error |
| 08 config-system | 01-config-tolerance-and-gaps.md | No CLI lever for mode; only `config.yaml` |
| 09 session-logging | 01-ndjson-coverage-master-record.md | Whole feature's tag palette is fiction |
| 10 protocol-compliance | 01-wire-level-spot-checks.md | Most scenarios not agent-verifiable; one open TODO in spec |

## Fixes applied

Minimal text edits to the skill, applied in this pass:

- `skill/SKILL.md` — sync-path pipeline warning; `codex-bridge` shorthand substitution note; `--write` in plan-mode heads-up; thread-id format correction (UUID, not `thr_`); idle-watchdog timeout correction; `[ERROR]` ambiguity note; heartbeat parameterized on `$BASE_REF`; phase enum trimmed to `{plan-pending, done, incomplete}` with error-envelope note; `result`/`status`/`cancel` take **job** ids only (not thread ids); Session Files narrowed to the four artifacts actually produced today (`.events`, `.ndjson`, `.diff`, `.plan.md`) with an explicit "`.review.json`, `[REVIEW]`, `[PHASE]` have writer helpers but no caller" note.
- `skill/references/ndjson-guide.md` — rewritten to list the real writer vocabulary (`TURN_PARAMS`, `TURN_COMPLETED`, `QUESTION`, `CONFIRMED`, `QUESTION_TIMEOUT`, `SERVER_RESPONSE`, `STEER`, `ERROR`, `PIPELINE_STAGE`, `PIPELINE_COMPLETE`, `PIPELINE_ERROR`) with source pointers; called out upstream wire tags the bridge does not persist; NDJSON-vs-events table's `.events` content row scoped to tags actually emitted (no `[REVIEW]`).
- `skill/references/notification-format.md` — `[ERROR]` pipeline-origin caveat; `[PIPELINE:fix]` rarity note; raw `codexErrorInfo` variants documented; `[REVIEW]` and `[PHASE]` blocks relabeled "reserved — not emitted by the current build" (helpers exist, no caller).
- `skill/references/command-reference.md` — `review` billed-turn warning; `task` lacks `--mode`; UUID thread-id note; added `ResponseTooManyFailedAttempts → internal/exit 1` and `ActiveTurnNotSteerable/Other` fall-through rows to the `codexErrorInfo` table.
- `skill/references/error-recovery.md` — timeout table annotated with source-of-truth constants (`STAGE_TIMEOUT_MS = 300_000` ms, `PIPELINE_TIMEOUT_MS = 900_000` ms, `idleTimeoutMs = 120_000` ms); completion check correctly shown as 5 min per stage; **corrected** `ResponseTooManyFailedAttempts` row from `dependency_failed/7` to `internal/1` to match `cli-errors.mjs`; added fall-through row; millisecond message-format note.
- `skill/references/orchestration-flows.md` — sync path now documents pipeline inclusion and envelope semantics; dropped the `phase:error` row from the branches table (unreachable — failures return `ok:false` instead).
- `skill/references/monitor-patterns.md` — idle-watchdog interaction with Monitor timeout.

Not fixed in this pass (require source changes or out-of-scope):

- `send <not-a-uuid>` → exit 1 `INTERNAL_ERROR` with leaky parser message. Needs `handleSend` input validation.
- NDJSON coverage gap vs `Scenario Outline: Notifications map to correct NDJSON tags`. Needs either writer changes or Gherkin rewrite.
- `task-resume-candidate` returns cancelled jobs as available. Needs filter in `handleTaskResumeCandidate`.
- Gherkin 01/02/…/10 still use `thr_abc` placeholders; real thread IDs are UUIDs. Left as-is — placeholders remain syntactic.
- Gherkin `Scenario: task with --wait runs synchronously` — flag doesn't exist; should be deleted.
- Gherkin `Scenario: Task accepts file as prompt` — `task file.md` is sent as literal text; should be deleted or replaced with `--prompt-file`.
