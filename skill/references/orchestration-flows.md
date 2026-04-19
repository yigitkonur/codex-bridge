# Orchestration Flows

## Post-[DONE] checklist (post-1.2.5)

When a run terminates with `[DONE]` / `result.phase: "done"`, the pipeline has finished touching the repo. Before you take your next step:

1. **Confirm the pipeline really stopped.** Filter the events file for `[PIPELINE:…:done]` (or the terminal `[PIPELINE:done]`/`[PIPELINE:failed]` pair emitted in 1.2.5). If the `:done` tags are present, no further bridge-side writes are coming. Pre-1.2.5 only a start-tag was emitted and orchestrators had to guess.
2. **Read the pipeline's touchedFiles list.** `result.pipeline.touchedFiles` (and the `[PIPELINE:fix:done] files=[…]` event) names exactly what the auto-fix stage wrote. If that list is empty, no pipeline writes happened and the entire diff is Codex's own work from the execute turn. If it's non-empty, inspect each file before accepting — *do not* blind-accept pipeline-applied changes.
3. **Do not edit files Codex just wrote in this turn.** If you ask Codex to scaffold an Xcode/SPM project and then immediately modify one of its outputs, you'll fight Codex's internal model of the repo on the next `send`. Commit first, then edit if needed, in a separate conversation.
4. **Prefer compile-level verification over regeneration.** If you just wrote files whose contents depend on a generator (xcodegen / prisma / protoc / `cargo generate` …), do **not** re-run the generator as your verification step. The second run's output is non-deterministic for anything order-dependent (e.g. XcodeGen's `project.pbxproj` file-ordering) and will invalidate your diff. Use the compiler (`xcodebuild`, `cargo build`, `tsc`) against the committed tree instead, or `git stash` any uncommitted changes, regenerate, and diff.
5. **Verify on the committed tree, not the working copy.** Before asserting "it builds," commit your intended changes and re-run the build from a clean working tree. Round-3's 15-minute reconciliation happened because a late pipeline turn had rewritten a file between the initial green build and the commit — the clean-tree build caught it.

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

Foreground-only. `task --background --mode default` stores the override in the job record but the detached worker still uses `config.mode` — prefer the foreground path when you need the override to take effect, or set `config.mode: "default"` in `config.yaml` before launching background tasks.

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
           --filter DONE,ERROR,INCOMPLETE,PLAN,QUESTION \
           --timeout-ms 600000          → line-stream of tagged events
  → self-terminates on terminal tag
  → result <jobId> --json               → full rendered result + stored job record
```

The `result.monitor.tool_hint` object in the launch payload has the exact shape the `Monitor` tool expects — paste it directly.

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

This happens when Codex's brainstorming skill routes the question through text instead of the `requestUserInput` tool. The `respond` command won't work here — use `send` instead.
