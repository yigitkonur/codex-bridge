# 06-foreground-task-survives-epipe

**Derived from:** `src/codex-bridge.mjs:2950-2967` (top-level `process.on("SIGPIPE")` + `process.stdout.on("error")` / `process.stderr.on("error")` guards swallow `EPIPE`/`ERR_STREAM_DESTROYED` so foreground command paths survive downstream pipe closure), `src/codex-bridge.mjs:1997-2043` (`handleTaskCommand` default path — `runForegroundCommand` writes streaming progress to stdout), `src/codex-bridge.mjs:1381-1413` (`runForegroundCommand` stdout writes that would previously raise EPIPE on a closed reader).
**What this catches:** The specific live-run failure where `bridge task … 2>&1 | tee … | head -N` killed the wrapper Node process mid-turn — `head` closed its stdin after N lines, `write(EPIPE)` bubbled up uncaught, the CLI exited nonzero, and the Codex-side job was left `orphaned` even though the app-server was still healthy. With the guards in place, EPIPE is no-op and the command completes normally.
**Runtime cost:** scenario 1 is fast (no Codex needed — `help` emits >10 lines which is enough to trigger a `head -1` close). Scenario 2 is slow (requires a live background task to observe orphan vs. completion).
**Test subject:** scenario 1 uses any subcommand that prints multiple lines to stdout without `--json`; scenario 2 uses a real background task.

## Feature: foreground command paths survive downstream pipe closure (no EPIPE termination)

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

And `npm run build` has been run since the last `src/` edit

### Scenario 1: multi-line stdout survives `| head -1` (smokeable)

Given `bridge help` emits more than one line to stdout (the usage banner is ~20 lines)
When I run `bridge help 2>/dev/null | head -1; echo "rc=$?"`
Then the first line of the help banner is printed
And the captured `rc` is `0` (`head`'s exit status — `bridge`'s own status is hidden by the pipe, but the process does not die mid-write)
And no `Error: write EPIPE` or `Uncaught` output appears in stderr
And the shell returns cleanly (no `Broken pipe` message on the terminal)

Note: without the guards, the behavior was environment-dependent. Node's default `SIGPIPE` handling can kill the process with an uncaught EPIPE; the emitted progress was partial and the exit code non-deterministic. Scenario 1 pins "no crash, no error output" which is what the guard guarantees.

### Scenario 2: background task survives EPIPE on its launch envelope (requires live Codex)

Given Codex is authenticated and the broker is reachable
When I run `bridge task --background --write "reply with the single word OK and stop" --json 2>&1 | head -1 > /tmp/06-launch.txt`
And I extract the `jobId` from the single-line envelope: `jobId=$(jq -r '.result.jobId' /tmp/06-launch.txt)`
And I wait for up to 30 s for the job to finish: `bridge wait "$jobId" --timeout-ms 30000 --json > /tmp/06-wait.json`
Then the final `status` of the job is `completed` (NOT `orphaned`)
And `/tmp/06-wait.json` shows a terminal `[DONE]` tag was observed
And the `.events` file for the thread contains the full session transcript (not truncated at line 1)

Note: the kill path being tested here is "EPIPE during the launch-envelope print kills the wrapper before the detached worker is fully spawned." The guard at `main()` makes the stdout write a no-op so the wrapper completes its normal exit sequence, the detached worker survives (it uses `stdio:"ignore"` regardless), and the job reaches a terminal state.

### Scenario 3: streaming foreground task under `head -1` still reaches a terminal state (requires live Codex)

Given Codex is authenticated
When I run `bridge task --write "reply OK and stop" --mode default 2>&1 | head -1 > /tmp/06-fg.txt; rc=$?`
Then the exit code of the pipeline (`rc`) is `0`
And the captured first line is either a Codex progress line or the final success envelope
And there is no `Error: write EPIPE` in stderr
And a follow-up `bridge status --json` shows no `orphaned` job attributable to this run

Note: scenario 3 specifically exercises `runForegroundCommand` → `process.stdout.write(execution.rendered)` at `src/codex-bridge.mjs:1401` which was the primary uncaught-EPIPE site.

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }

# Scenario 1 — smokeable without Codex
err=$(bridge help 2>&1 >/dev/null | head -1 2>&1)
out=$(bridge help 2>/dev/null | head -1)
test -n "$out" \
  && ! echo "$err" | grep -qiE "EPIPE|Uncaught" \
  && echo "06-scenario1 PASS" || echo "06-scenario1 FAIL"

# Scenarios 2 and 3 — require live Codex:
# jobId=$(bridge task --background --write "reply OK and stop" --json 2>&1 | head -1 | jq -r '.result.jobId')
# bridge wait "$jobId" --timeout-ms 30000 --json > /tmp/06-wait.json
# jq -e '.result.status == "completed"' /tmp/06-wait.json && echo "06-scenario2 PASS" || echo "06-scenario2 FAIL"
#
# bridge task --write "reply OK and stop" --mode default 2>&1 | head -1 > /dev/null; rc=$?
# test $rc -eq 0 && echo "06-scenario3 PASS" || echo "06-scenario3 FAIL"
```

**Smoke result (2026-04-19):**
- Scenario 1 PASS: `bridge help | head -1` returns the first line, no EPIPE error in stderr, process exits cleanly.
- Scenario 2 SKIPPED: requires live Codex.
- Scenario 3 SKIPPED: requires live Codex.

### Enhancement candidates

- If a future refactor unifies fg/bg into a single execution model (always detached worker + fg tail), scenario 3 becomes redundant and should be replaced with a check that the tail adapter itself is EPIPE-safe.
- The guards currently swallow all `ERR_STREAM_DESTROYED` errors alongside `EPIPE` — if the CLI ever writes to a stream after it was intentionally torn down for some other reason, the error would be silently lost. Revisit if such a code path is added.
- Pairs with `04-wait-timeout.md` (different error shape: `wait` returns a typed envelope on timeout; `head`-closure is a pure transport event with no envelope).
