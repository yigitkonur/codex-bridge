# 05-monitor-default-excludes-heartbeat

**Derived from:** `src/codex-bridge.mjs::buildMonitorHint` (v1.4.0 — returns an `events --follow --exclude HEARTBEAT --timeout-ms 1800000` CLI string and a `tool_hint` matching that shape), `src/lib/session-log.mjs::formatTailCommand` (single builder reused across `buildMonitorHint`, every `[HEARTBEAT]` re-attach hint, and every `[CHECKPOINT]` re-attach hint).

**What this catches:** The v1.4.0 Monitor contract bakes exclusion-filtering into every launch payload and every re-attach hint. An orchestrator pasting `result.monitor.tool_hint` verbatim gets the exclusion default (forward-compat). A pre-1.4.0 orchestrator that copy-pasted the inclusion-list default from docs got a closed-vocabulary filter that silently dropped tags added later — this test regression-guards against re-introducing that shape.

**Runtime cost:** trivial — one `task --help` / one `task --json` launch. Scenario 3 requires a real Codex for the live `tool_hint` end-to-end check.

## Feature: launch payload and re-attach hints use `--exclude HEARTBEAT` by default

### Background

Given the codex-bridge bundle is installed at `$SCRIPT_PATH`
And `codex-bridge version --json` reports `"version": "1.3.0"` or later

### Scenario 1: task synopsis documents --exclude

When I run `node $SCRIPT_PATH events --help`

Then stdout contains `[--filter <tags> | --exclude <tags>]`
And stdout does NOT contain the old `[--filter <tags>]` without `--exclude`

### Scenario 2: formatTailCommand emits exclusion by default

Given I import `formatTailCommand` from `./src/lib/session-log.mjs`

When I call `formatTailCommand({ scriptPath: "/abs/path/codex-bridge.mjs", jobId: "task-xyz" })`

Then the returned string contains `--exclude HEARTBEAT`
And the returned string does NOT contain `--filter`
And the returned string ends with `--timeout-ms 1800000`

### Scenario 3 (live; stub): task launch envelope contains exclusion-based tool_hint

Given `codex-bridge setup --json` reports `ready: true`

When I run `node $SCRIPT_PATH task --background --json --mode default "echo hello"`
And I parse the stdout JSON envelope

Then `.result.monitor.command` contains `--exclude HEARTBEAT`
And `.result.monitor.command` does NOT contain `--filter`
And `.result.monitor.tool_hint.command` matches `.result.monitor.command`
And `.result.monitor.exclude_tags` equals `["HEARTBEAT"]`
And `.result.monitor.terminal_tags` equals `["DONE", "ERROR", "INCOMPLETE"]`

### Pass / fail predicate

Pass when scenarios 1 + 2 pass unconditionally and scenario 3 passes when live Codex is available.
