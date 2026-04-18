# 04-cancel-interrupts-running-turn

**Derived from:** `src/codex-bridge.mjs:2054-2117` (`handleCancel`: resolves job → `interruptAppServerTurn` → `terminateProcessTree` → writes `status: "cancelled"`, `phase: "cancelled"`, `errorMessage: "Cancelled by user."`; envelope carries `turnInterruptAttempted` + `turnInterrupted`), `src/lib/codex.mjs:976` (`client.request("turn/interrupt", { threadId, turnId })` on a fresh broker connection), `src/lib/AGENTS.md:95,137,365` ("`turn/interrupt` is async; `{}` means 'accepted', the turn isn't done until `turn/completed { status: "interrupted" }`"), `src/AGENTS.md:72` (broker carve-out allowing `turn/interrupt` while another socket streams), `skill/SKILL.md` ("cancel … recovers" reference and "Cancel already-terminal jobs returns conflict").
**What this catches:** Regressions where `cancel` either (a) forgets to attempt `turn/interrupt` and only kills the worker (leaves the upstream turn spending tokens), (b) makes the second cancel succeed silently instead of returning `conflict`, or (c) in the no-arg form picks up a job from a *different* Claude session because `CODEX_COMPANION_SESSION_ID` filtering was dropped. Also catches upstream changes making `turn/interrupt` sync: `turnInterruptAttempted` + `turnInterrupted` would no longer be paired the same way.
**Runtime cost:** medium (one background Codex launch; cancelled seconds in)
**Test subject:** an intentionally long-running background write task in `$TMPDIR/html-site` (clean git repo)

## Feature: `cancel` interrupts a running turn and is idempotent-as-error

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

Given Codex CLI is installed on `$PATH` and authenticated
And `npm run build` has been run since the last `src/` edit
And `cwd = $TMPDIR/html-site` is a clean git repo
And `CODEX_COMPANION_SESSION_ID` is set to a fresh uuid

### Scenario: cancelling a running background job interrupts the turn and marks the record cancelled

**Requires live Codex run — runtime cost: medium (one background Codex launch, cancelled seconds in).**

Given I have launched `bridge task --background --write --json "build a single-page HTML site and spend a lot of time styling it"` and received `<jobId>`
And the job is still running (status `running`, `pid` present, no terminal tag yet in `.events`)
When I run `bridge cancel <jobId> --json`
Then stdout is a single envelope with `ok == true`
And `result.jobId == "<jobId>"`, `result.status == "cancelled"`, `result.turnInterruptAttempted == true`, `result.turnInterrupted` is boolean
When I then run `bridge status <jobId> --json`
Then `result.phase == "cancelled"` and `result.errorMessage == "Cancelled by user."`
And `result.pid == null`
And the events file either ends with an `[ERROR]` line (worker drained `turn/completed { status: "interrupted" }`) OR has no new terminal tag (worker was SIGKILLed before drain); both are acceptable terminal states for a cancel

### Scenario: cancelling an already-terminal (cancelled) job returns `JOB_NOT_FOUND`, exit 3

**Requires a previously cancelled job from the preceding scenario.**

Given `<jobId>` is in `status: "cancelled"` from the previous scenario
When I run `bridge cancel <jobId> --json`
Then the process exits 3
And stdout is a single envelope with `ok == false`, `error.class == "not_found"`, `error.code == "JOB_NOT_FOUND"`

**Note:** `resolveCancelableJob` (`src/lib/job-control.mjs:327`) filters to only `queued` or `running` jobs before calling `matchJobReference`. A cancelled job is not in that set. `matchJobReference` finds no match among active jobs and throws `JOB_NOT_FOUND` (exit 3), not a conflict. This differs from the `src/AGENTS.md` note that cancel is "idempotent-as-error" — the error class is `not_found`, not `conflict`. The `ACTIVE_JOB_NOT_FOUND` code defined in `resolveCancelableJob:335` is effectively dead code because `matchJobReference` throws `JOB_NOT_FOUND` before the outer null-check can run.

### Scenario (error path, fast): `cancel` with no argument and no active jobs returns `NO_ACTIVE_JOBS`, exit 3

When I run `bridge cancel --json` with `CODEX_COMPANION_SESSION_ID` set to a fresh uuid (no jobs exist for that session)
Then the process exits 3
And stdout is a single envelope with `ok == false`, `error.class == "not_found"`, `error.code == "NO_ACTIVE_JOBS"`

**Smoke result (verified):** exit 3, `{"ok":false,"error":{"class":"not_found","code":"NO_ACTIVE_JOBS","message":"No active Codex jobs to cancel for this session.",...}}`

### Scenario (error path, fast): `cancel <nonexistent-id>` returns `JOB_NOT_FOUND`, exit 3

When I run `bridge cancel task-nonexistent-id --json`
Then the process exits 3
And stdout is a single envelope with `ok == false`, `error.class == "not_found"`, `error.code == "JOB_NOT_FOUND"`

**Smoke result (verified):** exit 3, `{"ok":false,"error":{"class":"not_found","code":"JOB_NOT_FOUND","message":"No job found for \"task-nonexistent-id\".",...}}`

### Pass / fail predicate

```sh
# Error-path scenarios (fast, no live task needed)

# No-arg cancel with fresh session
CODEX_COMPANION_SESSION_ID=$(uuidgen) bridge cancel --json; rc=$?
test "$rc" = 3 && CODEX_COMPANION_SESSION_ID=$(uuidgen) bridge cancel --json \
  | jq -e '.ok==false and .error.class=="not_found" and .error.code=="NO_ACTIVE_JOBS"'

# Nonexistent id
bridge cancel task-nonexistent-id --json; rc=$?
test "$rc" = 3 && bridge cancel task-nonexistent-id --json \
  | jq -e '.ok==false and .error.class=="not_found" and .error.code=="JOB_NOT_FOUND"'

# Scenario 1 (requires live task; set JOB_ID to a running background job)
bridge cancel "$JOB_ID" --json \
  | jq -e '.ok==true and .result.status=="cancelled" and .result.turnInterruptAttempted==true'
bridge status "$JOB_ID" --json \
  | jq -e '.result.phase=="cancelled" and .result.errorMessage=="Cancelled by user." and .result.pid==null'

# Scenario 2 — cancel of already-cancelled job (requires prior cancel)
bridge cancel "$JOB_ID" --json; rc=$?
test "$rc" = 3 && bridge cancel "$JOB_ID" --json \
  | jq -e '.ok==false and .error.class=="not_found" and .error.code=="JOB_NOT_FOUND"'
```

### Enhancement candidates

If `turn/interrupt` becomes synchronous upstream (response no longer `{}` but `turn/completed`-shaped), `turnInterrupted` semantics shift from "best-effort ack" to "turn truly done" and the spec's acceptance of either outcome in scenario 1's events-file tail becomes too lenient — scenario 1 should then require an `[ERROR]` terminal line every time. A sibling enhancement would be emitting a dedicated `[CANCELLED]` tag from `handleCancel` instead of relying on the worker's post-mortem `[ERROR]`; that would make scenario 1's events-file assertion deterministic and is worth doing regardless of upstream changes. The spec also catches the classic "silently idempotent cancel" regression (the second cancel must be an error, not a no-op, because it tells callers the state machine has ratcheted).
