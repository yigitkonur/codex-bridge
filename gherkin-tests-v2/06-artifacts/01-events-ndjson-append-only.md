# 01-events-ndjson-append-only

**Derived from:** `src/lib/session-log.mjs:12-19` (`initSession` touches `.ndjson` and `.events` via `writeFileSync(..., { flag: "a" })` — create-if-absent, never truncate), `src/lib/session-log.mjs:39,47` (`logNdjson` line 39 and `logEvent` line 47 — sole live writers for those two files, both use `appendFileSync`), root `AGENTS.md` cross-cutting convention 4 ("Session artifacts are append-only"), `src/lib/AGENTS.md` invariant 3 ("Never add async writers to `.events` or `.ndjson`"). Note: `.diff` (line 56) and `.plan.md` (line 66) use plain `writeFileSync` without `flag:"a"` — they are overwrite-on-update artifacts, not append-only; this scenario does NOT cover them.
**What this catches:** Regressions that truncate session files between turns — either by opening with the wrong flag, by replacing `appendFileSync` with an async writer that interleaves, or by a well-meaning "cleanup" that rotates files under size pressure. This is the foundation of Monitor-tool tailing and `summary`/`wait` replay; losing append semantics breaks retrospective reads silently.
**Runtime cost:** medium (runs two full turns on the same thread).
**Test subject:** a workspace with Codex authenticated.

## Feature: `.events` and `.ndjson` are strictly append-only across turns

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

And `${SESSION_DIR}` resolves to `~/.codex-bridge/sessions`
And the `codex` CLI is installed and authenticated

### Scenario: follow-up turn appends, does not truncate

Given I run a default-mode task: `out1=$(bridge task --write "print hello" --json)` which produces `threadId=$(jq -r .result.threadId <<<"$out1")`
And after completion `${SESSION_DIR}/${threadId}.events` exists with some `N_EVENTS` lines and some `BYTES_EVENTS` bytes
And `${SESSION_DIR}/${threadId}.ndjson` exists with `N_NDJSON` lines and `BYTES_NDJSON` bytes
And I snapshot both files to `${threadId}.events.v1` and `${threadId}.ndjson.v1`
When I run a follow-up `bridge send ${threadId} "print goodbye" --json` on the same thread
Then `${SESSION_DIR}/${threadId}.events` still exists (no rotation, no `.events.1` sibling)
And its byte length is strictly greater than `BYTES_EVENTS`
And `head -n N_EVENTS` of the current file is byte-identical to `${threadId}.events.v1`
And the same three assertions hold for `.ndjson`
And every `TURN_PARAMS` record in `.ndjson` carries a unique `(threadId, turnId)` pair across both turns (no reused turnId, since upstream echoes but never reuses)

### Pass / fail predicate

```bash
bytes_before_events=$(wc -c < "${SESSION_DIR}/${threadId}.events")
bytes_before_ndjson=$(wc -c < "${SESSION_DIR}/${threadId}.ndjson")
n_events=$(wc -l < "${SESSION_DIR}/${threadId}.events")
cp "${SESSION_DIR}/${threadId}.events" /tmp/events.v1
cp "${SESSION_DIR}/${threadId}.ndjson" /tmp/ndjson.v1

bridge send "${threadId}" "print goodbye" --json > /dev/null

bytes_after_events=$(wc -c < "${SESSION_DIR}/${threadId}.events")
test "$bytes_after_events" -gt "$bytes_before_events" \
  && diff <(head -n "$n_events" "${SESSION_DIR}/${threadId}.events") /tmp/events.v1 \
  && test "$(wc -c < "${SESSION_DIR}/${threadId}.ndjson")" -gt "$bytes_before_ndjson"
```

### Enhancement candidates

- If size-based log rotation is ever added (e.g. `.events.1`, `.events.2`), this test must assert the rotation policy explicitly (when does it fire, is the original file preserved untruncated until rotation, does `wait` still find terminal tags?).
- Protects against a refactor that opens the file with `{ flag: "w" }` on every turn (would nuke the prior transcript). Equally catches replacing `appendFileSync` with `fs.appendFile` without a queue — concurrent Codex notifications would interleave partial lines.
- If `summary` ever compacts `.ndjson` in place (tombstone older records), this contract must be re-expressed: first N lines would no longer be byte-identical, only semantically preserved.
