# NDJSON Session Log Guide

**Read this before querying NDJSON files.**

## File Location

```
~/.codex-bridge/sessions/{threadId}.ndjson
```

## Record Schema

Each line is one JSON object:
```json
{
  "ts": "2026-04-16T10:23:01.234Z",
  "tag": "ITEM_COMPLETED",
  "method": "item/completed",
  "threadId": "thr_abc123",
  "data": { ... }
}
```

## Common Tags

| Tag | Meaning |
|-----|---------|
| `THREAD_STARTED` | Thread created |
| `TURN_STARTED` | Turn began |
| `TURN_COMPLETED` | Turn finished |
| `ITEM_STARTED` | Item work began |
| `ITEM_COMPLETED` | Item work finished |
| `ERROR` | App-server error |
| `QUESTION` | Codex asked a question |
| `CONFIRMED` | Question response confirmed |
| `PLAN` | Plan detected |
| `PIPELINE_STAGE` | Auto-pipeline stage |
| `PIPELINE_COMPLETE` | Auto-pipeline finished |
| `STEER` | Mid-turn steer sent |
| `SERVER_RESPONSE` | We responded to a server request |

## jq Query Examples

```bash
# All errors
jq 'select(.tag == "ERROR")' < session.ndjson

# Timeline of significant events
jq -r 'select(.tag | test("TURN_|PIPELINE")) | "\(.ts[11:19]) \(.tag) \(.method // .data.stage // "")"' < session.ndjson

# Turn parameters (what was sent to Codex per turn)
jq -r 'select(.tag == "TURN_PARAMS") | "\(.ts[11:19]) model=\(.data.model) effort=\(.data.effort) promptLen=\(.data.promptLength)"' < session.ndjson

# Turn completion summaries
jq -r 'select(.tag == "TURN_COMPLETED") | "\(.ts[11:19]) turn=\(.data.turnId // "?") status=\(.data.status // "?") touchedFiles=\((.data.touchedFiles // []) | length)"' < session.ndjson

# Questions and answers (interactive flow)
jq 'select(.tag == "QUESTION" or .tag == "CONFIRMED" or .tag == "STEER" or .tag == "SERVER_RESPONSE")' < session.ndjson

# Pipeline stages and timing
jq -r 'select(.tag | test("PIPELINE")) | "\(.ts[11:19]) \(.tag) \(.data.stage // .data.completedStages // "")"' < session.ndjson

# For a readable transcript with assistant messages, commands, and file changes:
node skill/scripts/codex-bridge.mjs summary <threadId> --tail 200
```

**Note:** the bridge does **not** persist `item/completed` notifications into `.ndjson` — only the tagged entries listed in the Tag Reference above. For assistant text / command execution / file change details, use `summary` (which reads the `.events` timeline and the diff file), or consult the full text of `.events` directly.

## Difference: NDJSON vs .events

| | .ndjson | .events |
|--|---------|---------|
| Content | Everything | Only actionable tags |
| Format | JSON objects | Human-readable text |
| Use | Retrospective analysis (jq) | Monitor (tail -f) |
| Size | Large (every notification) | Small (2-5 events per task) |
