# Orchestration flow — one canonical loop

The full plan→execute→review→merge loop, written for an Opus-driver. In v2.0.0, the dispatch, review, verdict, and merge commands are wired; the multi-round `iterate` automation is staged, so run the loop manually until it lands.

## The loop

```
Brief ──▶ task --background --worktree-auto --brief ──▶ Monitor (auto-armed)
                                                          │
                                              [PLAN]      │   [QUESTION]
                                                ▼         │     ▼
                                  approve via send       respond
                                                          ▼
                                                       [DONE] / [INCOMPLETE]
                                                          │
                                                          ▼
                         adversarial-review --cwd <worktree.path> --base <base_ref>
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

Either via slash command (preferred — hooks fire on the underlying Bash):

```
/codex-bridge:task --background --write --worktree-auto --brief @brief.json
```

Or directly (the PreToolUse(Bash) hook will reject without `--worktree-auto`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task \
  --background --write --worktree-auto --json --brief @brief.json
```

The PostToolUse(Bash) hook parses the envelope, captures `result.jobId`, and emits an `additionalContext` block with the literal Monitor invocation. **Arm the Monitor on your next turn with that exact payload — do not modify it.**

## Monitor

Monitor self-terminates on `[DONE]`/`[ERROR]`/`[INCOMPLETE]`. While it streams:

- **`[PLAN]`** → read it; either `send <thread-id> --mode default "Implement the plan."` to approve, or `send <thread-id> "Revise: …"` to push back.
- **`[QUESTION]`** → `respond <request-id> --question-id <qid> --answer "<label>"`.
- **`[CHECKPOINT]`** → informational digest every ~5 min. Read for "what is Codex doing"; act only if it's drifting.
- **`[WARNING]`** → circuit-breaker fired. Cancel if the environment can't run that family; steer if Codex needs redirection.

## Review

When Monitor terminates, read `<jobs>/<task_id>/meta.json` and run an adversarial review from the recorded worktree path against its recorded base ref. Use the same brief — its `specific_concerns` flow into the reviewer's `{{OPUS_CONCERNS}}` slot:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" adversarial-review \
  --cwd "<worktree.path>" --base "<worktree.base_ref>" --brief @brief.json
```

`iterate` is present but not yet automated; today it returns a structured next-action stub for the manual loop:

```
/codex-bridge:iterate <task_id> --max 3 --brief @brief.json
```

## Verdict and merge

`adversarial-review` writes review output. Convert it into a verdict:

```
/codex-bridge:verdict <task_id> --set approved --summary "Tests green; concerns dismissed."
/codex-bridge:verdict <task_id> --set needs-attention --finding "Auth gap on the retry path"
/codex-bridge:verdict <task_id> --set must-fix --finding "Drops 4xx errors silently"
/codex-bridge:verdict <task_id> --discard
```

If approved: `/codex-bridge:merge <task_id>` fetches the recorded base ref, checks it out, and fast-forwards it to the task branch. The merge is gated — refuses when verdict ≠ approved. Run acceptance tests yourself before setting `approved`.

Before stopping, run `/codex-bridge:verdicts --pending` and resolve approved-but-unmerged or needs-attention work.

## Parallel jobs

Don't stack N Monitor calls — Monitor is one-job. For N > 1:

```bash
# Launch N background tasks
for brief in briefs/*.json; do
  node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task --background --write --worktree-auto --json --brief @"$brief" \
    | jq -r '.result.jobId' >> .tasks.txt
done

# Watch all of them with one fan-in view
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" status --watch --interval 10s
```

Each background task gets its own worktree, so they don't fight each other for the working tree. Review and verdict each individually.
