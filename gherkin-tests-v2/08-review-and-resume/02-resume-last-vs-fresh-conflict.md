# 02-resume-last-vs-fresh-conflict

**Derived from:** `src/codex-bridge.mjs:1500-1524` (`handleTask` parses `--resume-last`, `--resume`, `--fresh`; `resumeLast && fresh → conflictError("RESUME_FRESH_CONFLICT")`), `src/codex-bridge.mjs:716-728` (`getCurrentClaudeSessionId` + `filterJobsForCurrentClaudeSession` + `findLatestResumableTaskJob` — resume candidates are scoped by `CODEX_COMPANION_SESSION_ID`), `src/lib/tracked-jobs.mjs:6` (`SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID"`), `skill/SKILL.md` "Mid-turn steering + resume" section.
**What this catches:** Regressions in session filtering — if `CODEX_COMPANION_SESSION_ID` scoping is dropped, `--resume-last` could silently pick up another terminal's task and write into its thread (data leak + wrong-repo bug). Regressions in the mutex between `--resume` and `--fresh` — today they error with exit 5; silently combining them would either lose the resume context or spawn a phantom new thread. Regressions in `task-resume-candidate`, which is the *read-only* probe Claude uses before deciding what to offer the user; if it starts spawning a turn (side-effecting), billed turns fire without user intent.
**Runtime cost:** medium (two execute turns — one to seed a completed task, one resume; plus one fresh launch)
**Test subject:** `$TMPDIR/html-site` git repo, fresh `CODEX_COMPANION_SESSION_ID`

## Feature: `--resume-last` vs `--fresh` vs `task-resume-candidate`

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

Given Codex CLI is installed on `$PATH` and authenticated
And `bridge()` is defined as above (targets the repo's own bundle, not the globally-installed copy)
And `cwd = $TMPDIR/html-site` is a clean git repo
And `CODEX_COMPANION_SESSION_ID` is set to a fresh uuid for the whole scenario set
And I have already completed one task in this session whose `jobId == <candId>` and `threadId == <candThread>` (via `bridge task --write --json "build a single-page HTML site"`)

### Scenario: `task-resume-candidate --json` reports a candidate without launching anything

When I run `bridge task-resume-candidate --json`
Then stdout is a single envelope with `ok == true`
And `result.available == true`
And `result.candidate.id == "<candId>"` and `result.candidate.threadId == "<candThread>"`
And no new `.events`, `.ndjson`, or job record is created on disk during this invocation

### Scenario: `task --resume-last` continues on the same thread id

When I run `bridge task --resume-last --json "add a newsletter sign-up form to the site"`
Then stdout is a single envelope with `ok == true`
And `result.thread_id == "<candThread>"` (not a new uuid)
And the events file at `<candThread>.events` now contains additional lines appended after the original terminal tag

### Scenario: `task --fresh` starts a new thread even though a candidate exists

When I run `bridge task --fresh --json "write a CONTRIBUTING.md"`
Then stdout is a single envelope with `ok == true`
And `result.thread_id` is a uuid that is NOT `<candThread>`
And a separate `<newThread>.events` file is created

### Scenario: `task --resume --fresh` conflicts, exits 5, spawns nothing

When I run `bridge task --resume --fresh --json "ambiguous request"`
Then the process exits 5
And stdout is a single envelope with `ok == false`
And `error.class == "conflict"` and `error.code == "RESUME_FRESH_CONFLICT"`
And no new thread, events file, or job record is created

### Pass / fail predicate

```sh
# Setup
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }

# Scenario 1 — probe only (reads existing job state; does not require a live Codex run)
bridge task-resume-candidate --json \
  | jq -e '.ok==true and .result.available==true
           and .result.candidate.id==env.CAND_ID
           and .result.candidate.threadId==env.CAND_THREAD'

# Scenario 2 — resume on same thread (slow — requires live Codex)
resume_out=$(bridge task --resume-last --json "add a newsletter sign-up form to the site")
printf '%s' "$resume_out" | jq -e '.ok==true and .result.thread_id==env.CAND_THREAD'

# Scenario 3 — fresh yields a different thread (slow — requires live Codex)
fresh_out=$(bridge task --fresh --json "write a CONTRIBUTING.md")
printf '%s' "$fresh_out" | jq -e --arg cand "$CAND_THREAD" '.ok==true and .result.thread_id != $cand'

# Scenario 4 — conflict + exit 5 + no side effects (smoke-runnable; no Codex session needed)
set +e
bridge task --resume --fresh --json > /tmp/08-02-s4.json 2>&1; rc=$?
test "$rc" = 5 || { echo "FAIL: expected exit 5, got $rc"; cat /tmp/08-02-s4.json; }
jq -e '.ok==false and .error.class=="conflict" and .error.code=="RESUME_FRESH_CONFLICT"' /tmp/08-02-s4.json
```

### Enhancement candidates

A natural hardening is a `--session <id>` override on `task-resume-candidate` so Claude can query candidates scoped to a past session during recovery; today the command is implicitly bound to the active env var and silently returns `available: false` under a fresh shell. When that lands, scenario 1 gains a variant that passes `--session <prev-uuid>` and asserts the candidate is found. A second enhancement is emitting a structured `result.reason` on scenario 4's conflict (`"resume and fresh are mutually exclusive"`) so agents don't need to parse the human message — the spec already pins `error.code`, so the addition would be additive. Catches the classic "cross-terminal resume" bug where two `claude` sessions on the same repo resume each other's threads because session filtering silently dropped.
