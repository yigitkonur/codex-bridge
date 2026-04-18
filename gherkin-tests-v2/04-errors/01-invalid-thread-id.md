# 01-invalid-thread-id

**Derived from:** `src/lib/cli-errors.mjs:127-138` (`invalidThreadIdError` factory, class `validation`, code `INVALID_THREAD_ID`, non-retryable, suggestion cites UUID v7 example), `src/lib/cli-errors.mjs:18-30` (`CLASS_TO_EXIT` maps `validation` → exit 6), `src/codex-bridge.mjs:2157-2158` (`send` handler validates first positional with `isThreadId`), `src/codex-bridge.mjs:2255-2256` (`steer` handler validates first positional).
**What this catches:** Regressions in the pre-turn argument validator. If someone loosens the UUID regex for a migration (e.g. accepts `thr_…`), replaces the canonical error factory, or drops the suggestion string, this scenario fires. Also guards the contract that validation errors surface as a well-formed `--json` envelope even when no session has been initialized yet (no `.events` file exists to read).
**Runtime cost:** fast
**Test subject:** any terminal session; no workspace state needed; no Codex auth required (the validator short-circuits before any RPC call).

## Feature: reject malformed thread ids on `send` and `steer`

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

And `npm run build` has been run since the last `src/` edit
And no session directory is required (the error is emitted pre-initSession; no `.events` or `.ndjson` files are created for the bad invocation)

### Scenario: `send` with a non-UUID thread id

Given the user supplies a non-UUID thread id (e.g. `thr_abc`)
When I run `bridge send thr_abc 'hello' --json`
Then stdout is a single JSON object whose `ok` is `false`
And `.error.code` equals `"INVALID_THREAD_ID"`
And `.error.class` equals `"validation"`
And `.error.retryable` equals `false`
And `.error.suggestion` contains the substring `"UUID v7 like 019d9a86-"`
And the process exit code is `6`

### Scenario: `steer` with a non-UUID thread id

Given the user supplies a non-UUID first positional to `steer` (thread-id position)
When I run `bridge steer not-a-uuid <any-turn-id> "hi" --json`
Then `.error.code` equals `"INVALID_THREAD_ID"`
And `.error.class` equals `"validation"`
And the process exit code is `6`
And the error message cites the first offending identifier, not a generic "bad args" string

Note: `steer` takes `<thread-id> <turn-id> <prompt…>` positionally. Only the first positional (thread-id) is UUID-validated; `<turn-id>` is the second positional and is accepted as any non-empty string.

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }

# Scenario 1
bridge send thr_abc 'hello' --json > /tmp/01.json
rc=$?
jq -e '.ok == false and .error.code == "INVALID_THREAD_ID" and .error.class == "validation" and .error.retryable == false' /tmp/01.json \
  && test $rc -eq 6 \
  && jq -e '.error.suggestion | test("UUID v7 like 019d9a86")' /tmp/01.json \
  && echo "01 PASS" || echo "01 FAIL"

# Scenario 2
bridge steer not-a-uuid fake-turn-id "hi" --json > /tmp/01b.json
rc2=$?
jq -e '.ok == false and .error.code == "INVALID_THREAD_ID" and .error.class == "validation"' /tmp/01b.json \
  && test $rc2 -eq 6 \
  && echo "01b PASS" || echo "01b FAIL"
```

**Smoke result (2026-04-18):** Both scenarios PASS. `send thr_abc` → exit 6, `INVALID_THREAD_ID`. `steer not-a-uuid fake-turn-id "hi"` → exit 6, `INVALID_THREAD_ID`. Actual suggestion text: `"Thread ids are UUID v7 like 019d9a86-1c8a-7f41-8032-6c76bbe730a1. Run \`status\` to list known threads."`.

### Enhancement candidates

- If a `thr_…` prefix is ever added for migration, both scenarios must be updated and the suggestion string reworded. The test pins the current invariant.
- The envelope shape here is the canonical "error-before-session-init" example. Any future work that tries to open `.events` on validation failure (to log the bad-arg turn) will surface as an orphan file in the session dir — confirm that does not happen before merging.
- A future `--strict-uuid-v7` flag could reject v4-shaped inputs; this test currently accepts any 8-4-4-4-12 hex and should be split into two scenarios when that lands.
