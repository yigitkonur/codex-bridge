# 04-idle-timeout-configurable

**Derived from:** `src/lib/config.mjs::DEFAULT_CONFIG` (adds `idle_timeout_ms: 300_000` — 300s default replaces prior 120s hard-code), `src/codex-bridge.mjs::runBridgeTask` around the `idleTimeoutMs` field of `bridgeRequest` (resolution order: `request.idleTimeoutMs` → `config.idle_timeout_ms` → `300_000`), `src/codex-bridge.mjs::handleSend` around the same `idleTimeoutMs` field of `turnOptions` (mirrors the `task` path), `src/codex-bridge.mjs::parseIdleTimeoutMsOption` (validates the CLI flag — non-positive or non-numeric values throw `usage`, not silent fallback), `src/lib/codex.mjs::captureTurn` (the consumer of `idleTimeoutMs`), `src/lib/cli-errors.mjs:169-180` (synthesizes `ClientTimeout` class `timeout` retryable `true` when `/No events received for \d+s/` matches).
**What this catches:** (a) The CLI flag `--idle-timeout-ms <ms>` is plumbed through `task` and `send` and reaches `captureTurn`'s watchdog. (b) A malformed `--idle-timeout-ms` value is surfaced as a usage error before a Codex turn is spent, not silently dropped. (c) The default threshold is 300s (not the legacy 120s) so reasoning-heavy turns no longer false-positive.
**Runtime cost:** scenario 1 is fast (usage-error path, no Codex). Scenarios 2 and 3 require a live background task and up to 6 s of elapsed time to observe the threshold.
**Test subject:** scenario 1 is synthetic; scenarios 2-3 require a real background task whose Codex turn can be held silent (e.g. a prompt that triggers long reasoning before any command).

## Feature: idle-watchdog threshold is configurable per-invocation, per-project, and per-install

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

And `npm run build` has been run since the last `src/` edit

### Scenario 1: malformed `--idle-timeout-ms` is a usage error (smokeable)

Given I attempt to launch a task with a non-numeric idle-timeout value
When I run `bridge task --idle-timeout-ms notanumber "echo ok" 2>&1`
Then the output contains `--idle-timeout-ms must be a positive number of milliseconds`
And the exit code is `2` (usage error)
And no Codex turn is billed (the validation runs before any bridge orchestration)

Also when I run `bridge task --idle-timeout-ms 0 "echo ok" 2>&1`
Then the same usage error is produced (zero is rejected; only strictly-positive values are accepted)

And `bridge send 00000000-0000-0000-0000-000000000000 --idle-timeout-ms -1 "x" 2>&1`
Produces the same usage error (the flag is validated on `send` too)

### Scenario 2: short `--idle-timeout-ms` fires the watchdog deterministically (requires live Codex)

Given Codex is authenticated
When I launch a background task with a short idle timeout and a prompt that forces a long single-command exec: `jobId=$(bridge task --background --idle-timeout-ms 3000 --write "run: sleep 6; echo done" --mode default --json | jq -r '.result.jobId')`
And I wait for it to finish: `bridge wait "$jobId" --timeout-ms 30000 --json > /tmp/04-idle.json`
Then the resulting envelope reports the idle-timeout failure path
And the `.events` file contains `No events received for 3s (idle timeout).`
And the job's final `status` is `failed` with an error whose `.code` is `ClientTimeout`
And the `.class` is `timeout` and `.retryable` is `true`
And the exit code (on the `wait` call) is `0` (wait observed a terminal tag — `[ERROR]`)

### Scenario 3: default idle timeout accommodates longer reasoning gaps (regression guard)

Given no `--idle-timeout-ms` flag is supplied and no `idle_timeout_ms` override is set in config.yaml
When I launch a background task that takes ~4 s between app-server notifications but completes normally: `jobId=$(bridge task --background --write "run: sleep 4; echo done" --mode default --json | jq -r '.result.jobId')`
And I wait up to 30 s: `bridge wait "$jobId" --timeout-ms 30000 --json > /tmp/04-default.json`
Then the job completes with `status: completed` (NOT `failed` with `ClientTimeout`)
And the `.events` file has a terminal `[DONE]` tag
And this pins that the default threshold is well above the pre-fix 120s (4s well under the new 300s default; would have passed either way, but the fact that the flag-plumbing does not regress the default is what scenario 3 guards).

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }

# Scenario 1 — smokeable without Codex
out=$(bridge task --idle-timeout-ms notanumber "echo ok" 2>&1); rc=$?
echo "$out" | grep -qE "--idle-timeout-ms must be a positive number" \
  && test $rc -eq 2 \
  && echo "04-scenario1a PASS" || echo "04-scenario1a FAIL"

out=$(bridge task --idle-timeout-ms 0 "echo ok" 2>&1); rc=$?
echo "$out" | grep -qE "must be a positive number" && test $rc -eq 2 \
  && echo "04-scenario1b PASS" || echo "04-scenario1b FAIL"

out=$(bridge send 00000000-0000-0000-0000-000000000000 --idle-timeout-ms -1 "x" 2>&1); rc=$?
echo "$out" | grep -qE "must be a positive number" && test $rc -eq 2 \
  && echo "04-scenario1c PASS" || echo "04-scenario1c FAIL"

# Scenarios 2 and 3 — require live Codex:
# jobId=$(bridge task --background --idle-timeout-ms 3000 --write "run: sleep 6" --mode default --json | jq -r '.result.jobId')
# bridge wait "$jobId" --timeout-ms 30000 --json > /tmp/04s2.json
# jq -e '.result.status == "failed"' /tmp/04s2.json && echo "04-scenario2 PASS"
```

**Smoke result (2026-04-19):**
- Scenario 1a PASS: exit 2, usage error matching the expected regex.
- Scenario 1b PASS: zero rejected.
- Scenario 1c PASS: negative rejected on `send`.
- Scenario 2 SKIPPED: requires live Codex.
- Scenario 3 SKIPPED: requires live Codex.

### Enhancement candidates

- If broker-socket liveness is introduced as a secondary signal (the architectural follow-up), scenario 2 needs adjustment: a quiet turn is only "stuck" if both the event stream *and* the socket go idle, so scenario 2 must explicitly ensure the socket is alive during the silence window.
- A config.yaml layer scenario (`idle_timeout_ms: 1000` in a per-project `config.yaml`) would round out the four-layer config coverage — defer until a live runner exists to exercise it.
- Pairs with `04-errors/04-wait-timeout.md` (different error shape: `WAIT_TIMEOUT` is a caller-side deadline on `wait`; `ClientTimeout` is the bridge-side watchdog inside a turn).
