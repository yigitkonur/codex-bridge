# Orchestration Flows

## Sync Task — one call, self-sufficient

Use when the task is short, self-contained, and you don't need interim progress updates. The envelope's `result.phase` + `result.next_action` tells you what to do next.

```
task --json "prompt"
  → blocks until turn completes (or plan is produced)
  → envelope returns with result.phase ∈ { plan-pending | done | incomplete | error }
  → branch on result.next_action.command
```

Typical branches:
| `phase` | `next_action.command` (example) |
|---|---|
| `plan-pending` | `codex-bridge send <tid> --mode default "Implement the plan."` |
| `done` | `codex-bridge result <job-id>` |
| `incomplete` | `codex-bridge send <tid> "Complete the missing items"` |
| `error` | `codex-bridge send <tid> "<revised prompt>"` (check `$?` first) |

Sync is **not** the right choice when Codex may ask a question via `requestUserInput` — the worker blocks waiting for a separate `respond` process, which only exists in the async flow. Use Monitor for anything interactive.

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

This is not a failure — it means Codex decided the task was clear enough to execute directly. The diff and session files are still valid.

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
