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

### Observed derailment (2026-04-18)

Running this scenario end-to-end against Codex `codex-cli 0.104.0` produced the following failure, recorded in `unexpected-bridge-observations/01-plan-mode-bypassed-by-superpowers-skills.md`:

- `[PLAN]` never appeared in `$EVENTS`.
- `$SESSION_DIR/$TID.plan.md` was never written (the `writePlan` guard in `codex-bridge.mjs:1422` needs `result.planDetected && result.planText`; `planDetected` is set only on `item/completed` with `type: "plan"`, which Codex's `using-superpowers` + `brainstorming` internal-skill chain skips).
- `index.html` was written to disk during the plan turn despite `config.mode: plan` supposedly forcing a `readOnly` sandbox.
- The auto-pipeline then stalled at the review stage for 5 minutes, producing the `[ERROR] origin: pipeline:diff` + `ok:true, phase:incomplete` ambiguity documented in `05-ambiguities/01-pipeline-error-coexists-with-ok-true.md`.

**Consequence:** every assertion after "envelope parses and `ok == true`" fails on a realistic user setup. The scenario is **aspirational** until one of the enhancement paths below lands.

### Enhancement candidates

1. **Bridge-side plan synthesis.** If Codex's internal-skill chain writes files during a plan-mode turn without emitting a `type:plan` item, the bridge can synthesize a `[PLAN]` from the assistant message content before the turn completes. Keeps the invariant for downstream consumers.
2. **Hard sandbox enforcement.** Plan mode's `readOnly` sandbox policy should be enforced at the bridge layer (reject `apply_patch` calls) rather than relied upon to propagate through Codex's own machinery. This observation proves the propagation is leaky under superpowers.
3. **Scenario split.** Keep this file as the "ideal contract" scenario — document what the skill SHOULD do — and add a sibling `01b-plan-bypassed-by-internal-skills.md` that asserts the current reality (no `[PLAN]`, writes happen, `[PIPELINE:*]` still runs). The two together form a regression test *and* a known-derailment record.
4. **Assertion robustness.** The `sandboxPolicy.type` jq path (not `sandboxPolicy == "string"`) is load-bearing because `buildSandboxPolicy` returns an object. Verified correct here.
