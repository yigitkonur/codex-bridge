# Orchestration Flows

## Post-[DONE] checklist (post-1.2.5)

When a run terminates with `[DONE]` / `result.phase: "done"`, the pipeline has finished touching the repo. Before you take your next step:

1. **Confirm the pipeline really stopped.** Filter the events file for `[PIPELINE:…:done]` (or the terminal `[PIPELINE:done]`/`[PIPELINE:failed]` pair emitted in 1.2.5). If the `:done` tags are present, no further bridge-side writes are coming. Pre-1.2.5 only a start-tag was emitted and orchestrators had to guess.
2. **Read the pipeline's touchedFiles list.** `result.pipeline.touchedFiles` (and the `[PIPELINE:fix:done] files=[…]` event) names exactly what the auto-fix stage wrote. If that list is empty, no pipeline writes happened and the entire diff is Codex's own work from the execute turn. If it's non-empty, inspect each file before accepting — *do not* blind-accept pipeline-applied changes.
3. **Do not edit files Codex just wrote in this turn.** If you ask Codex to scaffold an Xcode/SPM project and then immediately modify one of its outputs, you'll fight Codex's internal model of the repo on the next `send`. Commit first, then edit if needed, in a separate conversation.
4. **Prefer compile-level verification over regeneration.** If you just wrote files whose contents depend on a generator (xcodegen / prisma / protoc / `cargo generate` …), do **not** re-run the generator as your verification step. The second run's output is non-deterministic for anything order-dependent (e.g. XcodeGen's `project.pbxproj` file-ordering) and will invalidate your diff. Use the compiler (`xcodebuild`, `cargo build`, `tsc`) against the committed tree instead, or `git stash` any uncommitted changes, regenerate, and diff.
5. **Verify on the committed tree, not the working copy.** Before asserting "it builds," commit your intended changes and re-run the build from a clean working tree. A prior incident burned 15 min on reconciliation because a late pipeline turn had rewritten a file between the initial green build and the commit — only a clean-tree rebuild caught it.

## Sync Task — one call, self-sufficient

Use when the task is short, self-contained, and you don't need interim progress updates. The envelope's `result.phase` + `result.next_action` tells you what to do next.

```
task --json "prompt"
  → blocks until turn completes (or plan is produced)
  → then blocks through the auto-pipeline (review + completion-check) if config enables them
  → envelope returns with result.phase ∈ { plan-pending | done | incomplete }
  → branch on result.next_action.command (substitute `node <scriptPath>` for `codex-bridge`)
```

With the default `auto_review: true`, sync wall-time is turn-time + up to ~5 minutes of pipeline. A zero-diff prompt may still stall until the reviewer hits its 300 s timeout. Flip `auto_review: false` in `config.yaml` for snappier sync runs, or use async + Monitor.

A failed Codex turn returns the standard error envelope (`ok:false`, `error.class`, exit code per `command-reference.md`); sync does **not** return a success envelope with `phase:"error"`.

Typical branches (success envelope only — failures land as `ok:false` and never reach the `phase` switch):
| `phase` | `next_action.command` (example) |
|---|---|
| `plan-pending` | `codex-bridge send <tid> --mode default "Implement the plan."` |
| `done` | `codex-bridge result <job-id>` |
| `incomplete` | `codex-bridge send <tid> "Complete the missing items"` |
| `workspace-dirty` | `git -C <cwd> add -A && git -C <cwd> commit -m "<subject>"` |

`workspace-dirty` fires when Codex produced file changes (`result.touchedFiles` non-empty) but the turn ended with `codexErrorInfo: "SandboxError"` — typically because `workspace-write` blocks writes to `.git/` and Codex could not commit its own work. The envelope is a **success envelope** (`ok:true`, exit 0) because the diff is actionable: the orchestrator commits on Codex's behalf, or re-runs with `config.sandbox_policy: "danger-full-access"` (see `config-reference.md`). `result.sandboxError` carries the raw sandbox error message for diagnostics.

For failures, read `error.code` and `error.class` from the error envelope, then consult `error-recovery.md`.

Sync is **not** the right choice when Codex may ask a question via `requestUserInput` — the worker blocks waiting for a separate `respond` process, which only exists in the async flow. Use Monitor for anything interactive.

### Skipping the plan turn

Pass `--mode default` on `task` to bypass the plan phase entirely and start executing directly. Combine with `--write` for `workspaceWrite`:

```
task --mode default --write "Trivial typo fix"
  → Execution turn (no plan turn)
  → [PIPELINE:review] → [PIPELINE:check]
  → [DONE] notification
```

Available on both foreground and background paths — the override flows through `buildTaskRequest` → the stored job record → the detached worker's `runBridgeTask` call, where `effectiveMode = request.mode ?? config.mode ?? "plan"`. Post-1.2.1 the background path honors `--mode` like the foreground path; earlier releases dropped it silently.

## Simple Task (no questions)

```
task --write "prompt"
  → Plan mode turn
  → [PLAN] notification
  → send --mode default "Implement the plan."
  → Execution turn
  → [PIPELINE:review] (silent)
  → [PIPELINE:check] (silent)
  → [DONE] notification
```

## Task with Questions

```
task --write "prompt"
  → Plan mode turn
  → [QUESTION] notification (Codex needs info)
  → respond <req-id> --answer "jwt"
  → [CONFIRMED] notification
  → Codex continues planning
  → [PLAN] notification
  → send --mode default "Implement the plan."
  → Execution turn
  → [DONE] notification
```

## Task with Review Findings

```
task --write "prompt"
  → Plan → approve → Execute
  → [PIPELINE:review] — auto-review summarises findings (text)
  → [PIPELINE:check]  — completion check gates the result
  → [DONE] notification (diff includes original changes)
```

The current native auto-review returns plain text, not a structured findings list, so there is no automatic `[PIPELINE:fix]` stage — use `adversarial-review` for structured findings you can feed back via `send`.

## Task with Incomplete Result

```
task --write "prompt"
  → Plan → approve → Execute
  → [PIPELINE:review] → [PIPELINE:check]
  → Completion check: "Integration tests missing"
  → [INCOMPLETE] notification with missing items
  → You decide: send follow-up OR start new task
```

If the pipeline timed out rather than the completion check coming back negative, expect an `[ERROR]` with `origin: pipeline:<stage>` *and* a success envelope carrying `phase: "incomplete"` + `result.pipeline.error`. The task turn itself may have succeeded — read the envelope before retrying.

## Following events with the built-in stream

Use when you want to tail progress without hand-rolling `tail -f`. Steers tooling toward the CLI-native path.

```
task --background --write "prompt"      → jobId + result.monitor hint
  → events <jobId> --follow \
           --exclude HEARTBEAT \
           --timeout-ms 1800000         → line-stream of non-noise tags
  → self-terminates on terminal tag
  → result <jobId> --json               → full rendered result + stored job record
```

The `result.monitor.tool_hint` object in the launch payload has the exact shape the `Monitor` tool expects and already bakes in `--exclude HEARTBEAT` — paste it directly, don't re-template.

### Handling unknown tags (forward-compat)

The v1.4.0 default (`--exclude HEARTBEAT`) means any tag a future bridge version emits reaches the orchestrator verbatim — including tags your code doesn't know about. The canonical extractor for the head tag is the regex `/^\[([^\]]+)\]/` (match anything between leading brackets). Split on `:` for the subtype (`[PIPELINE:review]` → head `PIPELINE`, subtype `review`). Don't assume the tag vocabulary is closed; if you see a tag you don't recognize, surface the line verbatim to the user/log and keep watching — the bridge only self-terminates on `[DONE]`, `[ERROR]`, or `[INCOMPLETE]`.

## Waiting without streaming

When the agent only needs the terminal signal and doesn't care about intermediate tags:

```
task --background --write "prompt"      → jobId
  → wait <jobId> --timeout-ms 600000 --json   → {terminalTag, elapsedMs, …}
  → result <jobId> --json                     → optional: full result envelope
```

Exit 7 `WAIT_TIMEOUT` on deadline. Cheapest blocking primitive.

## Standalone Review

```
review --scope working-tree
  → [REVIEW] notification with verdict + findings
  → You decide: fix issues or accept
```

## Follow-Up on Completed Task

```
send <thread-id> "Also add error handling for the edge case"
  → Execution turn (same thread context)
  → [DONE] notification
```

## Plan Revision

```
task → [PLAN]
  → send <thread-id> "Revise step 2: use Redis instead"
  → Plan mode continues
  → [PLAN] (revised plan)
  → send --mode default "Implement the plan."
  → Execution
  → [DONE]
```

## Codex Skips Planning (common fallback)

Codex has its own internal skills that may override plan mode. When this happens:

```
task --write "prompt"
  → Codex ignores plan mode, goes straight to execution
  → [DONE] notification (with file changes)
  → Review the diff, send follow-ups if needed
```

This is not a failure — it means Codex decided the task was clear enough to execute directly. The diff and session files are still valid. Passing `--mode default` on the foreground path bypasses the plan/no-plan ambiguity entirely by short-circuiting the plan turn.

## Codex Asks Questions via Text (not requestUserInput)

```
task --write "prompt"
  → Codex asks question as plain text in assistant message
  → Turn completes with [DONE] and 0 file changes
  → Read the stdout from task launch — it contains the question
  → send <thread-id> "your answer here"
  → Codex continues with execution
  → [DONE] with file changes
```

This happens when Codex's question-asking skill (whichever upstream chain is currently responsible for clarifying-question handling) routes the question through assistant text instead of the `requestUserInput` tool. The `respond` command won't work here — use `send` instead.

## Running N jobs in parallel (fan-out / fan-in)

Monitor is a **single-job** tool — it tails one `.events` file and self-terminates on the first terminal tag. When you need to run several independent tasks and collect their outcomes, use async primitives instead:

- `task --background --json` launches a detached worker and returns the job record immediately.
- `status --watch` renders the multi-job table on an interval and exits when every tracked job reaches a terminal state.
- `await-artifact <job-id> <path>` blocks until a specific file materializes and stabilizes, or the job reaches a terminal state, or the timeout fires.

### Fan-out / fan-in recipe

```bash
#!/usr/bin/env bash
# Launch 5 independent tasks that each write a known artifact,
# wait for all of them, then summarize.
set -euo pipefail

bridge() { node "$SCRIPT_PATH" "$@"; }

# 1. Fan out. Capture each job id + thread id.
declare -a JOBS=()
for i in 1 2 3 4 5; do
  out=$(bridge task --background --write --json \
    --prompt-file "missions/mission-${i}.md" \
    --mode default)
  job_id=$(jq -r '.result.jobId' <<<"$out")
  thread=$(jq -r '.result.threadId' <<<"$out")
  JOBS+=("${job_id}:${thread}:missions/out/mission-${i}.md")
done

# 2. Fan in — two options.

# (a) Watch the whole cohort reach terminal state:
bridge status --watch --interval 10s --watch-timeout-ms 1800000

# (b) Or block per-artifact (stricter — fail-fast on any one):
for entry in "${JOBS[@]}"; do
  job_id="${entry%%:*}"
  rest="${entry#*:}"
  artifact="${rest#*:}"
  bridge await-artifact "$job_id" "$artifact" \
    --timeout-ms 1800000 --json \
    | tee -a await.log
done

# 3. Summarize outcomes.
for entry in "${JOBS[@]}"; do
  job_id="${entry%%:*}"
  bridge result "$job_id" --json \
    | jq -c '{job: .result.jobId, phase: .result.phase, touched: (.result.touchedFiles // []) | length}'
done
```

### When to reach for which primitive

| Need | Use |
|---|---|
| One job, interactive, need live progress | Monitor `events --follow` |
| One job, unattended, just want the final result | Sync `task --json` |
| N jobs, all must finish before you move on | `task --background --json` fan-out + `status --watch` |
| N jobs, each has a known output path | `task --background --json` fan-out + `await-artifact` per job |
| N jobs, mixed success criteria | Launch async, poll `status --all --json` on your own cadence |

`status --watch --json` emits one NDJSON snapshot per tick so it's scriptable; without `--json` it re-renders a markdown table in place. Exits 0 when every tracked job is terminal; the summary payload's `reason` is `all-terminal`, `watch-timeout`, or `sigint`. `await-artifact` returns exit 7 on timeout **and** on "job terminated without producing the file"; the payload carries `exists`, `terminated`, and on non-success `reason: "timeout" | "job-<status>"` (e.g. `job-failed`, `job-cancelled`) so the caller can tell the cases apart.


## Recovering from upstream state loss {#recovering-from-upstream-state-loss}

Some upstream failures kill the response chain binding the bridge's thread to Codex's internal state: a 400 `previous_response_not_found` after compaction eviction, a 401 that invalidates the session, a 400 `invalid_request_error` from a proxy flap. When the bridge can't recover in-thread (see `UPSTREAM_RETRY_POLICY` in `error-recovery.md`), it emits a `[HANDOFF]` block and surfaces a handoff envelope on the JSON `error.handoff` field. This section is the consumer recipe for that envelope: the step-by-step move an orchestrator takes when `task --json` returns `ok: false` with `error.handoff` present.

### Full worked recipe

1. **Read the handoff envelope.** Either grep `[HANDOFF]` on `.events`, or parse `error.handoff` from the JSON envelope — both carry the same payload.

   ```bash
   bridge result "$JOB_ID" --json | jq '.error.handoff'
   ```

2. **Branch on `reason`.**
   - `upstream-auth-requires-reauth`: stop. Reauth the right layer (`codex login` for Codex auth; proxy reauth for a gateway 401), then relaunch a brand-new task. Do **not** `send` on the dead thread — the same 401 will repeat.
   - `upstream-retry-exhausted`: the bridge already exhausted its exp-backoff budget. Proceed to step 3.

3. **Audit what committed before the error.**
   Use `handoff.partial.commits` (mirrors `error.partial.commits`) as the authoritative list — the bridge captured a git snapshot at `turn/started` and diffed on failure:

   ```bash
   LAST_OK_SHA=$(bridge result "$JOB_ID" --json | jq -r '.error.handoff.partial.lastOkHeadSha')
   git log --oneline ${LAST_OK_SHA}..HEAD
   ```

   Dirty (uncommitted) files live under `handoff.partial.dirtyFiles`. Decide whether to keep, discard, or fold them into the relaunch.

4. **Rebuild the prompt.** Read the original prompt from `handoff.prompt.original` (or `handoff.prompt.promptFilePath` when the task was launched with `--prompt-file`). Prepend a 'what survived' preamble so Codex doesn't redo already-committed work:

   ```markdown
   The previous turn landed these commits before an upstream error:
     ${commits}  # copy from handoff.partial.commits

   Last good HEAD: ${handoff.partial.lastOkHeadSha}
   Do not redo the work in those commits. Continue from here:

   ${handoff.prompt.original}
   ```

5. **Relaunch as a fresh task** (not `send` — the old thread is dead):

   ```bash
   bridge task --json --mode default --prompt-file /tmp/rebased.md
   ```

6. **Optional: inspect the full failure trail.** `handoff.artifacts.eventsPath` and `handoff.artifacts.workerErrPath` are full paths to the events and worker-stderr for the dead thread — useful when escalating to a proxy owner (quote `handoff.upstream_request_id` as the correlation handle).

### Why the bridge does not auto-rebase and relaunch

The rebase step requires judgement: which commits were actually wanted, which unfinished scope the prompt should continue with, whether any uncommitted changes need curating. An automated rebase would either (a) drop the partial work silently, or (b) re-do work already committed. Neither is safe. The bridge's job ends at `[HANDOFF]`; the consumer (human, agent, or higher-level orchestrator) owns the relaunch.

### Checklist when a handoff arrives

- [ ] Read `error.handoff.reason` first — reauth vs. rebase needs different first moves.
- [ ] Verify `handoff.partial.commits` against `git log` before trusting the list (the bridge's snapshot is best-effort; it can miss commits made outside the turn's cwd).
- [ ] Capture `handoff.upstream_request_id` before discarding the envelope — if you need to escalate later, that's the only correlation handle to the upstream proxy.
- [ ] Keep the original `handoff.prompt.promptFilePath` around: the rebased prompt supersedes it, but the original is the audit trail.

