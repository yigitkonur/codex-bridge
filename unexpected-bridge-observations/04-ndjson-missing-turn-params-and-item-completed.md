# 04 — `.ndjson` missing `TURN_PARAMS` and `ITEM_COMPLETED` under superpowers

**Observed:** 2026-04-18, same run as observations 01–03.
**Thread:** `019da0d0-8e76-7ec3-bb0b-065ec6f7ae89`
**Codex version:** `codex-cli 0.104.0`

## Full `.ndjson` contents

```
{"tag":"TURN_COMPLETED","method":"turn/completed","ts":"...:41.477Z","data":{...}}
{"tag":"PIPELINE_STAGE","method":null,"ts":"...:41.477Z","data":{"stage":"diff"}}
{"tag":"PIPELINE_STAGE","method":null,"ts":"...:41.503Z","data":{"stage":"review"}}
{"tag":"PIPELINE_ERROR","method":null,"ts":"...:45:41.697Z","data":{"completedStages":[...], "origin":"pipeline:diff", ...}}
```

4 lines. That's it.

## What should be there (per subagent + code inspection)

From `src/codex-bridge.mjs:1291` (citation verified): `logNdjson(session, "TURN_PARAMS", {...})` fires when a turn starts. The task output in `/tmp/task.json` clearly shows `[codex] Turn started (019da0d0-914f-7b11-9675-c3eded6a5035)` — the turn DID start. So `TURN_PARAMS` *should* be the first line.

From `src/codex-bridge.mjs:1308`: `ITEM_COMPLETED` fires for each completed item on the root thread. The run's stdout shows at least 7 distinct items completed (assistant messages, reasoning summaries, command executions, apply_patch). Yet zero `ITEM_COMPLETED` records are in `.ndjson`.

## Why this matters

1. **`bridge summary <tid>` will produce a mostly-empty transcript** for any turn run under Codex's superpowers-style internal-skill chain. The subcommand reads `.ndjson` and replays items; missing items produce a stubbed report with just "turn completed" and "pipeline error."

2. **Predicates in our own specs rely on these records.** Examples:
   - `03-config/03-plan-mode-masks-effort-config.md` asserts `TURN_PARAMS.data.reasoning_effort == "xhigh"`. That record doesn't exist in this run → false negative.
   - `06-artifacts/01-events-ndjson-append-only.md` asserts tag-stream ordering including `TURN_PARAMS`. Same problem.
   - `07-orchestration/01-background-worker-ignores-mode-override.md` uses `TURN_PARAMS.data.collaborationMode.mode` for its core assertion.

3. **Retrospective debugging becomes hard.** If a user asks "why did my task not write the expected file?", the first place to look is `.ndjson` for the per-item trail. Under superpowers, that trail is gone — only the PIPELINE_* + TURN_COMPLETED records remain.

## Hypothesis on root cause

The bridge's `onItemCompleted` callback (`codex-bridge.mjs:1308`) filters by root-thread id. Codex's internal skills likely delegate to subagent threads — the assistant messages, reasoning, and tool calls all happen on *those* threads. Only the final aggregated `turn/completed` hits the root thread. Subagent item completions are never propagated up.

Alternatively: `onItemCompleted` requires the item type to be one of a known set (agentMessage, commandExecution, fileChange, plan, reasoning-summary). If Codex 0.104.0 emits items with new types that don't match the filter, they're silently dropped.

Neither hypothesis is verified without instrumenting the bridge. Worth a targeted probe.

## Suggested investigation / fix

1. **Log ALL item/completed events regardless of thread origin**, with a `data.thread == "root" | "subagent:<id>"` field. This keeps the transcript complete.
2. **Emit `TURN_PARAMS` as soon as `turn/start` confirms**, not after the first item event. If the bridge waits for the first root-thread item before writing TURN_PARAMS, and no root-thread items ever fire (this case), TURN_PARAMS never lands.
3. **Add a regression test asserting that `bridge summary` produces non-trivial output for any non-empty turn.** Currently spec `06-artifacts/01` asserts file growth, but growth could be just from PIPELINE_* records and not a meaningful replay.

## Addendum (2026-04-18 retest) — confirmed superpowers-specific

Ran the same `bridge task --mode default --write` against a cleaner fixture with Codex's backend restored. The resulting `.ndjson` had:

```
   6 ITEM_COMPLETED
   1 PIPELINE_COMPLETE
   3 PIPELINE_STAGE
   1 TURN_COMPLETED
   1 TURN_PARAMS
```

Both `TURN_PARAMS` AND `ITEM_COMPLETED` are present. Conclusion: **this is not a bridge regression — it's specifically Codex's superpowers skill chain dispatching work onto subagent threads that `onItemCompleted` (`codex-bridge.mjs:1308`) filters out, since the callback is gated to root-thread items only.** When the turn runs without superpowers interception, every item/completed on the root thread flows through normally.

This narrows the fix scope: instead of rewriting the bridge's item-logging logic, the root cause is a Codex prompt-footer / skill-disable question. Options:

1. **Strip superpowers skills from the bridge's prompt footer** when running rescue/review turns. The footer at `config.mjs` can name `"--skip-skill using-superpowers"` (if such a flag exists upstream) or similar.
2. **Log subagent thread items too**, accepting the noise. Change the filter on `codex-bridge.mjs:1308` from "root-thread-only" to "any thread, tagged with thread class". The summary command already knows how to filter back down if needed.
3. **Accept the reality** and update `bridge summary` to display "task executed via subagent delegation; see raw turn log" when root-thread ITEM_COMPLETED is empty but TURN_COMPLETED is present.

## Related

- `01-plan-mode-bypassed-by-superpowers-skills.md` — same root cause (Codex's internal skills routing).
- `gherkin-tests-v2/03-config/03-plan-mode-masks-effort-config.md` — predicate depends on TURN_PARAMS being present; in non-superpowers setups the predicate evaluates correctly (as this retest confirms).
- `gherkin-tests-v2/07-orchestration/01-background-worker-ignores-mode-override.md` — same.
