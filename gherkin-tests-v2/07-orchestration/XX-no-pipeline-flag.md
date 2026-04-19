# XX-no-pipeline-flag

**Derived from:** `src/codex-bridge.mjs::handleTask` accepts `--no-pipeline`; `buildTaskRequest` threads `noPipeline: Boolean(opt)` onto the request; `runBridgeTask` short-circuits `runAutoPipeline` when `request.noPipeline`, logs an ndjson `PIPELINE_SKIPPED` entry, and routes the success envelope through the same `[DONE]` path as configs with `auto_review:false` + `post_task_prompt:""`.
**What this catches:** a single-run override that lets an orchestrator own completion-checking without editing `config.yaml`. The auto-pipeline stages do not emit any events in this mode; only the execute turn's own `[DONE]` notification writes to the events file.
**Runtime cost:** requires live Codex.

## Feature: `--no-pipeline` skips the auto-review/fix/check stages for this one run

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

### Scenario 1: `--no-pipeline` on a config with auto_review:true

Given `config.yaml` has `auto_review: true` (default) and `post_task_prompt` set (default)
When I launch `bridge task --write --mode default --no-pipeline "echo ok" --json`
Then the `.events` file has NO `[PIPELINE:*]` lines (start or done)
And `.result.phase` is `"done"` (no `incomplete` path is reachable with pipeline off)
And the envelope omits `.result.pipeline` (or it is `null`/absent)
And the ndjson log at `${HOME}/.codex-bridge/sessions/<threadId>.ndjson` contains a line with `"tag":"PIPELINE_SKIPPED"` and `"reason":"--no-pipeline flag"`

### Scenario 2: `--no-pipeline` synopsis

Given I run `bridge task --help | head -1`
Then the synopsis includes `[--no-pipeline]`

### Scenario 3: without `--no-pipeline`, pipeline still runs

Given the same config.yaml
When I launch the same prompt without the flag
Then the `.events` file has at least one `[PIPELINE:*]` line (regression guard: default behavior is unchanged)

### Pass / fail predicate

```bash
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }

bridge task --help | head -1 | grep -q -- "--no-pipeline" && echo "s2 PASS" || echo "s2 FAIL"
# Scenarios 1 + 3 require live Codex — SKIPPED stubs.
```

### Enhancement candidates

- Emit an explicit `[PIPELINE:skipped]` tag in the events file so `events --follow --filter PIPELINE` sees *something* for runs where the flag is in effect.
- Consider a symmetric `--pipeline` force-on flag for configs with `auto_review:false`.
