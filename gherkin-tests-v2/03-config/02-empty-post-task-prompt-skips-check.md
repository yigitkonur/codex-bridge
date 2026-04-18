# 02-empty-post-task-prompt-skips-check

**Derived from:** `src/lib/auto-pipeline.mjs:135` (`let completionResult = { complete: true, ... }` initial state), `src/lib/auto-pipeline.mjs:137` (`if (config.post_task_prompt && config.post_task_prompt.trim())`), `src/lib/auto-pipeline.mjs:202` (terminal tag branch on `completionResult.complete`). See also `src/lib/AGENTS.md` "Config / template cluster" for the `DEFAULT_CONFIG.post_task_prompt` value.
**What this catches:** Regression where an empty `post_task_prompt` still triggers a completion-check turn (wasteful) or, worse, where the default `completionResult` flips to `complete: false` so that skipping the check emits an accidental `[INCOMPLETE]`. Also locks in the "fast path" config that end users rely on for quick iterations.
**Runtime cost:** medium
**Test subject:** single-page HTML site

## Feature: empty post_task_prompt skips the check stage entirely

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

Given `config.yaml` resolves with `codex_bridge.post_task_prompt: ""`
And `codex_bridge.auto_review: true`
And `codex_bridge.mode: "plan"` (default) with plan approval already granted so the run reaches execute
And `cwd` is a clean git repo

### Scenario: no check stage, terminal tag is [DONE]

Given the user runs `bridge task --write --json "build a single-page HTML site with a hero, a feature list, and a footer"`
When the pipeline completes after the execute turn
Then `.events` contains a `[PIPELINE:diff]` line
And `.events` contains a `[PIPELINE:review]` line
And `.events` MAY contain a `[PIPELINE:fix]` line depending on review verdict
And `.events` contains zero `[PIPELINE:check]` lines
And `.events` contains zero `[INCOMPLETE]` lines
And `.events` ends with exactly one `[DONE]` line
And `.ndjson` has no `PIPELINE_STAGE` record whose `data.stage == "check"`

### Scenario: envelope reports check as never-run

Given the same invocation (using `bridge task`)
When the CLI emits the `--json` envelope
Then `result.pipeline.completedStages` does NOT include `"check"` or `"check-failed"`
And `result.phase` is `"complete"`
And `result.completion.summary` is `"Complete"` (the initial-state string from line 135)

### Pass / fail predicate

```sh
EVENTS=~/.codex-bridge/sessions/${THREAD_ID}.events
! grep -q 'PIPELINE:check' "$EVENTS" \
  && ! grep -q '^\[INCOMPLETE\]' "$EVENTS" \
  && grep -q '^\[DONE\]' "$EVENTS" \
  && jq -e '.result.pipeline.completedStages | index("check") == null' envelope.json
```

### Enhancement candidates

- A `config.yaml` validation step could refuse `post_task_prompt: ""` unless the user also sets an explicit `skip_completion_check: true` key — this would make the intent visible instead of inferring it from a whitespace-only string.
- If a future "strict mode" forces a completion check regardless of `post_task_prompt`, this contract is the tripwire — failing here is the reminder to update `skill/references/config-reference.md` and the Gherkin in the same commit.
- Add an event tag `[PIPELINE:check-skipped]` at `auto-pipeline.mjs:137` so tailing agents can distinguish "skipped" from "ran and silently succeeded" without parsing the absence of a line.
