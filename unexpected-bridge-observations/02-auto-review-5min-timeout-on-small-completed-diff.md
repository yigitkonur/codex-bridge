# 02 — auto-review stage stalls 5 min on a 5 KB diff

**Observed:** 2026-04-18 during live run of `gherkin-tests-v2/01-lifecycle/01-plan-approval-happy-path.md` (same run as observation 01).
**Codex version:** `codex-cli 0.104.0`
**Diff size:** 1 file, 5438 bytes, valid HTML.
**Time to timeout:** 300000 ms (5 min), matching `STAGE_TIMEOUT_MS` at `src/lib/auto-pipeline.mjs`.
**Meta duration from envelope:** `duration_ms: 426765` (~7 min total, of which 5 min was the review stage).

## What happened

After Codex wrote `index.html` (see observation 01), the bridge entered the auto-pipeline:

```
[PIPELINE:diff] 13:40:41
[PIPELINE:review] 13:40:41
[ERROR] 019da0d0-... failed | ClientTimeout
  auto-review exceeded 5m
  origin: pipeline:diff
  phase: pipeline (completed: diff)
```

The review stage was entered (`[PIPELINE:review]`) but no `item/completed` events from the review turn arrived within the 120 s bridge-level idle watchdog OR the 300 s stage-level budget. The stage threw `TimeoutError("auto-review exceeded 5m")`, which `auto-pipeline.mjs:237-276` caught, formatted as `[ERROR]`, and returned to `runBridgeTask` with `pipelineResult.complete = false`.

## Why this is a derailment

1. **`SKILL.md` warning was right, but understated.** SKILL.md says: *"With the default `auto_review: true`, a trivial prompt can stall 5–8 minutes while the reviewer times out with nothing to review."* Here the prompt was non-trivial (full HTML site with 3 sections) and the review STILL stalled on a 5 KB diff. The issue is not "reviewer times out with nothing to review" — the reviewer times out even WITH something to review, at least in this Codex version.

2. **Origin is `pipeline:diff`, not `pipeline:review`, even though review was the stage that stalled.** The `[ERROR]` line reads `origin: pipeline:diff`. Reading `auto-pipeline.mjs:252-253`:
   ```js
   const lastStage = completedStages[completedStages.length - 1] ?? "pipeline";
   const origin = `pipeline:${lastStage}`;
   ```
   `completedStages` tracks stages that *finished successfully*. Since review threw before push, `completedStages === ["diff"]`, so `origin` names the last completed stage, not the failing one. **The spec `05-ambiguities/01` had this right after correction; the ORIGINAL spec from the previous session had it wrong.** This observation is one more empirical confirmation.

3. **`next_action.description` is misleading.** The envelope's `next_action.description` reads:
   > Codex's completion check flagged gaps. Read [INCOMPLETE] in events for specifics.

   The completion check never ran — only diff stage completed. The missing items were never populated by the check stage; they were synthesized by the pipeline timeout path. An orchestrator reading `next_action.description` will believe the task made meaningful progress and will send a follow-up prompt that has no context of the actual failure mode.

## Root cause (hypothesis)

Two candidates:

- **Codex review subsystem slow for HTML diffs.** The native review command in Codex 0.104.0 may have an unbounded retry loop or a slow model on the backend. Measurable via direct `bridge review --scope working-tree --json` on the same fixture — if that also times out or takes >4 min, the review subsystem is at fault. If it's fast, the `auto-pipeline` code is passing different arguments and triggering a different model.

- **Model routing issue.** The envelope shows `"model": null` in the review turn params (need to verify via `.ndjson`). If the model isn't being set correctly for the review stage, Codex may fall back to a very slow model.

Neither has been isolated yet. Worth a targeted reproduction with `auto_review: false` then manual `bridge review` to compare.

## Suggested fixes (not implemented here)

1. **Tighter `next_action.description` on pipeline timeouts.** Differentiate between "completion check reported incomplete" and "pipeline stage timed out before completion check ran." Today both produce `phase: "incomplete"` but the user-visible reason differs.

2. **Shorter `STAGE_TIMEOUT_MS` default (2–3 min) + explicit retry.** 5 min per stage × up to 3 stages = 15 min worst case (confirmed by `PIPELINE_TIMEOUT_MS = 15 min`). For interactive skill use that's unacceptable. A 2-min per-stage timeout with a single retry would cap the worst case at 4 min per stage.

3. **Make `origin:` use the *failing* stage, not the last completed stage.** `origin: pipeline:review-failed` is immediately actionable; `origin: pipeline:diff` makes the user think the diff stage failed. Breaking change for any consumers of the `origin:` field.

4. **Surface the `config.auto_review` toggle more prominently in SKILL.md's troubleshooting.** Currently the only hint is a heads-up paragraph; elevating "If pipeline stages are timing out, set `auto_review: false` in config.yaml and invoke `bridge review` manually" to the troubleshooting section would save users from repeated 5-min stalls.

## Related

- `SKILL.md` "Heads up — sync `task --json` blocks through the entire auto-pipeline" paragraph.
- `gherkin-tests-v2/03-config/01-auto-review-false-shortcircuits-pipeline.md` — the documented workaround.
- `gherkin-tests-v2/05-ambiguities/01-pipeline-error-coexists-with-ok-true.md` — the envelope ambiguity this timeout produced.
