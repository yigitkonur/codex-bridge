# 03-plan-mode-masks-effort-config

**Derived from:** `src/lib/config.mjs:56` (`const effort = mode === "plan" ? "xhigh" : resolveEffort(config, options);`), `src/lib/config.mjs:43-45` (`resolveEffort`), root `AGENTS.md` Cross-cutting convention #7 ("Plan mode forces `effort: \"xhigh\"` regardless of config"), and `src/lib/AGENTS.md` "Config / template cluster".
**What this catches:** Regression where plan-mode reasoning effort becomes overridable by either `config.effort` or `--effort <x>` on the CLI — the whole point of plan mode is deep reasoning, and a silent downgrade to `low` would degrade every `[PLAN]` the skill produces. Conversely, a bug that locked execute-mode turns to `xhigh` would overbill users; the contrast scenario below guards that.
**Runtime cost:** medium
**Test subject:** single-page HTML site

## Feature: plan mode forces reasoning_effort=xhigh; default mode respects config + CLI

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

Given `config.yaml` resolves with `codex_bridge.effort: "low"` and `codex_bridge.mode: "plan"`
And `cwd` is a clean git repo
And the task under test is "build a single-page HTML site with a hero, a feature list, and a footer"

### Scenario: CLI --effort medium is ignored in plan mode

Given the user runs `bridge task --json --effort medium "build a single-page HTML site …"`
When `buildCollaborationMode("plan", config, { effort: "medium" })` is invoked
Then the outbound `turn/start` params have `collaborationMode.settings.reasoning_effort == "xhigh"`
And the corresponding `.ndjson` `TURN_PARAMS` record has `data.reasoning_effort == "xhigh"`
And no warning is emitted in `.events` about the override (known silent behavior; asserting it guards against a future UX change being introduced accidentally)
And the envelope `result` surfaces no `warnings[]` entry for the override

### Scenario: after plan approval, default mode respects --effort medium

Given the plan turn has emitted `[PLAN]` and the user has approved it
And the thread id is `$TID`
When the user runs `bridge send $TID --mode default --effort medium --json "approved, proceed"`
Then the outbound `turn/start` params have `collaborationMode.settings.reasoning_effort == "medium"`
And the `.ndjson` `TURN_PARAMS` record for that second turn has `data.reasoning_effort == "medium"`
And the first turn's `TURN_PARAMS` still reads `"xhigh"` — confirming both arms of the ternary in `config.mjs:56`

### Pass / fail predicate

```sh
NDJSON=~/.codex-bridge/sessions/${TID}.ndjson
# First turn: plan → xhigh regardless of CLI flag
jq -se 'map(select(.tag=="TURN_PARAMS"))[0].data.reasoning_effort == "xhigh"' "$NDJSON" \
  && jq -se 'map(select(.tag=="TURN_PARAMS"))[1].data.reasoning_effort == "medium"' "$NDJSON" \
  && ! grep -q -i 'override' ~/.codex-bridge/sessions/${TID}.events
```

### Enhancement candidates

- Emit a `[CONFIG_OVERRIDE]` event tag when `options.effort` is supplied but masked by plan mode, so the user sees why their flag had no effect. This test's "no warning" clause becomes the inverse assertion and forces a coordinated update to `skill/references/notification-format.md`.
- If the mask is ever removed (plan mode respects `--effort`), this contract breaks at the commit that also needs to update root `AGENTS.md` convention #7 and `SKILL.md`. That co-located failure is the feature.
- A `$BRIDGE config explain` subcommand could print the resolved `(mode, effort, model)` tuple before the turn starts — eliminating the need to grep `.ndjson` to confirm what was actually sent on the wire.
