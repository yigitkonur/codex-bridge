# 10-events-exclude-flag

**Derived from:** `src/codex-bridge.mjs::handleEvents` (filter/exclude parsing and predicate, v1.4.0), `src/lib/session-log.mjs::DEFAULT_MONITOR_EXCLUDE` (the `["HEARTBEAT"]` default), `src/lib/session-log.mjs::formatTailCommand` (produces the `--exclude HEARTBEAT` string used in every re-attach hint and in `buildMonitorHint`).

**What this catches:** The v1.4.0 exclusion contract — `events --follow --exclude HEARTBEAT` drops every `[HEARTBEAT]` block (header *and* its continuation lines) while passing every other tag, including `[CHECKPOINT]`, `[PIPELINE:*]`, and any tag the bridge emits that the orchestrator's code doesn't yet recognize. Pre-1.4.0 the default was inclusion-based (`--filter DONE,ERROR,INCOMPLETE,PLAN,QUESTION,PIPELINE,WARNING,HEARTBEAT,CHECKPOINT`) — any tag not on the list was silently dropped, the exact "nothing is happening" failure mode the 1.4.0 refactor targets.

**Runtime cost:** scenario 1 is fast (writes a fixture `.events` file, runs `events` with no Codex turn). Scenario 2 needs a live background task to observe the live-stream behavior end-to-end.

**Test subject:** scenario 1 works against any `.events` file containing mixed tags; scenario 2 requires a real `task --background` launch.

## Feature: `events --follow --exclude HEARTBEAT` drops heartbeats and passes everything else

### Background

Given the codex-bridge bundle is installed at `$SCRIPT_PATH`
And `codex-bridge version --json` reports `"version": "1.3.0"` or later

### Scenario 1: exclude-filter behavior on a synthetic events file

Given a `.events` file at `$SESSIONS_DIR/019abcdef-1234-7890-abcd-000000000001.events` containing:
```
[HEARTBEAT] 019abcdef-…-000000000001 t=1m | phase=execute | pid=1
  lastItem: commandExecution (age 5s)
  budget: 29m remaining
[CHECKPOINT] 019abcdef-…-000000000001 t=5m | phase=execute | interval=5m | pid=1
  assistant:
    working on this
  tools (1):
    - commandExecution: echo hi
[FUTURE_TAG_V15] synthetic test line
  second line of unknown block
[DONE] 019abcdef-…-000000000001 completed in 5m | 0 files
  actions:
    result: node x result job-1
```
And a state.json entry links job id `task-exclude-fixture` to that threadId

When I run `node $SCRIPT_PATH events task-exclude-fixture --follow --exclude HEARTBEAT --timeout-ms 2000`

Then stdout does NOT contain `[HEARTBEAT]`
And stdout does NOT contain `  lastItem: commandExecution (age 5s)` (continuation line of the excluded block)
And stdout DOES contain `[CHECKPOINT] 019abcdef-`
And stdout DOES contain `  tools (1):` (continuation line of the included block)
And stdout DOES contain `[FUTURE_TAG_V15] synthetic test line` (unknown tag passes through)
And stdout DOES contain `[DONE] 019abcdef-`
And the process exits 0 (terminated on `[DONE]`, not on `--timeout-ms`)

### Scenario 2 (live; stub): default Monitor hint exercises exclusion in a real task

Given `codex-bridge setup --json` reports `ready: true`

When I run `node $SCRIPT_PATH task --background --json --mode default "print one line then sleep 2"`
And I extract `.result.monitor.tool_hint.command` from the JSON envelope
And I run that command verbatim

Then the command string contains `--exclude HEARTBEAT`
And the command string does NOT contain `--filter`
And the stream emits at least one `[CHECKPOINT]` block (if the task runs ≥ 1 checkpoint interval) or at minimum a `[DONE]` terminal block
And the stream emits zero `[HEARTBEAT]` blocks
And the process exits 0

### Pass / fail predicate

Pass when scenario 1's stdout assertions hold and exit code is 0. Scenario 2 is SKIPPED unless a running Codex is available; when exercised, the predicate is "no `[HEARTBEAT]` in stdout AND at least one non-HEARTBEAT non-terminal tag AND terminal `[DONE]` / `[ERROR]` / `[INCOMPLETE]` at the end."
