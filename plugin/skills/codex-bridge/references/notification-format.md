# Notification format — judgment

The event command contract lives at `events --help`; this file covers the *judgment* — when each tag matters for orchestration.

## Two semantic buckets

- **Interrupts** — act now: `[QUESTION]`, `[PLAN]`, `[DONE]`, `[ERROR]`, `[INCOMPLETE]`. Monitor self-terminates on terminal interrupts ([DONE]/[ERROR]/[INCOMPLETE]).
- **Progress** — periodic scan: `[CHECKPOINT]`, `[HEARTBEAT]`, `[PIPELINE:*]`, `[WARNING]`, `[CONFIRMED]`, `[RETRYING]`, `[HANDOFF]`, `[PARTIAL]`. Safe to batch-process; never terminal except `[PIPELINE:done]` which closes the pipeline only.

## Why `[ERROR]` is ambiguous

The events-file `[ERROR]` fires for any turn-level failure, including a sub-stage timeout. The same run's sync envelope can still report `ok:true` with `result.phase: "incomplete"` and `result.pipeline.error` populated. Don't infer "task failed" from `[ERROR]` alone — read the envelope's `result.phase` and `error.origin` first.

## Forward-compat rule

Default Monitor invocation is `--exclude HEARTBEAT` (not `--filter X,Y,Z`). Reason: any new tag a future bridge version emits passes through automatically. An inclusion-based filter silently drops unknown tags. Keep `--exclude` patterns; don't switch to `--filter` unless you specifically want a closed vocabulary.

## Don't pattern-match stderr

The `[codex] Thread ready (019d…)` progress line in stderr is a UUID — it's a `threadId`, not a `task_id`. Pattern-matching it and using it as a job handle is the single most common derailment. The `--json` envelope's `result.jobId` is canonical; the rendered footer's `Job:` field is the same value.
