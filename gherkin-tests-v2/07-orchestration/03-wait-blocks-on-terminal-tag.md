# 03-wait-blocks-on-terminal-tag

**Derived from:** `src/codex-bridge.mjs:1792` (`TERMINAL = /\[(DONE|ERROR|INCOMPLETE)\]/`), `src/codex-bridge.mjs:1794` (`waitForTerminalEvent(eventsPath, TERMINAL, timeoutMs)`), `src/codex-bridge.mjs:1808-1817` (envelope shape: `{jobId, threadId, terminalTag, lastEventLine, eventsPath, elapsedMs}`), `src/codex-bridge.mjs:1776-1786` (reference resolver accepts both job ids and thread UUIDs), `src/lib/session-log.mjs` (fs.watch + 500 ms polling fallback in `waitForTerminalEvent`), `skill/SKILL.md` "Blocking on terminal tags".
**What this catches:** A regression that restricts `wait` to job-ids-only (scenario 2 fails resolution). A regression that removes the "already-present terminal line" short-circuit — making `wait` hang up to 500 ms per poll even when the file is done — would show up as scenario-1 `elapsedMs` blowing past the budget. A new terminal tag being added upstream without updating the regex (e.g. `[CANCELLED]`) would be surfaced by an entirely separate `cancel` spec, but this file pins the current terminal set so additions are forced to be explicit.
**Runtime cost:** fast (no Codex turns; replays a previously-completed task's events file)
**Test subject:** a completed task from an earlier lifecycle scenario; the `.events` file already contains a `[DONE]`, `[ERROR]`, or `[INCOMPLETE]` line

## Feature: `wait` blocks until a terminal tag, accepts job id or thread id

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

Given `npm run build` has been run since the last `src/` edit

**Scenarios 1 and 2 require** a previously-completed task with `jobId == task-<abc>` and `threadId == <uuid>`, and its events file `$EVENTS` must already contain a terminal line whose tag is one of `DONE`, `ERROR`, `INCOMPLETE`. These are "requires live task" scenarios; skip them in fast CI.

**Error-path smoke (fast, no Codex needed):** passing a nonexistent id exits 3 with `error.code == "JOB_NOT_FOUND"` — verified by smoke test. The `--timeout-ms` value is irrelevant because the job lookup fails before the file watcher starts.

### Scenario: `wait <jobId>` returns immediately with the terminal tag and last line

**Requires live Codex task — runtime cost: fast (sub-second, short-circuits on pre-existing terminal line).**

When I run `bridge wait <jobId> --timeout-ms 600000 --json`
Then stdout is a single JSON envelope with `ok == true`
And `result.jobId == "<jobId>"` and `result.threadId == "<uuid>"`
And `result.terminalTag` is one of `"DONE"`, `"ERROR"`, `"INCOMPLETE"`
And `result.lastEventLine` starts with `"[" + result.terminalTag + "]"`
And `result.eventsPath == $EVENTS`
And `result.elapsedMs < 1000` (the watcher short-circuits on already-present terminal content)

### Scenario: `wait <threadId>` resolves to the same job and returns the same terminal tag

**Requires live Codex task — runtime cost: fast (sub-second).**

When I run `bridge wait <threadId> --timeout-ms 600000 --json`
Then stdout is a single JSON envelope with `ok == true`
And `result.jobId == "<jobId>"` (the thread-uuid path still resolves back to the original job)
And `result.terminalTag` and `result.lastEventLine` match scenario 1's values
And `result.elapsedMs < 1000`

### Scenario (error path, fast): nonexistent job id returns `JOB_NOT_FOUND`, exit 3

When I run `bridge wait 00000000-0000-0000-0000-000000000000 --timeout-ms 1500 --json`
Then the process exits 3
And stdout is a single JSON envelope with `ok == false`, `error.class == "not_found"`, `error.code == "JOB_NOT_FOUND"`
And the error does NOT have `error.code == "WAIT_TIMEOUT"` — the job lookup fails before the file watcher starts

**Smoke result (verified):** exit 3, `{"ok":false,"error":{"class":"not_found","code":"JOB_NOT_FOUND","message":"No job found for \"00000000-0000-0000-0000-000000000000\".",...}}`

### Pass / fail predicate

```sh
# Error-path scenario (fast, no live task needed)
bridge wait 00000000-0000-0000-0000-000000000000 --timeout-ms 1500 --json; rc=$?
test "$rc" = 3 && bridge wait 00000000-0000-0000-0000-000000000000 --timeout-ms 1500 --json \
  | jq -e '.ok==false and .error.class=="not_found" and .error.code=="JOB_NOT_FOUND"'

# Scenario 1 — by jobId (requires live task; set JOB_ID before running)
bridge wait "$JOB_ID" --timeout-ms 600000 --json \
  | jq -e '.ok==true
           and (.result.terminalTag | IN("DONE","ERROR","INCOMPLETE"))
           and (.result.lastEventLine | startswith("[" + .result.terminalTag + "]"))
           and .result.jobId == env.JOB_ID
           and .result.elapsedMs < 1000'

# Scenario 2 — by threadId, same job (requires live task; set THREAD_ID and JOB_ID)
bridge wait "$THREAD_ID" --timeout-ms 600000 --json \
  | jq -e '.ok==true
           and .result.jobId == env.JOB_ID
           and (.result.terminalTag | IN("DONE","ERROR","INCOMPLETE"))'
```

### Enhancement candidates

If upstream adds a `[CANCELLED]` or `[TIMEOUT]` terminal tag, `TERMINAL` in `codex-bridge.mjs:1792` must be updated in lockstep with `session-log.mjs`'s writer and `events --follow`'s own `TERMINAL` regex — this spec catches drift in `wait` but a sibling spec would be needed for `events`. A future enhancement could have `wait` emit a partial envelope on `WAIT_TIMEOUT` that still contains `lastEventLine` at the time of giving up; today it throws, which is why scenario 2 uses a generous `--timeout-ms`. The spec also doubles as a reconnect-after-crash contract: Claude sessions that lost their in-memory job state can still re-block on a terminal tag by passing just the thread UUID they logged earlier.
