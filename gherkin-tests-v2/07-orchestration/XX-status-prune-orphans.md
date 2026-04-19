# XX-status-prune-orphans

**Derived from:** `src/codex-bridge.mjs::handleStatus` honors `--prune-orphans` / `--cleanup` flags; `pruneOrphanedJobs` walks `listJobs(workspaceRoot)` for `{status:"running"|"queued"}`, probes each PID via `process.kill(pid, 0)`, and reaps entries whose PID throws `ESRCH` (EPERM is conservatively kept — the process exists but we can't signal). Implements fix #4 from `unexpected-bridge-observations/06-stop-gate-review-accumulates-orphaned-running-tasks.md`.
**What this catches:** (a) Running `status --prune-orphans` on a clean state is a no-op (no orphans, no error). (b) A synthetic ghost record (pid:999999999) gets reaped on the next run. (c) `renderPruneOrphansReport` produces a human-readable summary; `--json` gives the structured payload.
**Runtime cost:** fast; scenarios seed their own state.

## Feature: `status --prune-orphans` drains ghost rings idempotently

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

### Scenario 1: clean state is a no-op

Given no active jobs are registered in the current workspace (or all actives have live PIDs)
When I run `bridge status --prune-orphans --json`
Then the envelope has `ok: true`
And `.result.reapedCount` equals `0`
And the exit code is `0`
And the rendered output (non-JSON) is "No active jobs to inspect — state is clean." OR "No orphans: N active job(s), all backed by live PIDs."

### Scenario 2: a synthetic ghost gets reaped

Given I write a synthetic job record to the state directory with `{status:"running", pid:999999999}` (an almost-certainly-dead PID)
When I run `bridge status --prune-orphans --json`
Then `.result.reapedCount` is at least `1`
And `.result.reaped[]` contains the synthetic job id with `previousStatus:"running"` and `reason:"dead-pid"`
And a follow-up `bridge status <synthetic-id> --json` shows `.result.job.status == "orphaned"` with an `errorMessage` containing "Reaped by status --prune-orphans"

### Scenario 3: idempotence — second run reaps nothing

Given scenario 2 has already executed
When I run `bridge status --prune-orphans --json` again
Then `.result.reapedCount` is `0` (the first run transitioned the record; the second sees no active ghosts)

### Scenario 4: `--cleanup` is a synonym for `--prune-orphans`

Given any state (clean or ghost-laden)
When I run `bridge status --cleanup --json`
Then the behavior is identical to `--prune-orphans --json`

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }

# Scenario 1
out=$(bridge status --prune-orphans --json 2>&1); rc=$?
echo "$out" | jq -e '.ok == true' > /dev/null && test "$rc" -eq 0 \
  && echo "s1 PASS" || echo "s1 FAIL (rc=$rc)"

# Scenarios 2+3 require seeding a synthetic job file — exercise via live-run or a helper.
# Scenario 4
out=$(bridge status --cleanup --json 2>&1); rc=$?
echo "$out" | jq -e '.ok == true' > /dev/null && test "$rc" -eq 0 \
  && echo "s4 PASS" || echo "s4 FAIL"
```

### Enhancement candidates

- A `status --prune-orphans --older-than <hours>` flag would address the time-based staleness reaper from observation/06 fix #2 (any running job whose `updatedAt` is >N hours old → orphan, covers PID-reuse edges).
- Emit a JSON summary field `stateFilesCleaned: N` for operators who want to verify the number of state files rewritten.
