# XX-pipeline-done-tags-on-events

**Derived from:** `src/lib/session-log.mjs::formatPipelineEvent` (now accepts `suffix` and `detail`) and `src/lib/auto-pipeline.mjs` (emits `[PIPELINE:diff:done]`, `[PIPELINE:review:done]`, `[PIPELINE:fix:done] files=[…]`, `[PIPELINE:check:done]`, and a terminal `[PIPELINE:done]` / `[PIPELINE:failed]`). Pre-1.2.5 only start-tags were written; an orchestrator tailing `events --follow --filter PIPELINE` could see `[PIPELINE:review]` but nothing telling it the review stage had finished. `runAutoPipeline` also returns `touchedFiles` which surfaces as `result.pipeline.touchedFiles` on `task --json`.
**What this catches:** (a) every pipeline stage has a symmetric start/done pair in `.events`. (b) The terminal `[PIPELINE:done]` or `[PIPELINE:failed]` exists and carries a `stages=…` detail. (c) `result.pipeline.touchedFiles` is defined (possibly empty array) on completed task envelopes when auto_review was on.
**Runtime cost:** scenario 1 is live-Codex-dependent (auto_review must actually run); scenario 2 is smokeable via a synthetic events file.

## Feature: `[PIPELINE:*]` start + done tags are symmetric

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

### Scenario 1: formatPipelineEvent accepts suffix (smokeable via unit)

Given a direct import of `formatPipelineEvent({session:{threadId:"x"}}, {stage:"fix", suffix:"done", detail:"files=[a,b]"})`
When I invoke it
Then the returned string matches `/^\[PIPELINE:fix:done\] \d{2}:\d{2}:\d{2} files=\[a,b\]$/`
And when called without `suffix`, it still returns `[PIPELINE:fix] HH:MM:SS` (regression guard)

### Scenario 2: live pipeline events have start+done for every stage (requires Codex + auto_review)

Given Codex is authenticated and `config.auto_review: true`
When I launch `bridge task --write --mode default "echo ok; touch /tmp/ok" --json` and wait for it to complete
And I read the `.events` file at `result.eventsPath`
Then for every tag `[PIPELINE:<stage>]` present (stage ∈ {diff, review, fix, check}), there is a matching `[PIPELINE:<stage>:done]`
And there is a terminal `[PIPELINE:done]` (or `[PIPELINE:failed]` on error) with `stages=…` detail
And `result.pipeline.touchedFiles` is an array in the envelope (may be empty for no-fix runs)

### Scenario 3: `--no-pipeline` suppresses every [PIPELINE:*] tag (requires Codex)

Given Codex is authenticated
When I launch `bridge task --write --mode default --no-pipeline "echo ok" --json` and wait for completion
Then the `.events` file has **zero** `[PIPELINE:*]` lines
And `result.phase` is `done` (no pipeline means no incomplete path)
And the ndjson log has a `PIPELINE_SKIPPED` entry with `reason: "--no-pipeline flag"`

### Pass / fail predicate

```bash
# Scenario 1: unit-style via node -e
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
out=$(node -e "
  import('${REPO_ROOT}/src/lib/session-log.mjs').then(m => {
    const s = {threadId:'x'};
    const a = m.formatPipelineEvent(s, {stage:'fix', suffix:'done', detail:'files=[a,b]'});
    const b = m.formatPipelineEvent(s, {stage:'fix'});
    console.log(a); console.log(b);
  });
")
echo "$out" | grep -Eq '^\[PIPELINE:fix:done\] [0-9:]+ files=\[a,b\]$' && \
  echo "$out" | grep -Eq '^\[PIPELINE:fix\] [0-9:]+$' && \
  echo "XX-s1 PASS" || echo "XX-s1 FAIL"

# Scenarios 2 + 3 require live Codex — documented as SKIPPED stubs.
```

### Enhancement candidates

- Consider emitting a `[PIPELINE:skipped]` terminal tag when `--no-pipeline` is in effect, so `events --follow --filter PIPELINE` sees *something* for that run. Currently the events file just omits pipeline tags entirely; downstream tools expecting a pair may prefer an explicit skipped sentinel.
- If future stages are added (e.g. `[PIPELINE:test]`), their start/done pair must be emitted with matching suffix handling.
