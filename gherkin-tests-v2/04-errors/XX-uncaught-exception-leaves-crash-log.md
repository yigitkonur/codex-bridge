# XX-uncaught-exception-leaves-crash-log

**Derived from:** `src/codex-bridge.mjs` top-level `process.on("unhandledRejection")` and `process.on("uncaughtException")` handlers write a JSON dump to `~/.codex-bridge/crashes/<ts>-<pid>.log` and emit a single stderr line pointing at the file before the process exits with non-zero. Added in 1.2.5 to close the "launcher exit 1 with no explanation, detached job still healthy" observability gap (the user's A3 suspicion attributed it to the circuit breaker; reading src/codex-bridge.mjs:1706-1754 shows the breaker only logs WARNING events and sets `turnInterrupted:false`, so it's not the real source — the diagnostic trap captures whatever the real source turns out to be).
**What this catches:** any future unhandled rejection / exception leaves a self-describing log file and a stderr breadcrumb; the trap does not swallow the crash (still exits non-zero), it just adds observability.
**Runtime cost:** fast; scenario fires an exception via a small Node probe.

## Feature: uncaught errors write a crash log and surface a pointer

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
CRASH_DIR="${HOME}/.codex-bridge/crashes"
```

### Scenario 1: unhandledRejection via a harness probe

Given I run a tiny Node probe that imports the bundle and then schedules `Promise.reject(new Error("harness-probe"))` immediately
When the process exits
Then a file `${CRASH_DIR}/<ISO-ts>-<pid>.log` exists
And its JSON contains `"kind": "unhandledRejection"`
And `error.message == "harness-probe"`
And the process stderr had a line beginning with `[codex-bridge] internal unhandledRejection: harness-probe — crash report at …`

### Scenario 2: log schema has the expected keys

Given a crash log file from scenario 1
Then the JSON has the keys `kind`, `ts`, `pid`, `argv`, `cwd`, `nodeVersion`, `bridgeVersion`, `error`
And `error` has `name`, `message`, `stack`, and optionally `code`
And `bridgeVersion` matches `package.json.version` (cross-check against the version-source-of-truth scenario)

### Scenario 3: trap does not swallow the exit code

Given a probe that forces an uncaughtException
Then the process still exits with a non-zero status (typically 1)
And the trap fires BEFORE exit — log file creation is visible after the process ends

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
CRASH_DIR="${HOME}/.codex-bridge/crashes"
mkdir -p "$CRASH_DIR"
before=$(ls "$CRASH_DIR" 2>/dev/null | wc -l)

# Force an unhandledRejection by invoking the bundled CLI with a deliberately
# bad option that triggers an async error path reachable pre-catch. Since the
# CLI's main() catches CliError correctly, the cleanest way to probe is via a
# sibling Node probe that imports and forces a rejection:
node -e "
  import('${REPO_ROOT}/skill/scripts/codex-bridge.mjs').catch(() => {});
  setImmediate(() => Promise.reject(new Error('harness-probe')));
  // Give the trap a tick to fire
  setTimeout(() => {}, 500);
" 2>/tmp/crash-stderr.txt
# (The bundled module installs its traps on import.)

after=$(ls "$CRASH_DIR" 2>/dev/null | wc -l)
if [ "$after" -gt "$before" ]; then
  echo "s1 PASS"
else
  echo "s1 FAIL (no new file)"
fi

grep -q 'internal unhandledRejection' /tmp/crash-stderr.txt && echo "s1-stderr PASS" || echo "s1-stderr FAIL"
```

### Enhancement candidates

- A retention policy (keep last N or last 30 days) would prevent the crash directory from growing unboundedly over time.
- If an uncaughtException fires during process exit, the file write may be best-effort only. Consider `process.stderr.write` first so at least the stderr trail exists even if file writing fails.
- If `$HOME` isn't writable (unusual), the trap silently swallows its own failure. Document this in a comment.
