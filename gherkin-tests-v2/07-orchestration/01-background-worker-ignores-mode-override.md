# 01-background-worker-ignores-mode-override

**Derived from:** `src/codex-bridge.mjs:1534` (background branch of `handleTask` builds the job request with `mode: options.mode ?? null`), `src/codex-bridge.mjs:1278` (`isPlanMode = config.mode === "plan" && !request.resumeLast` — worker reads `config`, not the override), `src/lib/config.mjs` `buildCollaborationMode("plan", ...)` pins `effort: "xhigh"` + `sandboxPolicy: readOnly`, `skill/SKILL.md` ("Foreground only: `task --background --mode default` stores the override in the job record but the detached worker still reads `config.mode`").
**What this catches:** The currently-shipped derailment where a user with `config.mode: plan` types `task --background --mode default` expecting an executed turn and silently gets a plan turn instead. If the worker is ever fixed to honor the job-record override, scenario 1 breaks and this spec is the migration signal. If the foreground path regresses and *also* starts ignoring `--mode`, scenario-1-style PLAN output would appear in foreground too — scenario 2's `default`-config counterpart catches that collateral.
**Runtime cost:** slow (two real background Codex turns, ~3–6 min each)
**Test subject:** single-page HTML site in `$TMPDIR/html-site` (clean git repo, no staged changes)

## Feature: background worker ignores `--mode` override

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

Given Codex CLI is installed on `$PATH` and `codex login` has succeeded
And `npm run build` has been run since the last `src/` edit
And `cwd = $TMPDIR/html-site` is a clean git repo
And `CODEX_COMPANION_SESSION_ID` is set to a fresh uuid per scenario

### Scenario: config.mode=plan + `--mode default` still runs a PLAN turn

**Requires live Codex run — runtime cost: slow (~3–6 min). Skip in fast CI; run manually.**

Given the skill's `config.yaml` resolves to `mode: plan`, `auto_review: true`
When I run `bridge task --background --mode default --write --json "build a single-page HTML site"`
Then stdout parses as a single envelope with `ok == true` and a `result.jobId` of the form `task-[0-9a-f]{6,}`
And the command returns immediately (elapsed < 3 s)
When I then run `bridge wait <jobId> --timeout-ms 600000 --json`
Then the `.ndjson` file's first `TURN_PARAMS` row records `data.collaborationMode.mode == "plan"` (the override was dropped)
And that same row records `data.sandboxPolicy == "readOnly"` and `data.effort == "xhigh"`
And the events file contains exactly one `[PLAN] ` line
And the events file contains no `[PIPELINE:diff]`, `[PIPELINE:review]`, `[PIPELINE:check]`, or `[DONE]` line

### Scenario: config.mode=default + `--mode default` behaves as expected (control)

**Requires live Codex run — runtime cost: slow (~3–6 min). Skip in fast CI; run manually.**

Given the skill's `config.yaml` resolves to `mode: default`, `auto_review: true`
When I run `bridge task --background --mode default --write --json "build a single-page HTML site"`
And I run `bridge wait <jobId> --timeout-ms 600000 --json`
Then the `.ndjson` first `TURN_PARAMS` row records `data.collaborationMode.mode == "default"`
And `data.sandboxPolicy == "workspaceWrite"`
And the events file contains `[PIPELINE:diff]`, `[PIPELINE:review]`, `[PIPELINE:check]`, and a terminal `[DONE]` or `[INCOMPLETE]`

### Pass / fail predicate

```sh
# Scenario 1 (plan-config background, default-override dropped)
jq -se 'map(select(.tag=="TURN_PARAMS"))[0].data.collaborationMode.mode == "plan"' "$NDJSON_1"  \
  && jq -se 'map(select(.tag=="TURN_PARAMS"))[0].data.sandboxPolicy == "readOnly"' "$NDJSON_1" \
  && test "$(grep -c '^\[PLAN\] ' "$EVENTS_1")" = "1" \
  && ! grep -Eq '^\[(PIPELINE:|DONE|INCOMPLETE)' "$EVENTS_1"

# Scenario 2 (default-config control)
jq -se 'map(select(.tag=="TURN_PARAMS"))[0].data.collaborationMode.mode == "default"' "$NDJSON_2" \
  && grep -q '\[PIPELINE:diff\]'   "$EVENTS_2" \
  && grep -Eq '^\[(DONE|INCOMPLETE)\] ' "$EVENTS_2"
```

### Enhancement candidates

The obvious fix is to have `handleTaskWorker` read the job-record's `mode` and pass it into `buildCollaborationMode` instead of `config.mode`. When that lands, scenario 1 should flip to expect `mode == "default"` and a `[DONE]`. A softer fix is a `--persist-config` flag on `task --background` that rewrites `config.yaml` for the worker's lifetime. Either way, the spec becomes the migration checklist; a regression that re-introduces the silent drop is caught at the first `TURN_PARAMS` assertion. Also useful as documentation for support: "to background-run in a different mode than config, edit `skill/config.yaml` first."
