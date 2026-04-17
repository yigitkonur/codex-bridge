# NDJSON Session Log Guide

**Read this before querying NDJSON files.**

## Scope

NDJSON captures a curated slice of the run — **not every wire-level notification.** `item/started` / `item/completed` / `item/delta` / `thread/started` / `turn/started` are **not** persisted. Per-item history (assistant messages, tool calls, reasoning, deltas) lives in the `.events` stream and in the `summary` command's output. NDJSON is for retrospective queries on turn outcomes, questions, pipeline stages, steers, and errors.

## Persisted tags

| Tag | When | Typical `data` fields | Writer |
|-----|------|------------------------|--------|
| `TURN_PARAMS` | Start of every Codex turn | `model`, `effort`, `collaborationMode`, `sandboxPolicy`, `hasOutputSchema`, `promptLength`, `promptPreview` | `src/codex-bridge.mjs::onTurnStart` |
| `TURN_COMPLETED` | End of every Codex turn | `turnId`, `status` (0/non-zero), `planDetected`, `touchedFiles` | `src/codex-bridge.mjs` (line ~1227) |
| `QUESTION` | `item/tool/requestUserInput` arrived | `requestId`, `questions` | `runBridgeTask::onServerRequest` |
| `CONFIRMED` | A pending question was answered via `respond` | `requestId` | `runBridgeTask::onServerRequest` |
| `QUESTION_TIMEOUT` | Question timed out (default 5 min); empty answer was sent | `requestId` | `runBridgeTask::onServerRequest` |
| `SERVER_RESPONSE` | `respond` CLI delivered a payload | `requestId`, `payload` | `handleRespond` |
| `STEER` | `steer` CLI sent mid-turn guidance | `turnId`, `prompt` (120-char preview) | `handleSteer` |
| `ERROR` | Turn failed with a Codex-reported error (`will_retry: false`) | `errorCode`, `message` | `src/codex-bridge.mjs` (line ~1257) |
| `PIPELINE_STAGE` | Auto-pipeline entered a stage | `stage` ∈ `{diff, review, fix, check}`, optionally `findingCount` | `src/lib/auto-pipeline.mjs` |
| `PIPELINE_COMPLETE` | Auto-pipeline finished cleanly | `completedStages`, `duration` | `src/lib/auto-pipeline.mjs` |
| `PIPELINE_ERROR` | Auto-pipeline aborted (timeout / crash) | `completedStages`, `duration`, `error`, optional `stage` | `src/lib/auto-pipeline.mjs` |

Tags not listed above (`THREAD_STARTED`, `TURN_STARTED`, `ITEM_STARTED`, `ITEM_COMPLETED`, `PLAN`, `REVIEW_START`, `REVIEW_END`, `DIFF`, `TIMEOUT`, `NOTIFICATION`) are **not** written by the current bridge. Don't grep for them.

In practice, a completed non-interactive task often has only `TURN_PARAMS` + `TURN_COMPLETED` + `PIPELINE_STAGE*` + `PIPELINE_COMPLETE` (or `PIPELINE_ERROR`). Questions, steers, and errors are optional.

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
| Content | Turn params + turn-end + questions + steers + errors + pipeline stages (see table above) | Actionable tags emitted today: `[DONE]` `[ERROR]` `[INCOMPLETE]` `[QUESTION]` `[PLAN]` `[CONFIRMED]` `[PIPELINE:diff|review|fix|check]`. (`[REVIEW]` and `[PHASE]` have helpers in `session-log.mjs` but no caller.) |
| Format | JSON objects, one per line | Human-readable text blocks |
| Use | Retrospective query (jq) | Monitor (`tail -f`) |
| Size | Small–medium (one per turn + one per question/steer/stage) | Small (2–5 blocks per task) |
