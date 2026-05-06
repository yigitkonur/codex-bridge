# Result State Machine

The `.events` file is the authoritative terminal record for a job once it exists. `result --json` reads that event stream before falling back to worker status.

## Terminal Classification

| Event evidence | `adapterResult.terminalTag` | `adapterResult.phase` | `adapterResult.exitCode` |
|---|---:|---:|---:|
| `[DONE]` | `DONE` | `done` | `0` |
| `[PLAN]` | `PLAN` | `plan-pending` | `0` |
| `[ERROR]` | `ERROR` | `error` | `1` |
| `[INCOMPLETE]` | `INCOMPLETE` | `incomplete` | `1` |
| `[CANCELLED]` | `CANCELLED` | `cancelled` | `1` |
| later `[PIPELINE:failed]` after non-error terminal | `INCOMPLETE` | `incomplete` | `1` |
| events file exists with no terminal evidence | `UNKNOWN` | `error` | `1` |
| events file missing | worker-status fallback | worker-status fallback | worker-status fallback |

`[ERROR]` wins over `[PIPELINE:failed]` because it carries the concrete failure origin and details. A later `[PIPELINE:failed]` can override earlier non-error terminals such as `[DONE]`; this prevents post-turn pipeline failures from being reported as success.

## Consistency Fields

`adapterResult.workerExitCode` preserves the worker process signal. `adapterResult.consistent` is `false` when the event stream and worker status disagree, and `adapterResult.discrepancyReason` explains the split.

For orchestration, branch on `adapterResult.terminalTag` first. Treat `consistent:false` as a diagnostic warning that the worker lifecycle and event lifecycle diverged.
