# Codex-bridge event schema reference

## Source of truth

`.ndjson` is canonical. `.events` is a derived human-friendly tail view.
The bridge regenerates `.events` from `.ndjson` if needed.

The canonical event shape (schema version 1.0):

```json
{"schema_version":"1.0","ts":"2026-01-01T00:00:00.000Z","tag":"DONE","method":"turn/completed","threadId":"019d...","data":{}}
```

Shared top-level fields are stable across all tags. The `data` object is
tag-specific and forward-compatible (unknown keys are ignored by older readers).

## Event tags (.ndjson)

### TURN_PARAMS

Fired once at turn start. Records the resolved configuration.

Fields:
- `ts` (ISO timestamp): when emitted
- `tag` (string): `"TURN_PARAMS"`
- `method` (string): `"turn/start"`
- `threadId` (UUID): the Codex thread id
- `data` (object):
  - `model` (string): resolved model
  - `effort` (enum): `low|medium|high|xhigh`
  - `collaborationMode` (object): mode + per-stage settings
  - `sandboxPolicy` (object): `{type: "readOnly|workspaceWrite|dangerFullAccess"}`
  - `hasOutputSchema` (boolean)
  - `promptLength` (number): character count
  - `promptPreview` (string): first 120 chars

### TURN_COMPLETED

Fired when the Codex turn ends.

Fields in `data`:
- `turnId` (string): turn UUID
- `status` (number): 0 = success, non-zero = failure
- `planDetected` (boolean)
- `touchedFiles` (string[])

### ITEM_COMPLETED

Fired for each finalized item Codex produced. `data.itemType` discriminates:

- `agentMessage` — `text` ≤ 500 chars
- `commandExecution` — `text` ≤ 200 chars
- `fileChange` — `text = "<op> <path>"`
- `plan` — `text = title / first line`
- `reasoning` — `text = null` (suppressed)

### QUESTION

Fired when `item/tool/requestUserInput` arrived.

Fields in `data`:
- `requestId` (string)
- `questions` (array)

### CONFIRMED

Fired when a pending question was answered via `respond`.

Fields in `data`:
- `requestId` (string)

### QUESTION_TIMEOUT

Fired when a question timed out (default 5 min).

Fields in `data`:
- `requestId` (string)

### SERVER_RESPONSE

Fired when `respond` CLI delivered a payload.

Fields in `data`:
- `requestId` (string)
- `payload` (object)

### STEER

Fired when `steer` CLI sent mid-turn guidance.

Fields in `data`:
- `turnId` (string)
- `prompt` (string): 120-char preview

### ERROR

Fired on turn failure (`will_retry: false`).

Fields in `data`:
- `errorCode` (string)
- `message` (string)
- `origin` (string): `"turn"` or `"pipeline:<stage>"`

### PIPELINE_STAGE

Fired when the auto-pipeline entered a stage.

Fields in `data`:
- `stage` (enum): `diff|review|fix|check`
- `findingCount` (number, optional)

### PIPELINE_COMPLETE

Fired when the auto-pipeline finished cleanly.

Fields in `data`:
- `completedStages` (string[])
- `duration` (number): ms
- `complete` (boolean)
- `touchedFiles` (string[])

### PIPELINE_ERROR

Fired when the auto-pipeline aborted.

Fields in `data`:
- `completedStages` (string[])
- `duration` (number): ms
- `error` (string)
- `origin` (string): `"pipeline:<stage>"`
- `touchedFiles` (string[])

### PIPELINE_SKIPPED

Fired when `--no-pipeline` was used.

Fields in `data`:
- `reason` (string): `"--no-pipeline flag"`

### CIRCUIT_BREAKER

Fired when the command-family circuit breaker tripped.

Fields in `data`:
- `family` (string)
- `threshold` (number)
- `windowSize` (number)
- `failsInWindow` (number)
- `wrapperDetected` (boolean)
- `turnInterrupted` (boolean)

## Invariants

- Every job emits exactly one terminal event: `TURN_COMPLETED` (status 0 = success, non-zero = failure), `ERROR`, or at session-log level one of `DONE|ERROR|INCOMPLETE` in `.events`.
- `QUESTION` is always paired with `CONFIRMED`, `QUESTION_TIMEOUT`, or session abort.
- `PIPELINE_STAGE` is always followed by `PIPELINE_COMPLETE` or `PIPELINE_ERROR` for the same stage.
- Timestamps (`ts`) are monotonically non-decreasing within a single thread.
- `method` is `null` for locally-generated events (pipeline stages, steers, question-timeouts, circuit-breaker).

## Versioning

`schema_version` is recorded in every NDJSON line (added in v2.2.0). Current version: `"1.0"`. Breaking changes bump the major version; additive `data` fields are minor changes.

## Cross-references

- `ndjson-guide.md` — query recipes and usage patterns
- `tag-mapping.md` — `.events` tag ↔ `.ndjson` tag mapping
