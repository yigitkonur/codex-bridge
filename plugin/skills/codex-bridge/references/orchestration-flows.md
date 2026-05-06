# Orchestration flow — one canonical loop

The full plan→execute→review→merge loop, written for an Opus-driver. `iterate` can run the multi-round task → review → verdict → follow-up loop, while the lower-level task, review, verdict, and merge commands remain available for manual recovery.

## The loop

```
Brief ──▶ task --background --write --brief ──▶ Monitor (verify armed)
                                                          │
                                              [PLAN]      │   [QUESTION]
                                                ▼         │     ▼
                                  approve via send       respond
                                                          ▼
                                                       [DONE] / [INCOMPLETE]
                                                          │
                                                          ▼
                              adversarial-review --task <task_id>
                                                          │
                                                          ▼
                                                  verdict.json written
                                              ┌───────────┼───────────┐
                                              │           │           │
                                          approved   needs-attention  must-fix
                                              │           │           │
                                              ▼           ▼           ▼
                                            merge   re-brief + rerun   discard
```

## Setup (once per task)

Compose a brief — see `brief-composition.md`. Save to `brief.json` near your work.

```json
{
  "goal": "Add retry/backoff to the upstream fetcher",
  "worker_assignment": "Implement exponential backoff with jitter, max 3 attempts; preserve the public API; cover with a unit test.",
  "specific_concerns": [
    "Don't swallow non-retryable 4xx upstream errors",
    "Make the timeout configurable via the existing Config object"
  ],
  "acceptance_criteria": ["npm test passes", "diff under 200 lines"]
}
```

## Dispatch

Either via slash command (preferred):

```
/codex-bridge:task --background --write --brief @brief.json implement the task described in the structured brief
```

Or directly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task \
  --background --write --json --brief @brief.json \
  "Implement the task described in the structured brief."
```

The PostToolUse(Bash|Agent) hook attempts to parse accepted bridge envelopes, capture `result.jobId`, and emit an `additionalContext` block with the literal Monitor invocation. If you see that block, arm Monitor with that exact payload. If it does not appear, use `result.monitor.tool_hint` from the dispatch envelope directly. `setup --install-monitor-hook` installs the user-settings mirror that makes this handoff more reliable on Claude Code versions where plugin-bundled `additionalContext` is dropped.

## Monitor

Monitor self-terminates on `[DONE]`/`[ERROR]`/`[INCOMPLETE]`/`[PLAN]`/`[CANCELLED]`. While it streams:

- **`[PLAN]`** → read it; either `send <thread-id> --mode default "Implement the plan."` to approve, or `send <thread-id> "Revise: …"` to push back.
- **`[QUESTION]`** → `respond <request-id> --question-id <qid> --answer "<label>"`.
- **`[CHECKPOINT_SUMMARY]`** → informational digest every ~5 min. Read for "what is Codex doing"; act only if it's drifting. Use verbose `[CHECKPOINT]` only when debugging.
- **`[STALL_WARNING]`** → no actionable progress for a barren checkpoint window. Inspect, steer, or cancel before terminal stall.
- **`[WARNING]`** → circuit-breaker fired. Cancel if the environment can't run that family; steer if Codex needs redirection.

## Review

When Monitor terminates, run a task-bound adversarial review. The bridge reads the task registry metadata, reviews the task worktree against its recorded base ref, persists `review.json`, and records the reviewed branch head used later by merge:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" adversarial-review --task <task_id> --brief @brief.json --json
```

Prefer `iterate` when you want the bridge to own the review/verdict loop:

```
/codex-bridge:iterate <task_id> --max 3 --brief @brief.json
```

It returns `approved`, `iteration-limit`, or an explicit incomplete status such as `task-failed`, `review-failed`, `verdict-failed`, or `follow-up-failed`, with artifact pointers under `result.iterations[]`.

## Verdict and merge

Prefer `iterate` for normal approval and follow-up. For manual recovery, run task-bound review and write the normalized review result through stdin so the verdict is bound to the reviewed branch head:

```
/codex-bridge:adversarial-review --task <task_id> --json
/codex-bridge:verdict <task_id> --payload-stdin --json
/codex-bridge:verdict <task_id> --discard
```

Pass `result.review_result` from the review JSON as the stdin payload. If approved: `/codex-bridge:merge <task_id>` fetches the recorded base ref, checks it out, and fast-forwards it to the task branch. The merge is gated — refuses when verdict is not approved, when the verdict is missing `branch_head_sha`, or when the current branch head no longer matches the reviewed head. Run acceptance tests yourself before merging.

Before stopping, run `/codex-bridge:verdicts --pending` and resolve approved-but-unmerged or needs-attention work.

## Parallel jobs

Don't stack N Monitor calls — Monitor is one-job. For N > 1:

```bash
# Launch N background tasks
for brief in briefs/*.json; do
  node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task --background --write --json --brief @"$brief" \
    | jq -r '.result.jobId' >> .tasks.txt
done

# Block until the launched cohort reaches terminal state
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" wait --all --jobs "$(cat .tasks.txt)" --timeout-ms 1800000 --json

# Or wake on the next question/plan/terminal event
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" wait --any --jobs "$(cat .tasks.txt)" --predicate both --json
```

Use `status --watch --interval 10s` when you want the human live table instead of a blocking primitive. For scripts, `status --json` exposes event-derived `summary.completed_fail`, `summary.completed_incomplete`, and `needs_attention`; do not treat `summary.running === 0` as success by itself. Each background task gets its own worktree, so they don't fight each other for the working tree. Review and verdict each individually.
