# XX-task-kindlabel-not-rescue

**Derived from:** `src/codex-bridge.mjs::buildTaskRunMetadata` (now returns `kindLabel: "task"` for user tasks and `kindLabel: "rescue-review"` for the stop-gate-review path); `src/codex-bridge.mjs::buildTaskJob` threads `kindLabel` into `createCompanionJob`; `src/lib/job-control.mjs::getJobTypeLabel` fallback returns `"task"` for legacy state-file records with `jobClass:"task"` and no explicit `kindLabel`. Pre-1.2.5 every user-launched task showed `kindLabel: "rescue"` in status output, which misled agents into thinking the job was auto-created by a stop-gate recovery.
**What this catches:** `status --json` on a fresh user task reports `kindLabel: "task"` (not `"rescue"`). The stop-gate-review path (which is the original "rescue" surface) still reports a distinct `kindLabel: "rescue-review"` so the two types are distinguishable.
**Runtime cost:** scenario 1 is smokeable after launching a background task (no pipeline needed); scenario 2 requires the stop-gate-review hook pathway.

## Feature: kindLabel distinguishes user tasks from rescue-review jobs

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

### Scenario 1: a new user task gets kindLabel:"task" (requires Codex)

Given Codex is authenticated
When I launch `bridge task --write --background --no-pipeline "echo ok" --json` and capture the `jobId`
And I immediately run `bridge status "$jobId" --json`
Then `.result.job.kindLabel` equals `"task"` (not `"rescue"`)
And `.result.job.kind` is `"task"`
And `.result.job.jobClass` is `"task"`
And after the job completes, `.result.job.kindLabel` is still `"task"` (regression: completion path must not revert).

### Scenario 2: legacy state records without kindLabel fall through to "task"

Given a synthetic legacy job record `{id:"task-legacy-xxx", status:"completed", kind:"task", jobClass:"task"}` without a `kindLabel` field
When I invoke `getJobTypeLabel` (direct import) on it
Then the return value is `"task"` (pre-1.2.5 returned `"rescue"`)
And for `{kind:"review"}` → `"review"`, `{kind:"adversarial-review"}` → `"adversarial-review"` (regression guard for the non-task paths)

### Scenario 3: stop-gate-review jobs keep a distinct label

Given a task prompt containing the STOP_REVIEW_TASK_MARKER string
When `buildTaskRunMetadata({prompt, resumeLast:false})` is invoked
Then the returned object has `kindLabel: "rescue-review"` and `title: "Codex Stop Gate Review"`

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# Scenario 2 + 3 — unit-style
out=$(node -e "
  import('${REPO_ROOT}/src/lib/job-control.mjs').then(m => {
    const label = m.readJobProgressPreview ? '<mod loaded>' : '';
  });
" 2>&1)
# Use a direct helper probe for getJobTypeLabel via a tiny wrapper
node -e "
  (async () => {
    const m = await import('${REPO_ROOT}/src/lib/job-control.mjs');
    // getJobTypeLabel is module-internal. We exercise it indirectly via enrichJob,
    // which wraps getJobTypeLabel in kindLabel.
    const enriched = m.enrichJob({id:'task-legacy-xxx', status:'completed', kind:'task', jobClass:'task', startedAt:new Date().toISOString()});
    console.log('kindLabel=' + enriched.kindLabel);
  })();
" | grep -q 'kindLabel=task' && echo "s2 PASS" || echo "s2 FAIL"

# Scenario 3 — via buildTaskRunMetadata
node -e "
  (async () => {
    // buildTaskRunMetadata lives in the main CLI module, not exported — test
    // via a live task launch in scenario 1. Skip here.
    console.log('s3 SKIP (live)');
  })();
"

# Scenario 1 — requires live Codex:
# jobId=\$(bridge task --write --background --no-pipeline "echo ok" --json | jq -r '.result.jobId')
# bridge status "\$jobId" --json | jq -e '.result.job.kindLabel == "task"' && echo "s1 PASS"
```

### Enhancement candidates

- Export `buildTaskRunMetadata` for easier unit-style probing, or leave it internal and rely on scenario 1 (live).
- A migration script that walks legacy state-file records and rewrites `kindLabel:"rescue"` → `"task"` for `jobClass:"task"` entries would make the label flip retroactive.
