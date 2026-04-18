# 03-direct-default-mode-skips-plan

**Derived from:** `src/lib/config.mjs:68–75` (`buildSandboxPolicy` returns `{ type: "workspaceWrite" }` for `"default"` and `{ type: "readOnly" }` for any other value), `src/codex-bridge.mjs:1283–1286` (sandbox and effort resolution: plan mode forces `sandboxPolicy: buildSandboxPolicy("plan")` and `effort: "xhigh"`, `--write` alone with plan config sets `sandboxPolicy: buildSandboxPolicy("default")` only on the non-plan branch), `skill/SKILL.md` caveat "`--write` is not enough on the first turn — first-turn plan mode ignores `--write`".
**What this catches:** Two asymmetric invariants in one file. (a) `bridge task --mode default --write` explicitly bypasses plan mode even when the user's config is `mode: plan`; a regression that re-forced plan would break power users who script straight-to-execution. (b) `bridge task --write` alone (no `--mode default`) does **not** escalate out of plan mode — `--write` is silently ignored on turn 1. `TURN_PARAMS.data.sandboxPolicy.type` is the ground-truth signal because it is what the upstream Codex server receives.
**Runtime cost:** slow (two separate task runs, one of which writes files; 3–6 min)
**Test subject:** single-page HTML site with hero, feature list, and footer

## Feature: `--mode default` overrides config `mode: plan`; bare `--write` does not

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

Given Codex CLI is installed and authenticated
And `npm run build` has been run since the last `src/` edit
And resolved config is `mode: plan` (user-level default in `config.yaml`)
And `CWD_A=$TMPDIR/html-site-a` and `CWD_B=$TMPDIR/html-site-b` each exist as fresh clean git repos

### Scenario A: `--mode default --write` executes without plan-pending

Given the workspace at `CWD_A` as working directory
When I run:
  ```sh
  bridge task --mode default --write --json \
    "build a single-page HTML site with a hero, a 3-item feature list, and a footer" \
    > taskA.json
  ```
Then `taskA.json` has `.ok == true`
And `taskA.json` has `.result.phase` equal to `"done"` or `"incomplete"` (never `"plan-pending"`)
And `$CWD_A/index.html` exists on disk
And the first `TURN_PARAMS` record in `$SESSION_DIR/$TID_A.ndjson` has `.data.sandboxPolicy.type == "workspaceWrite"`

### Scenario B (contrast): `--write` alone stays in plan mode on turn 1

Given the workspace at `CWD_B` as working directory
When I run:
  ```sh
  bridge task --write --json \
    "build a single-page HTML site with a hero, a 3-item feature list, and a footer" \
    > taskB.json
  ```
Then `taskB.json` has `.ok == true` and `.result.phase == "plan-pending"`
And `$CWD_B/index.html` does **not** exist after this call
And the first `TURN_PARAMS` record in `$SESSION_DIR/$TID_B.ndjson` has `.data.sandboxPolicy.type == "readOnly"` (the `--write` flag was ignored on turn 1)
And `$SESSION_DIR/$TID_B.events` contains exactly one line matching `^\[PLAN\] `

### Pass / fail predicate

```sh
# Scenario A
TID_A=$(jq -r '.result.thread_id' taskA.json)
jq -e '.ok == true and (.result.phase | IN("done","incomplete"))' taskA.json \
  && test -f "$CWD_A/index.html" \
  && jq -se '[.[] | select(.tag == "TURN_PARAMS")][0].data.sandboxPolicy.type == "workspaceWrite"' \
       "$SESSION_DIR/$TID_A.ndjson"

# Scenario B (contrast)
TID_B=$(jq -r '.result.thread_id' taskB.json)
jq -e '.ok == true and .result.phase == "plan-pending"' taskB.json \
  && test ! -f "$CWD_B/index.html" \
  && jq -se '[.[] | select(.tag == "TURN_PARAMS")][0].data.sandboxPolicy.type == "readOnly"' \
       "$SESSION_DIR/$TID_B.ndjson" \
  && test "$(grep -c '^\[PLAN\] ' "$SESSION_DIR/$TID_B.events")" = "1"
```

### Enhancement candidates

Documents the `--write` semantic that repeatedly bites new users — SKILL.md explicitly warns about it, and this spec pins the current behavior so a well-intentioned "`--write` should just work" PR gets caught in review. The `sandboxPolicy.type` assertion (not a bare string comparison) is the concrete signal: `buildSandboxPolicy` always returns `{ type: "..." }`, so any test that compares against a plain string would silently pass a broken build. A natural improvement the failure would motivate: when `--write` is passed without `--mode default` and config is `mode: plan`, emit a `meta.warnings[]` entry such as `"--write is inert in plan mode on turn 1; pass --mode default to execute"` in the envelope so scripted callers can surface it instead of silently getting a plan they did not want.
