# .events ↔ .ndjson tag mapping

`.ndjson` is canonical (rich JSON records). `.events` is a derived human-friendly tail view.

| `.events` tag | `.ndjson` tag(s) | Notes |
|---|---|---|
| `[DIRECTIVES]` | `TURN_PARAMS` | `.events` shows one-line summary; `.ndjson` carries full config object |
| `[QUESTION]` | `QUESTION` | Direct equivalent |
| `[CONFIRMED]` | `CONFIRMED` | Direct equivalent |
| `[CHECKPOINT]` | _(no .ndjson equivalent)_ | Liveness heartbeat written only to `.events` |
| `[HEARTBEAT]` | _(no .ndjson equivalent)_ | Progress indicator; excluded from monitor by default |
| `[PIPELINE:diff]` | `PIPELINE_STAGE` with `data.stage="diff"` | `.events` uses namespaced bracket syntax |
| `[PIPELINE:review]` | `PIPELINE_STAGE` with `data.stage="review"` | |
| `[PIPELINE:fix]` | `PIPELINE_STAGE` with `data.stage="fix"` | |
| `[PIPELINE:check]` | `PIPELINE_STAGE` with `data.stage="check"` | |
| `[PIPELINE:diff:done]` | `PIPELINE_STAGE` (stage-complete implied) | `:done` suffix marks stage exit |
| `[PIPELINE:review:done]` | `PIPELINE_STAGE` (stage-complete implied) | |
| `[PIPELINE:fix:done]` | `PIPELINE_STAGE` (stage-complete implied) | |
| `[PIPELINE:check:done]` | `PIPELINE_STAGE` (stage-complete implied) | |
| `[PIPELINE:done]` | `PIPELINE_COMPLETE` | Overall pipeline success |
| `[PIPELINE:failed]` | `PIPELINE_ERROR` | Overall pipeline failure |
| `[DONE]` | `TURN_COMPLETED` with `data.status=0` | Turn success |
| `[ERROR]` | `TURN_COMPLETED` (non-zero status) or `ERROR` | Turn failure |
| `[INCOMPLETE]` | _(no direct .ndjson tag)_ | Pipeline did not fully complete; check `PIPELINE_ERROR` |
| `[PARTIAL]` | _(no .ndjson tag)_ | Partial commit recovery block; paired with `[ERROR]` or `[HANDOFF]` |
| `[RETRYING]` | _(no .ndjson tag)_ | Retry attempt metadata |
| `[HANDOFF]` | _(no .ndjson tag)_ | Escalation to orchestrator |
| `[WARNING]` | `CIRCUIT_BREAKER` | Circuit breaker trip |
| `[PLAN]` | _(no .ndjson tag)_ | Plan presented for confirmation |
| `[REVIEW]` | _(no .ndjson tag)_ | Review result (formatter present, no caller currently) |
| `[PHASE]` | _(no .ndjson tag)_ | Phase event (formatter present, no caller currently) |
| _(no .events equivalent)_ | `ITEM_COMPLETED` with `data.itemType="reasoning"` and `data.text=null` | Suppressed in `.events` |
| _(no .events equivalent)_ | `STEER` | Steer payload logged to `.ndjson` only |
| _(no .events equivalent)_ | `QUESTION_TIMEOUT` | Timeout logged to `.ndjson` only |
| _(no .events equivalent)_ | `SERVER_RESPONSE` | Respond delivery logged to `.ndjson` only |
| _(no .events equivalent)_ | `PIPELINE_SKIPPED` | `--no-pipeline` flag logged to `.ndjson` only |

## Notes

- `.events` uses bracket tags (`[TAG]`) with human-readable text bodies.
- `.ndjson` uses ALLCAPS enum values in the `tag` field of a JSON object.
- Some `.events` blocks have no `.ndjson` counterpart (heartbeats, retrying, handoff) — they are diagnostics or recovery helpers that don't need to be machine-parsed.
- `ITEM_COMPLETED` reasoning items are logged to `.ndjson` but have `text=null`; they are intentionally omitted from `.events` to keep the tail view readable.

## Cross-references

- `event-schema.md` — per-tag specs + invariants
- `ndjson-guide.md` — query recipes and usage patterns
