# 02-plan-revision-cycle

**Derived from:** `src/codex-bridge.mjs:2178` (`effort: normalizeReasoningEffort(options.effort ?? config.effort)` — `send` passthrough), `src/lib/config.mjs:51–56` (`buildCollaborationMode("plan", …)` forces `effort: "xhigh"` and `buildSandboxPolicy("plan")` returns `{ type: "readOnly" }`), `skill/SKILL.md` section "[PLAN] — Codex produced a plan" (guidance that a follow-up `send` without `--mode` stays in plan mode).
**What this catches:** Guards the rule that `bridge send <tid> "…"` **without** `--mode default` keeps the thread in plan mode: no sandbox escalation, no auto-pipeline tags, only another `[PLAN]` line in the events file. It also pins that `.plan.md` is **overwritten** (not appended) on each plan turn — callers use the artifact path printed in the `[PLAN]` line and expect fresh content, not a concatenation of revisions.
**Runtime cost:** slow (two plan-mode turns; no execution, so faster than 01, typically 2–4 min)
**Test subject:** single-page HTML site with hero, feature list, and footer

## Feature: Revising a plan before approval

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

Given Codex CLI is installed on `$PATH` and authenticated
And `npm run build` has been run since the last `src/` edit
And `CWD=$TMPDIR/html-site` is a clean git repo
And resolved config is `mode: plan`, `auto_review: true`, default `prompt_footer`

### Scenario: second `send` without `--mode` produces a revised plan and does not execute

Given I have already run:
  ```sh
  bridge task --json "build a single-page HTML site with a hero, a 3-item feature list, and a footer" \
    > task1.json
  ```
And `task1.json` has `.result.phase == "plan-pending"` with `.result.thread_id` captured as `TID`
And `$SESSION_DIR/$TID.events` contains exactly one line matching `^\[PLAN\] `
And `$SESSION_DIR/$TID.plan.md` contains plan text that mentions "flexbox" (Codex's first plan mentions flex layout)

When I run:
  ```sh
  bridge send "$TID" --json "Revise step 3 — use CSS grid instead of flexbox" > send.json
  ```
Then `send.json` parses as a valid JSON object with `ok == true`
And `send.json` has `.result.phase == "plan-pending"` (still in plan mode — no `--mode default` was passed)
And `send.json` has `.result.thread_id == "$TID"` (same thread)
And `$SESSION_DIR/$TID.events` now contains exactly **two** lines matching `^\[PLAN\] `
And `$SESSION_DIR/$TID.plan.md` contains "grid" and does **not** contain "flexbox" (file was **overwritten**, not appended)
And `$SESSION_DIR/$TID.events` contains **zero** lines matching `^\[PIPELINE:`
And `$CWD/index.html` does **not** exist

### Pass / fail predicate

```sh
TID=$(jq -r '.result.thread_id' task1.json)
EVENTS="$SESSION_DIR/$TID.events"
PLAN="$SESSION_DIR/$TID.plan.md"
NDJSON="$SESSION_DIR/$TID.ndjson"

jq -e '.ok == true and .result.phase == "plan-pending"' send.json \
  && jq -e --arg tid "$TID" '.result.thread_id == $tid' send.json \
  && test "$(grep -c '^\[PLAN\] ' "$EVENTS")" = "2" \
  && ! grep -q '^\[PIPELINE:' "$EVENTS" \
  && grep -q 'grid'     "$PLAN" \
  && ! grep -q 'flexbox' "$PLAN" \
  && test ! -f "$CWD/index.html" \
  && jq -se '[.[] | select(.tag == "TURN_PARAMS")][1].data.sandboxPolicy.type == "readOnly"
             and [.[] | select(.tag == "TURN_PARAMS")][1].data.effort == "xhigh"' "$NDJSON"
```

### Enhancement candidates

If a future refactor makes `send` default to `--mode default` once a plan exists, the `.result.phase == "plan-pending"` assertion fails and surfaces the regression immediately. If `.plan.md` is ever changed to append rather than overwrite, the `! grep -q 'flexbox'` assertion fails — this matters because `[PLAN]` lines point agents at `plan.md` as the *current* plan, so stale content would silently mislead callers. The `sandboxPolicy.type` assertion (object field, not string equality) prevents a class of silent regressions where the ndjson shape drifts — `buildSandboxPolicy` always returns `{ type: "..." }` per `src/lib/config.mjs:68–75`, so string comparison would pass on a broken build. A natural improvement the failure would motivate: emit a `[PLAN:revised]` sub-tag so downstream consumers can distinguish initial vs. revised plans without counting `[PLAN]` occurrences, and add a `revision_count` field in the `TURN_PARAMS` ndjson record so tooling knows how many planning rounds have run.
