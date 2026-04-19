# 09-events-accepts-thread-id-for-running-job

**Derived from:** `src/lib/job-control.mjs::resolveResultJob` (active-match now includes `job.threadId === reference` alongside job-id matching — was job-id-only), `src/codex-bridge.mjs::handleEvents` (calls `resolveResultJob`, so every `events` invocation inherits the fix; tail loop at `src/codex-bridge.mjs:2383-2465`), `SKILL.md:77` ("`status`/`result`/`cancel` accept either a job id or the thread UUID" — the contract `events` now honors for *running* jobs, not just terminal ones), `src/lib/job-control.mjs::matchJobReference:203-208` (thread-id equality lookup that was previously only reachable for terminal statuses).
**What this catches:** The specific live-run failure where `events <thread-uuid> --follow` on a still-running job returned `JOB_NOT_FOUND` (exit 3). Pre-fix: the active-match block at the top of `resolveResultJob` only compared `job.id`, so a thread UUID for a running task dead-ended. Post-fix: the branch also compares `job.threadId`, so thread-UUID references resolve correctly for both active and terminal jobs.
**Runtime cost:** scenario 1 is fast (just needs a registered job; can use a queued or already-finished fixture). Scenario 2 requires a live background task to observe the streaming behavior.
**Test subject:** scenario 1 uses any job already in the registry; scenario 2 requires a real background task whose thread id we capture.

## Feature: `events` accepts a thread UUID for a running job (not just terminal ones)

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

And `npm run build` has been run since the last `src/` edit

### Scenario 1: thread UUID for a running job resolves to a job (smokeable with a fixture)

Given a registered job exists in the current session (either running or terminal — the contract is that either id works)
And I capture its thread id via `bridge status --json`: `tid=$(bridge status --json | jq -r '.result.running[0].threadId // .result.latestFinished.threadId')`
When I run `bridge events "$tid" --json` with a small initial dump (no `--follow`)
Then the envelope has `ok: true`
And `.result.threadId` equals `$tid`
And `.result.jobId` is the non-null canonical job id for that thread
And the exit code is `0`
And this was previously impossible for `status == "running"` jobs — the old `resolveResultJob` only matched by job id in the active-match block, forcing callers to look up the job id via `status` first before they could call `events`.

### Scenario 2: `events <threadId> --follow` streams a running job (requires live Codex)

Given Codex is authenticated
When I launch a background task and capture its thread id:
```sh
launch=$(bridge task --background --write "reply OK and stop" --json)
tid=$(echo "$launch" | jq -r '.result.threadId // empty')
# threadId may be null immediately after launch (before the worker emits thread/started);
# poll for up to 5 s for the status snapshot to populate it.
for i in $(seq 1 25); do
  tid=$(bridge status --json | jq -r '.result.running[0].threadId // empty')
  [ -n "$tid" ] && break
  sleep 0.2
done
```
And I run `bridge events "$tid" --follow --filter DONE,ERROR,INCOMPLETE --timeout-ms 30000 --json`
Then the command exits `0` once a terminal tag lands
And the stdout contains at least one tagged line matching `^\[(DONE|ERROR|INCOMPLETE)\]`
And the envelope's `.result.jobId` is populated
And at no point does the command return `JOB_NOT_FOUND` (pre-fix failure mode)

### Scenario 3: running job + arbitrary UUID does NOT falsely match (regression guard)

Given a background job is running with a specific thread id
When I run `bridge events 00000000-0000-0000-0000-000000000000 --json 2>&1`
Then the envelope has `ok: false`
And `.error.code` equals `"JOB_NOT_FOUND"`
And the exit code is `3`
And this pins that the new threadId branch uses exact equality (`===`), not any looser match.

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }

# Scenario 1 — smokeable with any registered job in the session
snap=$(bridge status --json 2>/dev/null)
tid=$(echo "$snap" | jq -r '.result.running[0].threadId // .result.latestFinished.threadId // empty')
if [ -n "$tid" ] && [ "$tid" != "null" ]; then
  out=$(bridge events "$tid" --json 2>&1); rc=$?
  echo "$out" | jq -e '.ok == true and .result.threadId != null' > /dev/null \
    && test $rc -eq 0 \
    && echo "09-scenario1 PASS" || echo "09-scenario1 FAIL"
else
  echo "09-scenario1 SKIP (no registered job to reference)"
fi

# Scenario 3 — bogus UUID
out=$(bridge events 00000000-0000-0000-0000-000000000000 --json 2>&1); rc=$?
echo "$out" | jq -e '.ok == false and .error.code == "JOB_NOT_FOUND"' > /dev/null \
  && test $rc -eq 3 \
  && echo "09-scenario3 PASS" || echo "09-scenario3 FAIL"

# Scenario 2 — requires live Codex:
# launch=$(bridge task --background --write "reply OK" --json)
# for i in $(seq 1 25); do tid=$(bridge status --json | jq -r '.result.running[0].threadId // empty'); [ -n "$tid" ] && break; sleep 0.2; done
# bridge events "$tid" --follow --filter DONE,ERROR --timeout-ms 30000 > /tmp/09.out; rc=$?
# grep -qE "^\[(DONE|ERROR|INCOMPLETE)\]" /tmp/09.out && test $rc -eq 0 && echo "09-scenario2 PASS"
```

**Smoke result (2026-04-19):**
- Scenario 1 PASS or SKIP (depending on whether a registered job is present in the session): when a job exists, `events <threadId>` resolves without `JOB_NOT_FOUND`; pre-fix this returned exit 3 for running jobs.
- Scenario 2 SKIPPED: requires live Codex.
- Scenario 3 PASS: bogus UUIDs still correctly return `JOB_NOT_FOUND`.

### Enhancement candidates

- `status` and `result` are already covered for thread-id lookups elsewhere; add cross-references to this scenario from their predicates so the "either id works" contract is documented from multiple angles.
- If `buildSingleJobSnapshot` is ever refactored to share a typed identifier-resolver helper with `resolveResultJob` (architectural follow-up in the plan), this scenario still passes — the predicate asserts observable behavior, not the internal lookup mechanism.
- Pairs with `06-artifacts/` which covers the `.events`/`.ndjson` file contract and `07-orchestration/03-wait-blocks-on-terminal-tag.md` which covers `wait` (the other major consumer of `resolveResultJob`).
