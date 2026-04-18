# 01-pipeline-error-coexists-with-ok-true

**Derived from:** `src/lib/auto-pipeline.mjs:237-276` (outer `catch` branch formatting `[ERROR] origin: pipeline:<stage>` and returning `{ complete: false, completedStages, error }`), `src/codex-bridge.mjs` `runBridgeTask:1452-1461` (phase is set from `pipelineResult.complete === false`, not from the presence of `pipeline.error`), `skill/SKILL.md` "Heads up — `[ERROR]` is ambiguous" section. See `src/lib/AGENTS.md` Orchestration cluster for the `PIPELINE_TIMEOUT_MS = 15 min` / `STAGE_TIMEOUT_MS = 5 min` constants.
**What this catches:** The documented ambiguity where a pipeline-stage timeout emits `[ERROR]` on the tailed events channel but the synchronous `--json` envelope returns `ok: true` with `result.phase: "incomplete"` plus a populated `result.pipeline.error`. Tail-based Monitor tools self-terminate on `[ERROR]` and report failure, while an agent branching on `$?` or `.ok` alone sees success. Locking the shape here means any resolution of the ambiguity (e.g. `ok: false`) is an intentional breaking change, not a drift.
**Runtime cost:** slow (requires provoking a stage timeout)
**Test subject:** single-page HTML site

## Feature: pipeline stage timeout surfaces dual-channel ambiguity

### Background

```sh
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

Given `bridge()` is defined as above (see "Which binary the specs target" in AGENTS.md — the function form is required for bash and zsh portability)
And `npm run build` has been run since the last `src/` edit
And `config.yaml` resolves with `auto_review: true` and a non-empty `post_task_prompt`
And the review stage is made to exceed `STAGE_TIMEOUT_MS` — the canonical trigger is a model/backend stall, reproducible in a test harness by setting `STAGE_TIMEOUT_MS` to a small value via a patched build OR by stubbing `runAppServerReview` to never resolve
And `cwd` is a clean git repo containing only the freshly generated HTML site

### Scenario: review stage times out — events channel shows [ERROR], envelope shows ok:true

Given the user runs `bridge task --write --json "build a single-page HTML site with a hero, a feature list, and a footer"`
When the execute turn succeeds and the review stage never resolves within `STAGE_TIMEOUT_MS`
Then `.events` contains `[PIPELINE:diff]` followed by `[PIPELINE:review]`
And `.events` contains an `[ERROR]` line whose `origin:` field equals `pipeline:diff`
  - **Why `pipeline:diff` not `pipeline:review`:** `auto-pipeline.mjs:252-253` computes `origin = pipeline:${lastCompletedStage}` where `lastCompletedStage = completedStages[completedStages.length - 1] ?? "pipeline"`. Because the review stage timed out without pushing to `completedStages`, the last entry in that array is `"diff"`. The failing stage is NOT used — only the last stage that successfully completed is.
And `.ndjson` has a `PIPELINE_ERROR` record with `data.completedStages` = `["diff"]` and `data.origin == "pipeline:diff"`
And the `--json` envelope has `ok: true`
And the envelope has `result.phase == "incomplete"`
  - **Why `incomplete` not `error`:** `runBridgeTask:1452` checks `pipelineResult?.complete === false` to set phase, not the presence of `pipeline.error`. A pipeline with an error that returns `complete: false` resolves to `phase: "incomplete"`.
And the envelope has `result.pipeline.error` populated with the timeout message
And the envelope has `result.pipeline.completedStages` equal to `["diff"]`

### Scenario: disambiguation predicate

Given both channels are captured
When an agent wants to detect "silently-degraded pipeline"
Then the following jq expression returns `true` exactly in this ambiguous case:
`jq -e '.ok and ((.result.pipeline.error // null) != null) and (.result.phase == "incomplete")'`

### Pass / fail predicate

```sh
EVENTS=~/.codex-bridge/sessions/${TID}.events
grep -q '^\[ERROR\].*origin:[[:space:]]*pipeline:' "$EVENTS" \
  && grep -q '^\[ERROR\].*origin:[[:space:]]*pipeline:diff' "$EVENTS" \
  && jq -e '.ok and ((.result.pipeline.error // null) != null) and (.result.phase == "incomplete")' envelope.json \
  && jq -e '.result.pipeline.completedStages | index("review") == null' envelope.json \
  && jq -e '.result.pipeline.completedStages == ["diff"]' envelope.json
```

### Enhancement candidates

- Flip envelope `ok` to `false` whenever `result.pipeline.error` is set. This test then breaks, and the commit that resolves the ambiguity also updates `skill/SKILL.md` and the Monitor self-termination rule in lockstep.
- Introduce `result.status: "partial" | "complete" | "failed"` as a tri-state so tailing agents no longer have to AND two booleans. Current boolean `ok` stays stable for shell scripts; structured readers get a richer signal.
- Emit `[PIPELINE:timeout]` as a distinct tag alongside `[ERROR]` so terminal-tag parsers can distinguish a pipeline stall from a transport-level crash without reading `origin:`.
- Consider using the *failing* stage name (not the last *completed* stage) in `origin`. Currently `pipeline:diff` is emitted when the review stage times out; `pipeline:review` would be more intuitive. Changing it is a breaking format change — update `skill/references/notification-format.md`, this spec, and the pass/fail predicate atomically.
