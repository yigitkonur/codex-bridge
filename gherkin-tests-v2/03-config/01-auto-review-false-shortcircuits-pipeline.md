# 01-auto-review-false-shortcircuits-pipeline

**Derived from:** `src/lib/auto-pipeline.mjs:72` (`if (config.auto_review)` gate), `src/lib/auto-pipeline.mjs:98` (fix stage guarded by `reviewFindings.length > 0`), `src/lib/auto-pipeline.mjs:137` (check gate on `post_task_prompt`). Also `src/lib/AGENTS.md` Orchestration cluster and `skill/references/notification-format.md` (event tag catalog).
**What this catches:** Regression where disabling `auto_review` still triggers the review Codex turn (or the fix turn), silently burning tokens and mutating files the user opted out of reviewing. Also guards the converse: a refactor that accidentally makes the completion-check depend on `auto_review` being true.
**Runtime cost:** medium
**Test subject:** single-page HTML site

## Feature: auto_review: false skips review + fix but not check

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

Given `config.yaml` resolves with `codex_bridge.auto_review: false`
And `codex_bridge.post_task_prompt` is left at the default non-empty string
And `CLAUDE_PLUGIN_DATA` points at an empty scratch state dir
And `cwd` is a clean git repo with no prior history for the thread

### Scenario: pipeline emits only diff + check stages

Given the user runs `bridge task --write --json "build a single-page HTML site with a hero, a feature list, and a footer"`
When `runAutoPipeline` executes after the execute turn writes files
Then the `.events` file contains exactly one `[PIPELINE:diff]` line
And the `.events` file contains zero `[PIPELINE:review]` lines
And the `.events` file contains zero `[PIPELINE:fix]` lines
And the `.events` file contains exactly one `[PIPELINE:check]` line
And the `.ndjson` file contains `PIPELINE_STAGE` records for `diff` and `check` only
And the terminal tag is `[DONE]` (because the default `completionResult` stays `complete: true` unless the check proves otherwise)

### Scenario: sync envelope mirrors the skipped stages

Given the same invocation as above (using `bridge task`)
When the CLI prints the `--json` envelope
Then `result.pipeline.completedStages` is `["diff", "check"]`
And `result.pipeline.completedStages` does NOT contain `"review"` or `"review-failed"`
And `result.phase` is `"complete"`

### Pass / fail predicate

```sh
EVENTS=~/.codex-bridge/sessions/${THREAD_ID}.events
[ "$(grep -c 'PIPELINE:review' "$EVENTS")" = "0" ] \
  && [ "$(grep -c 'PIPELINE:fix' "$EVENTS")" = "0" ] \
  && [ "$(grep -c 'PIPELINE:diff' "$EVENTS")" = "1" ] \
  && [ "$(grep -c 'PIPELINE:check' "$EVENTS")" = "1" ] \
  && jq -e '.result.pipeline.completedStages == ["diff","check"]' envelope.json
```

### Enhancement candidates

- If someone lands a "quick review only when `auto_review: false`" variant, this contract forces them to introduce a third-state config (`auto_review: "quick" | true | false`) instead of overloading the boolean.
- A lint rule in `src/lib/config.mjs` could warn when `auto_review: false` and `post_task_prompt` is also empty, since that collapses the pipeline to a single `diff` stage — surprising for users who expected some postflight work.
- Add a matching assertion in `test-gherkin/08-config-system.feature` so the contract is reachable from both the config-feature index and this numbered v2 file.
