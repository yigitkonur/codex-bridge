# 01-plan-approval-happy-path

**Derived from:** `src/lib/session-log.mjs:216` (`formatPlanEvent`), `src/lib/auto-pipeline.mjs:203` (`logEvent(session, formatDoneEvent(...))` — terminal `[DONE]` after pipeline), `src/lib/config.mjs:51–56` (`buildCollaborationMode` pins `effort: "xhigh"` for plan mode), `skill/SKILL.md` sections "[PLAN] — Codex produced a plan" and "Plan → approve → execute".
**What this catches:** If plan mode ever stops emitting a single `[PLAN]` tag per turn, or `next_action.command` stops including `--mode default`, or the auto-pipeline skips one of `diff → review → check` before the terminal `[DONE]`/`[INCOMPLETE]` tag, this scenario surfaces the break at the exact phase boundary. It also guards the contract that the first envelope's `result.phase` is literally the string `"plan-pending"` — several caller scripts grep for that string.
**Runtime cost:** slow (two real Codex turns + auto-review pipeline; typically 3–8 min)
**Test subject:** single-page HTML site with hero, feature list, and footer

## Feature: Plan-mode approval happy path

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

Given Codex CLI is installed on `$PATH` and `codex login` has succeeded
And `npm run build` has been run since the last `src/` edit (so `skill/scripts/codex-bridge.mjs` is current)
And `CWD=$TMPDIR/html-site` exists and is a clean git repo (no staged or unstaged changes)
And the skill's `config.yaml` resolves to `mode: plan`, `auto_review: true`, default `post_task_prompt`, default `prompt_footer`

### Scenario: plan emitted, approved via `send --mode default`, pipeline completes

Given the workspace above with `CWD` as working directory
When I run:
  ```sh
  bridge task --json "build a single-page HTML site with a hero, a 3-item feature list, and a footer" \
    > task.json
  ```
Then `task.json` parses as a valid JSON object with `ok == true`
And `task.json` has `.result.phase == "plan-pending"`
And `task.json` has `.result.next_action.command` containing the literal substring `--mode default`
And `task.json` has `.result.thread_id` set to a non-empty string (captured as `TID`)
And `task.json` has `.result.logs.events` pointing at an existing file path (captured as `EVENTS`)
And `$EVENTS` contains exactly one line matching `^\[PLAN\] `
And `$SESSION_DIR/$TID.plan.md` exists and is non-empty
And the `TURN_PARAMS` record in `$SESSION_DIR/$TID.ndjson` has `.data.sandboxPolicy.type == "readOnly"` and `.data.effort == "xhigh"`

When I then run:
  ```sh
  bridge send "$TID" --mode default --json "Implement the plan." > send.json
  ```
Then `send.json` parses as a valid JSON object with `ok == true`
And `send.json` has `.result.phase` equal to `"done"` or `"incomplete"`
And `$CWD/index.html` exists on disk
And `$EVENTS` contains, in order: a line matching `^\[PIPELINE:diff\]`, one matching `^\[PIPELINE:review\]`, one matching `^\[PIPELINE:check\]`, and a terminal line matching `^\[(DONE|INCOMPLETE)\] `
And the second `TURN_PARAMS` record in `$SESSION_DIR/$TID.ndjson` has `.data.sandboxPolicy.type == "workspaceWrite"`

### Pass / fail predicate

```sh
# After running both bridge commands with output redirected to task.json and send.json:
TID=$(jq -r '.result.thread_id' task.json)
EVENTS=$(jq -r '.result.logs.events' task.json)

jq -e '.ok == true and .result.phase == "plan-pending"' task.json \
  && jq -e '.result.next_action.command | test("--mode default")' task.json \
  && jq -e '.ok == true and (.result.phase | IN("done","incomplete"))' send.json \
  && test -f "$CWD/index.html" \
  && test "$(grep -c '^\[PLAN\] ' "$EVENTS")" = "1" \
  && grep -q '^\[PIPELINE:diff\]'   "$EVENTS" \
  && grep -q '^\[PIPELINE:review\]' "$EVENTS" \
  && grep -q '^\[PIPELINE:check\]'  "$EVENTS" \
  && grep -Eq '^\[(DONE|INCOMPLETE)\] ' "$EVENTS" \
  && jq -se '[.[] | select(.tag == "TURN_PARAMS")][0].data.sandboxPolicy.type == "readOnly"
             and [.[] | select(.tag == "TURN_PARAMS")][0].data.effort == "xhigh"' "$SESSION_DIR/$TID.ndjson" \
  && jq -se '[.[] | select(.tag == "TURN_PARAMS")][1].data.sandboxPolicy.type == "workspaceWrite"' "$SESSION_DIR/$TID.ndjson"
```

### Enhancement candidates

If `[PLAN]` never fires but Codex produces a plan-shaped assistant message (the derailment SKILL.md explicitly warns about — "Codex's internal skills may override plan mode"), this scenario fails at `grep -c '^\[PLAN\] '`, pointing maintainers at the `formatPlanEvent` wiring in `src/lib/session-log.mjs:216` rather than at the pipeline. A concrete fix: the worker could detect plan-shaped text content and synthesize a `[PLAN]` tag so the invariant holds under upstream drift. The `sandboxPolicy.type` assertion (not `sandboxPolicy == "string"`) is load-bearing — `buildSandboxPolicy` returns an object (`{ type: "readOnly" }`), so a string comparison would silently pass a broken build.
