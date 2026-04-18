# 03 — `next_action.description` misleads orchestrator when pipeline stalls

**Observed:** 2026-04-18, same run as observations 01 + 02.
**File:** `/tmp/task.json` (preserved for this session).

## The envelope

```json
{
  "ok": true,
  "result": {
    "phase": "incomplete",
    "next_action": {
      "command": "node …/codex-bridge.mjs send 019da0d0-… \"Complete the missing items\"",
      "description": "Codex's completion check flagged gaps. Read [INCOMPLETE] in events for specifics."
    },
    "pipeline": {
      "complete": false,
      "completedStages": ["diff"],
      "duration": 300,
      "error": "auto-review exceeded 5m"
    }
  }
}
```

The `.events` file at that moment:
```
[PIPELINE:diff]
[PIPELINE:review]
[ERROR] … | ClientTimeout
  auto-review exceeded 5m
  origin: pipeline:diff
  phase: pipeline (completed: diff)
```

No `[INCOMPLETE]` was ever written.

## The problem

`next_action.description` tells the user **"Codex's completion check flagged gaps"**. That is false. Reality:

- The completion check stage never ran. `completedStages: ["diff"]` confirms only the diff stage finished.
- The `[INCOMPLETE]` event `next_action.description` tells the user to read is not present in `.events` — the terminal event is `[ERROR]`.
- The pipeline failed at the review stage, not the check stage.

The text was written for the happy-path incomplete case (completion check returned `complete: false, missing_items: […]`) and is being reused on the sad-path timeout case. An orchestrator reading this will:

1. Trust the description literally.
2. Run `send … "Complete the missing items"`.
3. Codex then receives a prompt to fix nothing in particular, because the review was never completed, and the missing items list was never populated by the check stage.
4. The new turn will either hallucinate what needed fixing, or produce a non-sequitur.

## Why this is a derailment

`SKILL.md` documents the `[ERROR]` ambiguity but does not flag `next_action.description` as a further source of confusion. A careful orchestrator parsing `pipeline.error` can infer the real state, but the description field directs them the wrong way.

## Suggested fix (one-line change scope)

In `src/codex-bridge.mjs` where `next_action` is constructed for the `incomplete` phase, branch on whether `pipeline.error` is set:

```js
next_action = pipeline?.error
  ? {
      command: `node … result ${jobId}`,
      description: `Pipeline stalled at stage ${pipeline.completedStages.at(-1) ?? 'diff'}. Read result for the partial state; consider retrying with auto_review: false.`,
    }
  : {
      command: `node … send ${threadId} "Complete the missing items"`,
      description: "Codex's completion check flagged gaps. Read [INCOMPLETE] in events for specifics.",
    };
```

Doesn't change envelope shape; just makes the text truthful when the pipeline stalled.

## Related

- `gherkin-tests-v2/05-ambiguities/01-pipeline-error-coexists-with-ok-true.md` — companion ambiguity.
- Observation 02 — root cause of the stall.
