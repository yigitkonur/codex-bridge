# Result State Machine

`result <job-id> --json` answers one question: what terminal state did this job reach?

The answer is derived from the job's `.events` file when it exists. The worker process status is still reported as `workerExitCode`, but it is not the source of truth for `adapterResult.terminalTag`.

## Terminal Classification

| Last event evidence | `adapterResult.terminalTag` | `adapterResult.phase` | `adapterResult.exitCode` |
|---|---:|---:|---:|
| `[DONE]` | `DONE` | `done` | `0` |
| `[ERROR]` | `ERROR` | `error` | `1` |
| `[INCOMPLETE]` | `INCOMPLETE` | `incomplete` | `1` |
| `[PLAN]` | `PLAN` | `plan-pending` | `0` |
| `[PIPELINE:failed]` with no later terminal tag | `INCOMPLETE` | `incomplete` | `1` |
| Events file exists but has no terminal evidence | `UNKNOWN` | `error` | `1` |
| Events file is absent | worker-status fallback | stored job phase | worker-status exit |

Canonical terminal tags win over pipeline markers. A run that writes `[ERROR]` and later `[PIPELINE:failed]` is reported as `ERROR`, because `[ERROR]` is the terminal event and `[PIPELINE:failed]` is a pipeline closer.

## Consistency Fields

`adapterResult.consistent` is `true` when the events-derived terminal tag agrees with the worker-status implication. A typical clean run has:

```json
{
  "terminalTag": "DONE",
  "workerExitCode": 0,
  "consistent": true,
  "discrepancyReason": null
}
```

When the worker exits cleanly but a later pipeline stage fails, the events stream wins and the disagreement is explicit:

```json
{
  "terminalTag": "ERROR",
  "phase": "error",
  "exitCode": 1,
  "workerExitCode": 0,
  "consistent": false,
  "discrepancyReason": "events emitted [ERROR] but worker status implied [DONE] (workerExitCode=0)"
}
```

Tooling should branch on `adapterResult.terminalTag` first. When `consistent` is `false`, inspect `adapterResult.eventsPath`, `adapterResult.eventTerminalLine`, and the stored `pipeline` payload before deciding whether to retry the whole task or only rerun the failed pipeline stage.
