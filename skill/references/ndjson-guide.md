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
jq -r 'select(.tag | test("TURN_|ITEM_COMPLETED|PIPELINE")) | "\(.ts[11:19]) \(.tag) \(.method // .data.stage // "")"' < session.ndjson

# All agent messages (full text)
jq -r 'select(.method == "item/completed" and .data.item.type == "agentMessage") | .data.item.text' < session.ndjson

# All file changes
jq 'select(.method == "item/completed" and .data.item.type == "fileChange") | .data.item.changes[].path' < session.ndjson

# All commands that ran
jq -r 'select(.method == "item/completed" and .data.item.type == "commandExecution") | "\(.data.item.command) (exit: \(.data.item.exitCode // "?"))"' < session.ndjson

# Questions and answers
jq 'select(.tag == "QUESTION" or .tag == "SERVER_RESPONSE")' < session.ndjson

# Pipeline stages and timing
jq -r 'select(.tag | test("PIPELINE")) | "\(.ts[11:19]) \(.tag) \(.data.stage // .data.completedStages // "")"' < session.ndjson
```

## Difference: NDJSON vs .events

| | .ndjson | .events |
|--|---------|---------|
| Content | Everything | Only actionable tags |
| Format | JSON objects | Human-readable text |
| Use | Retrospective analysis (jq) | Monitor (tail -f) |
| Size | Large (every notification) | Small (2-5 events per task) |
