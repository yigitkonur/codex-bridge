# XX-events-json-final-envelope

**Derived from:** `src/codex-bridge.mjs::handleEvents` (follow-mode) captures the terminal tag line in the stream-scanner and emits it on the closing envelope as `.result.terminalTag`, `.result.terminalLine`, and `.result.elapsedMs`. Pre-1.2.5 the envelope only carried `timedOut` (boolean), so Monitor / orchestrators could not distinguish happy-path [DONE] from [ERROR] / timeout without re-reading the events file.
**What this catches:** final envelope of `events --follow --json` carries the tag-name (DONE / ERROR / INCOMPLETE) when the stream closed on a terminal line, and `null` when the stream closed on timeout. `elapsedMs` is always a non-negative integer. `eventsPath` is present at top level for easy jq extraction.
**Runtime cost:** scenario 1 is smokeable via a synthetic `.events` file (no Codex); scenario 2 requires a live background task.

## Feature: `events --follow --json` closes with a typed terminal-tag envelope

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

### Scenario 1: terminal-tag reported on happy-path close (smokeable via synthetic events file)

Given a synthetic job record with `status:"completed"`, `threadId:"00000000-0000-0000-0000-000000000001"`, and a sibling `.events` file containing `[DONE] 00000000-… completed in 1s | 0 files | +0 -0`
When I run `bridge events <jobId> --follow --filter DONE --timeout-ms 2000 --json`
Then `.ok == true`
And `.result.terminalTag == "DONE"`
And `.result.terminalLine` starts with `"[DONE] "`
And `.result.timedOut == false`
And `.result.elapsedMs` is a non-negative integer

### Scenario 2: null terminalTag on timeout (requires live job)

Given a live background task whose events file has received `[PIPELINE:diff]` but not yet a terminal tag
When I run `bridge events <jobId> --follow --timeout-ms 1500 --json`
Then `.result.timedOut == true`
And `.result.terminalTag` is `null`
And `.result.elapsedMs` is between 1400 and 2000 (follow waited for the timeout)
And the exit code is `0` under `--json` (the error envelope path was 1.2.4 behavior for non-JSON; JSON returns a success envelope so a caller can switch on fields)

### Scenario 3: jobId / threadId resolution regression guard (from 1.2.4 fix)

Given a still-running job
When I run `bridge events <threadId> --follow --filter PIPELINE --timeout-ms 1500 --json`
Then the command does NOT return `JOB_NOT_FOUND` (the 1.2.4 thread-id fix holds)
And the final envelope carries `.result.jobId` and `.result.threadId`

### Pass / fail predicate

Scenario 1 requires seeding a synthetic events+state combo; scenarios 2+3 require live Codex. Documented as SKIPPED stubs pending a scenario runner that can mock job files.

### Enhancement candidates

- A `--deadline-ms` alias for `--timeout-ms` to match the internal `DEFAULT_FOLLOW_MS` naming would reduce confusion.
- When `timedOut:true`, include `.result.lastEventAt` (timestamp of the most recent non-terminal event) so orchestrators can tell whether the file is still alive or fully quiet.
