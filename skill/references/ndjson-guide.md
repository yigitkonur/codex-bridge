# NDJSON Session Log Guide

**Read this before querying NDJSON files.**

## Scope

NDJSON captures a curated slice of the run — **not every wire-level notification.** Per-item deltas (`item/agentMessage/delta`, `item/reasoning/*Delta`, etc.) and the bare `thread/started` / `turn/started` events are not persisted. Finalized `item/completed` events **are** persisted (as `ITEM_COMPLETED`), with a truncated `text` field sufficient for transcript replay. NDJSON is for retrospective queries on turn outcomes, per-item completions, questions, pipeline stages, steers, and errors.

## Persisted tags

| Tag | When | Typical `data` fields | Writer |
|-----|------|------------------------|--------|
| `TURN_PARAMS` | Start of every Codex turn | `model`, `effort`, `collaborationMode`, `sandboxPolicy`, `hasOutputSchema`, `promptLength`, `promptPreview` | `src/codex-bridge.mjs::onTurnStart` |
| `TURN_COMPLETED` | End of every Codex turn | `turnId`, `status` (0/non-zero), `planDetected`, `touchedFiles` | `src/codex-bridge.mjs` |
| `ITEM_COMPLETED` | Every finalized item on the root thread | `itemId`, `itemType` (`agentMessage` \| `commandExecution` \| `fileChange` \| `plan` \| `reasoning` \| …), `text` (agentMessage ≤ 500 chars; commandExecution ≤ 200; fileChange = `"<op> <path>"`; plan = title / first line; otherwise `null`) | `runBridgeTask::onItemCompleted`, `handleSend::onItemCompleted` |
| `QUESTION` | `item/tool/requestUserInput` arrived | `requestId`, `questions` | `runBridgeTask::onServerRequest` |
| `CONFIRMED` | A pending question was answered via `respond` | `requestId` | `runBridgeTask::onServerRequest` |
| `QUESTION_TIMEOUT` | Question timed out (default 5 min); unanswered server request was rejected | `requestId` | `runBridgeTask::onServerRequest` |
| `SERVER_RESPONSE` | `respond` CLI delivered a payload | `requestId`, `payload` | `handleRespond` |
| `STEER` | `steer` CLI sent mid-turn guidance | `turnId`, `prompt` (120-char preview) | `handleSteer` |
| `ERROR` | Turn failed with a Codex-reported error (`will_retry: false`) | `errorCode`, `message`, `origin` (`turn` or `pipeline:<stage>`) | `src/codex-bridge.mjs` |
| `PIPELINE_STAGE` | Auto-pipeline entered a stage | `stage` ∈ `{diff, review, fix, check}`, optionally `findingCount` | `src/lib/auto-pipeline.mjs` |
| `PIPELINE_COMPLETE` | Auto-pipeline finished cleanly (on-disk counterpart to `[PIPELINE:done]`) | `completedStages`, `duration`, `complete`, `touchedFiles` (files the fix stage wrote) | `src/lib/auto-pipeline.mjs` |
| `PIPELINE_ERROR` | Auto-pipeline aborted (timeout / crash) | `completedStages`, `duration`, `error`, `origin` (`pipeline:<stage>`), `touchedFiles` | `src/lib/auto-pipeline.mjs` |
| `PIPELINE_SKIPPED` | Run launched with `--no-pipeline` (pipeline stages never ran) | `reason` (`"--no-pipeline flag"`) | `runBridgeTask` |
| `CIRCUIT_BREAKER` | Command-family circuit breaker tripped (on-disk counterpart to `[WARNING]`) | `family`, `threshold`, `windowSize`, `failsInWindow`, `wrapperDetected`, `turnInterrupted` | `runBridgeTask::onItemCompleted` |

`ITEM_COMPLETED` is emitted for `task` and `send` turns. The `runAppServerReview` path (standalone `review` / `adversarial-review`) does **not** emit it — review output goes to stdout and the rendered markdown instead.

Tags not listed above (`THREAD_STARTED`, `TURN_STARTED`, `ITEM_STARTED`, `PLAN`, `REVIEW_START`, `REVIEW_END`, `DIFF`, `TIMEOUT`, `NOTIFICATION`) are **not** written by the current bridge. Don't grep for them.

In practice, a completed non-interactive task often has `TURN_PARAMS` + several `ITEM_COMPLETED` + `TURN_COMPLETED` + `PIPELINE_STAGE*` + `PIPELINE_COMPLETE` (or `PIPELINE_ERROR`). Questions, steers, errors, and circuit-breaker trips are optional.

### Finding a `<turn-id>` for `steer`

The `steer` subcommand takes `<turn-id>` as a positional. Three ways to find it:

1. **`[PLAN]` notification line in `.events`** includes `{threadId} {turnId}` — parse the second UUID.
2. **`TURN_PARAMS` or `TURN_COMPLETED` NDJSON records** both carry `data.turnId`.
3. **Stderr progress** — a `Turn started (<turn-id>).` line is emitted when a turn begins (absent with `--quiet`).

## File layout

```
~/.codex-bridge/sessions/{threadId}.ndjson
```
Where `{threadId}` is a UUID v7 like `019d9a86-1c8a-7f41-8032-6c76bbe730a1` (not `thr_abc…`).

## Record schema

Each line is one JSON object:
```json
{
  "ts": "2026-04-17T08:22:14.940Z",
  "tag": "TURN_COMPLETED",
  "method": "turn/completed",
  "threadId": "019d9a86-1c8a-7f41-8032-6c76bbe730a1",
  "data": { "turnId": "...", "status": 0, "planDetected": false, "touchedFiles": [] }
}
```
`method` is `null` for locally-generated events (pipeline stages, steers, client-side errors, question-timeouts).

## Useful jq recipes

```bash
# Every turn's outcome
jq -r 'select(.tag == "TURN_COMPLETED") | "\(.ts[11:19]) turn=\(.data.turnId // "?") status=\(.data.status // "?") touched=\((.data.touchedFiles // []) | length)"' < session.ndjson

# What model / effort / mode each turn was started with
jq -r 'select(.tag == "TURN_PARAMS") | "\(.ts[11:19]) model=\(.data.model) effort=\(.data.effort) promptLen=\(.data.promptLength)"' < session.ndjson

# Pipeline timeline
jq -r 'select(.tag | test("^PIPELINE")) | "\(.ts[11:19]) \(.tag) \(.data.stage // .data.error // "")"' < session.ndjson

# Questions and their outcomes
jq 'select(.tag == "QUESTION" or .tag == "CONFIRMED" or .tag == "QUESTION_TIMEOUT" or .tag == "SERVER_RESPONSE")' < session.ndjson

# Errors (only written when will_retry is false)
jq 'select(.tag == "ERROR")' < session.ndjson

# Rebuild an assistant-text transcript (replay-friendly)
jq -r 'select(.tag == "ITEM_COMPLETED" and .data.itemType == "agentMessage") | "\(.ts[11:19]) \(.data.text)"' < session.ndjson

# Every shell command Codex ran
jq -r 'select(.tag == "ITEM_COMPLETED" and .data.itemType == "commandExecution") | "\(.ts[11:19]) $ \(.data.text)"' < session.ndjson

# Branch errors by origin (pipeline sub-stage vs main turn)
jq 'select(.tag == "ERROR" or .tag == "PIPELINE_ERROR") | {tag, origin: .data.origin, error: (.data.error // .data.message)}' < session.ndjson
```

## For detailed per-turn history

Use the `summary` command — it consolidates `.events`, `.ndjson`, and the diff file into a single markdown transcript:
```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs summary <thread-id> --tail 400
```

Or read the `.events` file directly:
```bash
less ~/.codex-bridge/sessions/<thread-id>.events
```

## NDJSON vs `.events`

| | `.ndjson` | `.events` |
|--|---------|---------|
| Content | Turn params + turn-end + questions + steers + errors + pipeline stages + circuit-breaker trips (see table above) | Actionable tags: `[DONE]` `[ERROR]` `[INCOMPLETE]` `[QUESTION]` `[PLAN]` `[CONFIRMED]` `[WARNING]` `[PIPELINE:diff\|review\|fix\|check]` plus `:done` pairs, terminal `[PIPELINE:done]` / `[PIPELINE:failed]`. (`[REVIEW]` and `[PHASE]` have helpers in `session-log.mjs` but no caller.) |
| Format | JSON objects, one per line | Human-readable text blocks |
| Use | Retrospective query (jq) | Monitor (`tail -f`) |
| Size | Small–medium (one per turn + one per question/steer/stage) | Small (4–12 blocks per task with 1.2.5 pipeline `:done` pairs) |
