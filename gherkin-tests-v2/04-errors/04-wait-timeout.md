# 04-wait-timeout

**Derived from:** `src/codex-bridge.mjs:1758-1805` (`wait` handler: resolves job by id or thread-id via `resolveResultJob` / `buildSingleJobSnapshot`, then reads `.events` for a terminal tag; `timeoutMs = Math.max(1000, Number(options["timeout-ms"]) || 600_000)`; throws `WAIT_TIMEOUT` class `timeout` retryable `true` when `waitForTerminalEvent` times out), `src/lib/cli-errors.mjs:22-30` (`timeout` class → exit 7; `not_found` class → exit 3), `src/lib/session-log.mjs:45-51` (`.events` append writer), `SKILL.md` "120 s idle watchdog" (separate from the wait deadline).
**What this catches:** (a) The guard that `wait` requires a *known, registered job* before it begins polling — passing a bogus id returns `JOB_NOT_FOUND` immediately, not a timeout. (b) The `WAIT_TIMEOUT` path (class `timeout`, exit 7, retryable `true`) which is only reachable with a real background job whose `.events` file exists but whose terminal tag has not yet arrived. (c) The 1000 ms lower-bound clamp on `--timeout-ms` (requires a live job to observe the timing).
**Runtime cost:** scenario 1 is fast (no Codex needed). Scenarios 2 and 3 are slow (require a live background job).
**Test subject:** scenario 1 uses a synthetic UUID; scenarios 2-3 require a real background task.

## Feature: `wait` enforces a job-presence check, then a clamped deadline with a retryable timeout error

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

And `npm run build` has been run since the last `src/` edit

### Scenario 1: bogus job id returns JOB_NOT_FOUND immediately (smokeable)

Given no job with id `00000000-0000-0000-0000-000000000000` exists in the job registry
When I run `bridge wait 00000000-0000-0000-0000-000000000000 --timeout-ms 1500 --json`
Then the envelope has `ok: false`
And `.error.code` equals `"JOB_NOT_FOUND"`
And `.error.class` equals `"not_found"`
And `.error.retryable` equals `false`
And the exit code is `3`
And the process returns almost immediately (the lookup is synchronous; no polling occurs)

Note: `WAIT_TIMEOUT` is NOT returned for a nonexistent job. The `wait` handler resolves the job first; an unknown reference throws before the `.events` polling loop ever begins.

### Scenario 2: wait deadline elapses before any terminal event (requires live Codex)

Given I launched a background task: `jobId=$(bridge task --background --write "write a haiku about watchdogs" --json | jq -r '.result.jobId')`
When I immediately run `bridge wait "$jobId" --timeout-ms 1500 --json`
Then on a machine where the first `[DONE]`/`[ERROR]`/`[INCOMPLETE]` event does not land within 1.5 s:
And the envelope has `ok: false`
And `.error.code` equals `"WAIT_TIMEOUT"`
And `.error.class` equals `"timeout"`
And `.error.retryable` equals `true`
And `.error.suggestion` mentions `status` as a follow-up
And the exit code is `7`

Note: this scenario is inherently racy. On a fast machine the terminal tag may arrive before 1.5 s, flipping the result to success. A runner should retry with a shorter prompt or a longer timeout, not call it flaky.

### Scenario 3: sub-1000 ms timeout is clamped to 1 second (requires live Codex)

Given the same background job is still running (or a fresh one)
When I run `bridge wait "$jobId" --timeout-ms 50 --json` and measure wall-clock duration
Then the wall-clock elapsed time is at least `1000` ms (the `Math.max(1000, …)` clamp at `src/codex-bridge.mjs:1791`)
And the envelope's `.error.code` is `"WAIT_TIMEOUT"` (not `JOB_NOT_FOUND` — the job exists and has a `.events` file)
And the exit code is `7`
And this pins that `--timeout-ms 0` or negative values cannot be used to turn `wait` into a non-blocking poll — use `status` for that

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }

# Scenario 1 — smokeable without Codex
bridge wait 00000000-0000-0000-0000-000000000000 --timeout-ms 1500 --json > /tmp/04.json 2>&1; rc=$?
jq -e '.ok == false and .error.code == "JOB_NOT_FOUND" and .error.class == "not_found"' /tmp/04.json \
  && test $rc -eq 3 \
  && echo "04-scenario1 PASS" || echo "04-scenario1 FAIL"

# Scenarios 2 and 3 — require live Codex background job:
# jobId=$(bridge task --background --write "write a haiku" --json | jq -r '.result.jobId')
# bridge wait "$jobId" --timeout-ms 1500 --json > /tmp/04b.json; rc=$?
# jq -e '.error.code == "WAIT_TIMEOUT" and .error.retryable == true' /tmp/04b.json && test $rc -eq 7
#
# start=$(python3 -c "import time; print(int(time.time()*1000))")
# bridge wait "$jobId" --timeout-ms 50 --json > /tmp/04c.json; rc=$?
# end=$(python3 -c "import time; print(int(time.time()*1000))")
# elapsed=$((end - start))
# jq -e '.error.code == "WAIT_TIMEOUT"' /tmp/04c.json && test $rc -eq 7 && test $elapsed -ge 1000
```

**Smoke result (2026-04-18):**
- Scenario 1 PASS: `bridge wait 00000000-... --timeout-ms 1500 --json` → exit 3, `JOB_NOT_FOUND`. Returns in ~114 ms. No timeout polling.
- Scenario 2 SKIPPED: requires live Codex background job.
- Scenario 3 SKIPPED: requires live Codex background job.

The previous version of this spec incorrectly assumed that a nonexistent job id would reach the polling loop and return `WAIT_TIMEOUT`. The actual behavior — `JOB_NOT_FOUND` before any polling — is the correct and intentional contract. `WAIT_TIMEOUT` is only reachable when a real job exists and its `.events` file has not yet received a terminal tag.

### Enhancement candidates

- If the clamp is removed (to allow non-blocking polls), scenario 3's timing assertion breaks — update it to assert `<50` ms return and document the new non-blocking contract.
- If `fs.watch` is replaced with a polling loop (for portability or to handle NFS), the timeout behavior must remain; this test does not care about the watch mechanism, only the timeout shape.
- A `--timeout-ms 0 => infinite` special case would also break scenario 3 and needs an explicit scenario.
- Pairs with `01-lifecycle/`'s idle-watchdog scenarios: the 120 s bridge-layer idle timeout is a different error path (synthesized `ClientTimeout` code from `cli-errors.mjs:171`); do not merge them.
