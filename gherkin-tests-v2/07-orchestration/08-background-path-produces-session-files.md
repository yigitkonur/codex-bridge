# 08-background-path-produces-session-files

**Derived from:** `src/codex-bridge.mjs:1986` (foreground call site — always went through `runBridgeTask`) and `src/codex-bridge.mjs:2044-2055` (background `handleTaskWorker` call site — pre-v1.2.1 called `executeTaskRun` directly, bypassing every session-logging hook). `src/codex-bridge.mjs::runBridgeTask:1519-1850` (builds `bridgeRequest.onTurnStart` / `onItemCompleted` / `onServerRequest`; calls `initSession(sessionDir, result.threadId)` at line 1731; runs auto-pipeline; sets `phase`/`next_action` on `result.payload`). `src/lib/session-log.mjs::{initSession, logEvent, logNdjson, captureGitDiff}` (append-only writers). `src/codex-bridge.mjs::spawnDetachedTaskWorker:1415-1440` (captures child stderr to `${logFile}.worker.err` as of v1.2.1 — pre-v1.2.1 used `stdio: "ignore"` which swallowed all errors).
**What this catches:** `task --background` must produce the same three session artifacts (`{threadId}.events`, `{threadId}.ndjson`, `{threadId}.diff`) that `task` foreground produces. The pre-v1.2.1 detached worker called `executeTaskRun` without going through `runBridgeTask`, so `onTurnStart`/`onItemCompleted`/`onServerRequest` hooks were never wired, `initSession` was never called, and the whole `async + Monitor` contract documented in `skill/SKILL.md` silently broke for detached jobs — `wait $JOBID` returned `WAIT_TIMEOUT`, `events --follow` had nothing to tail, `[QUESTION]`/`[DONE]` never landed.
**Runtime cost:** slow — requires a real Codex task (~20-30s for a trivial prompt under `auto_review: false`). This is an observability contract, not a unit invariant.
**Test subject:** the shipped CLI at `${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs` under a fresh workspace with `auto_review: false` to keep wall-time bounded.

## Feature: `task --background` produces session files identical to the foreground path

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${CLAUDE_SKILL_DIR:-${HOME}/.claude/skills/codex-bridge}/scripts/codex-bridge.mjs" "$@"; }
```

And `npm run build` has been run, and the shipped bundle reseated into the installed skill if testing against it (`cp skill/scripts/codex-bridge.mjs ~/.claude/skills/codex-bridge/scripts/codex-bridge.mjs`).

### Scenario 1: background job produces `.events`, `.ndjson`, and `.diff` files

Given a fresh empty workspace with `config.yaml` that disables `auto_review` and the completion check:
```yaml
codex_bridge:
  mode: "default"
  auto_review: false
  post_task_prompt: ""
```
When I run `bridge task --write --mode default --background "Print 'bg-ok' and stop. Do not modify any files." --json`
And wait for the job to transition to `status: "completed"`
Then `~/.codex-bridge/sessions/{threadId}.events` exists and is non-empty (contains at minimum a `[DONE]` block)
And `~/.codex-bridge/sessions/{threadId}.ndjson` exists and is non-empty (contains at minimum a `TURN_PARAMS` record and a `TURN_COMPLETED` record)
And `~/.codex-bridge/sessions/{threadId}.diff` exists (may be empty for this no-write prompt)
And `bridge wait <jobId> --timeout-ms 60000 --json` returns `terminalTag ∈ { "DONE", "ERROR", "INCOMPLETE" }` within the timeout (was `WAIT_TIMEOUT` pre-v1.2.1)

### Scenario 2: background NDJSON records the shipped defenses firing (regression guard)

Given a background job completing per scenario 1 on a default `config.yaml` (shipped: `sandbox_policy: "danger-full-access"`, `skip_meta_skills: true`)
When I inspect `{threadId}.ndjson`
Then the `TURN_PARAMS` record has `data.sandboxPolicy.type === "dangerFullAccess"`
And `data.promptPreview` starts with `"[ORCHESTRATOR DIRECTIVE]"` (proves the detached worker's `runBridgeTask` ran and injected the directive)
And at least one `ITEM_COMPLETED` record is present (proves `onItemCompleted` fired from the worker)

This is the behavioral proof that the v1.2.1 fix (`executeTaskRun` → `runBridgeTask` on the background path) actually routes hooks through the same pipeline as foreground.

### Scenario 3: detached-worker stderr is captured on crash (observability regression guard)

Given a contrived crash (e.g. a corrupted stored job file that makes `handleTaskWorker` throw before completing)
Then the file `{logFile}.worker.err` exists in the state dir alongside the per-job `.log`
And contains a readable Node stacktrace
And the job record's `status` transitions to `"failed"` rather than staying `"queued"`/`"running"`

Pre-v1.2.1 `spawnDetachedTaskWorker` used `stdio: "ignore"`, which swallowed stderr entirely — a crash left the job record stuck at `queued` with no diagnostic trail. The v1.2.1 spawn options redirect fd 2 to `${logFile}.worker.err`.

### Scenario 4: foreground path unchanged (regression guard)

Given the same `bridge task --write --mode default "Print 'fg-ok' and stop" --json` run in foreground (no `--background`)
Then `~/.codex-bridge/sessions/{threadId}.{events,ndjson,diff}` exist as they did pre-v1.2.1 (the foreground path was never broken)
And the envelope's `result.phase === "done"`

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
INSTALL="${CLAUDE_SKILL_DIR:-${HOME}/.claude/skills/codex-bridge}"

# Fresh workspace
WORK=$(mktemp -d)
cd "$WORK" && git init -q
cat > config.yaml <<'YAML'
codex_bridge:
  mode: "default"
  auto_review: false
  post_task_prompt: ""
YAML

# Launch background task
LAUNCH=$(node "$INSTALL/scripts/codex-bridge.mjs" task --write --mode default --background "Print 'bg-ok' and stop. Do not modify any files." --json)
JOB=$(echo "$LAUNCH" | jq -r '.result.jobId')

# Wait for completion (bounded)
until node "$INSTALL/scripts/codex-bridge.mjs" status "$JOB" --json 2>/dev/null | jq -e '.result.job.status == "completed" or .result.job.status == "failed"' > /dev/null; do sleep 3; done

TID=$(node "$INSTALL/scripts/codex-bridge.mjs" status "$JOB" --json | jq -r '.result.job.threadId')
SESSIONS="${HOME}/.codex-bridge/sessions"

# Scenario 1: three session files exist
test -s "$SESSIONS/$TID.events"  && \
test -s "$SESSIONS/$TID.ndjson" && \
test -f "$SESSIONS/$TID.diff"   && \
grep -q "\[DONE\]\|\[ERROR\]\|\[INCOMPLETE\]" "$SESSIONS/$TID.events" \
  && echo "s1 PASS" || echo "s1 FAIL"

# Scenario 1 continued: wait subcommand terminates normally
node "$INSTALL/scripts/codex-bridge.mjs" wait "$JOB" --timeout-ms 5000 --json > /tmp/wait.json 2>&1
jq -e '.ok == true and (.result.terminalTag | test("DONE|ERROR|INCOMPLETE"))' /tmp/wait.json >/dev/null \
  && echo "s1-wait PASS" || echo "s1-wait FAIL"

# Scenario 2: NDJSON proves runBridgeTask ran on the worker
grep '"tag":"TURN_PARAMS"' "$SESSIONS/$TID.ndjson" | jq -e '.data.sandboxPolicy.type == "dangerFullAccess" and (.data.promptPreview | startswith("[ORCHESTRATOR DIRECTIVE]"))' >/dev/null \
  && echo "s2 PASS" || echo "s2 FAIL"
grep -q '"tag":"ITEM_COMPLETED"' "$SESSIONS/$TID.ndjson" \
  && echo "s2-items PASS" || echo "s2-items FAIL"

rm -rf "$WORK"
```

### Enhancement candidates

- Scenario 3 (deliberate-crash observability proof) is tricky to automate without mocking `readStoredJob` to throw. Consider adding a `--crash-for-test` flag to `task-worker` that exits non-zero after entering `handleTaskWorker` but before any logging, or a standalone unit test that spawns a trivial node script with `stdio: ["ignore","ignore",fd]` and asserts a readable trail.
- If future changes move the background path through a separate entry point (e.g. a queue daemon), this spec needs to be re-pointed at whatever the new detached runner is; the invariant "session files = foreground outputs" is what matters.
- Pairs with `04-cancel-interrupts-running-turn.md` — both specs cover the detached-worker lifecycle from opposite ends (happy path vs interrupt).
