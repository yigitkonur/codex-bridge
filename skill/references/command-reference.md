# Command Reference

## Global

- `-j, --json` — machine-readable output on stdout. On failure, a JSON error envelope is still written to stdout (success payload shape is per-command for now; error shape is uniform).
- `-C, --cwd <dir>` — override the working directory (git ops + Codex spawn use this).
- `-h, --help` — per-subcommand help; short-circuits before any Codex turn.

Progress lines (`[codex] …`) always go to **stderr**; stdout is reserved for the final rendered markdown or JSON envelope.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | crash / unhandled internal error |
| 2 | usage error (unknown subcommand, unknown flag, missing argument) |
| 3 | not found (job, thread, resource) |
| 4 | auth failure (run `codex login`) |
| 5 | conflict (already running, state mismatch) |
| 6 | validation error (bad input) |
| 7 | transient error (timeout, network, rate-limit) — retry with backoff |
| 8 | partial success (check result details) |

### Success envelope (every `--json` success)

```json
{
  "ok": true,
  "schema_version": "1.0",
  "command": "status",
  "result": { "...": "per-command shape" },
  "meta": { "duration_ms": 313 }
}
```

### Error envelope (every failure under `--json`)

```json
{
  "ok": false,
  "schema_version": "1.0",
  "error": {
    "class": "not_found",
    "code": "JOB_NOT_FOUND",
    "message": "No job found for \"bogus\".",
    "retryable": false,
    "suggestion": "Run `status` to list known jobs."
  },
  "command": "status"
}
```

`error.class` maps 1:1 to exit code (see table above). `error.code` is a stable SCREAMING_SNAKE_CASE token you can switch on. `ok` is a single universal branch key across every subcommand.

### Codex turn failures

When a task or review Codex turn fails, the exit code is mapped from Codex's own error taxonomy:

| `codexErrorInfo` | exit code | class |
|---|---|---|
| `Unauthorized` | 4 | auth |
| `ContextWindowExceeded` | 6 | validation |
| `UsageLimitExceeded` | 7 | rate_limit |
| `HttpConnectionFailed`, `ResponseStreamConnectionFailed`, `ResponseStreamDisconnected` | 7 | network |
| `ClientTimeout` (synthesized on transport silence) | 7 | timeout |
| `ProcessDeath` (Codex process exited) | 7 | dependency_failed |
| `InternalServerError` | 7 | dependency_failed |
| `BadRequest` | 6 | validation |
| `SandboxError` | 5 | conflict |

### `task --json` `phase` + `next_action`

Synchronous `task --json` returns a `result.phase` and `result.next_action` alongside the usual fields so a single call is self-sufficient — no need to tail `.events`.

| `phase` | Meaning | `next_action.command` |
|---|---|---|
| `plan-pending` | Plan detected; awaiting approval | `codex-bridge send <tid> --mode default "Implement the plan."` |
| `done` | Task completed (pipeline ran clean or was skipped) | `codex-bridge result <job-id>` |
| `incomplete` | Pipeline's completion check flagged gaps | `codex-bridge send <tid> "Complete the missing items"` |
| `error` | Turn failed; check `.error.code` | `codex-bridge send <tid> "<revised prompt>"` |

## task

Start a new Codex task. Default: plan mode, read-only sandbox, foreground.

```
codex-bridge task [--write] [--effort <level>] [-m <model>] [--prompt-file <path>]
                  [--resume | --resume-last] [--fresh] [--background] [--json] [prompt or file.md]
```

| Flag | Description |
|------|-------------|
| `--write` | Enable file writing (workspace-write sandbox) |
| `--effort <level>` | Reasoning effort: none, minimal, low, medium, high, xhigh |
| `-m, --model <name>` | Upstream model; `spark` resolves to `gpt-5.3-codex-spark` |
| `--prompt-file <path>` | Read prompt from file instead of argv/stdin |
| `--resume`, `--resume-last` | Continue the latest tracked thread for this session |
| `--fresh` | Start a new thread even if a resumable one exists |
| `--background` | Detached worker; returns immediately with a job id |

Plan mode always forces `effort: xhigh`. Empty prompts fail fast with exit 6 — no billed Codex turn.

## send

Resume a thread with a new prompt. Used for plan approval, revisions, and follow-ups.

```
codex-bridge send <thread-id> [--mode <plan|default>] [--effort <level>] [--prompt-file <path>] [--json] [prompt or file.md]
```

| Flag | Description |
|------|-------------|
| `--mode <plan\|default>` | Switch collaboration mode. Omit to keep current mode. |
| `--effort <level>` | Override reasoning effort for this turn |

Plan approval: `send <thread-id> --mode default "Implement the plan."`
Plan revision: `send <thread-id> "Revise step 2: ..."`

## steer

Send mid-turn guidance to an active Codex turn.

```
codex-bridge steer <thread-id> <turn-id> [--prompt-file <path>] [prompt or file.md]
```

Cannot steer review or compaction turns (app-server rejects with -32600).

## respond

Answer a question from Codex (triggered by [QUESTION] notification).

```
codex-bridge respond <request-id> --question-id <qid> --answer <answer>
codex-bridge respond <request-id> --json-payload '{"answers":{"q1":{"answers":["jwt"]}}}'
```

| Flag | Description |
|------|-------------|
| `--question-id <qid>` | Question ID from the notification (defaults to first) |
| `--answer <answer>` | Answer text (option label or custom text if isOther) |
| `--json-payload <json>` | Raw JSON response (escape hatch) |

## review

Run a standalone code review using Codex's built-in reviewer.

```
codex-bridge review [--scope <auto|working-tree|branch>] [--base <ref>] [-m <model>] [--json]
```

| Flag | Description |
|------|-------------|
| `--scope auto` | Auto-detect: dirty tree → working-tree, clean → branch (default) |
| `--scope working-tree` | Review uncommitted changes |
| `--scope branch` | Review branch vs base |
| `--base <ref>` | Base branch for comparison (auto-detects main/master/trunk) |

Focus text is not accepted by `review`. Use `adversarial-review` for custom focus.

## adversarial-review

Run an adversarial review with structured JSON output.

```
codex-bridge adversarial-review [--scope <s>] [--base <ref>] [-m <model>] [--json] [focus text...]
```

Focus text directs the reviewer's attention (e.g., "focus on SQL injection risks").

## summary

Generate a readable markdown transcript from NDJSON session log.

```
codex-bridge summary <thread-id> [--tail <n>] [--json]
```

| Flag | Description |
|------|-------------|
| `--tail <n>` | Number of NDJSON lines to process (default: 200) |

## status

Check job status.

```
codex-bridge status [job-id] [--all] [--wait] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]
```

| Flag | Description |
|------|-------------|
| `--all` | Show jobs from all Claude sessions |
| `--wait` | Poll until the single-job reaches a terminal state |
| `--timeout-ms <ms>` | Max wait time with `--wait` (default 240000) |
| `--poll-interval-ms <ms>` | Poll cadence with `--wait` (default 2000) |

## result

Get the full result of a completed job.

```
codex-bridge result [job-id] [--json]
```

## cancel

Cancel a running job. Attempts `turn/interrupt` before terminating the worker tree.

```
codex-bridge cancel [job-id] [--json]
```

## setup

Health check: Codex installed, authenticated, app-server available.

```
codex-bridge setup [--json] [--enable-review-gate | --disable-review-gate]
```

## version

Bridge + Codex + Node version, schema version, and capability list. Use to pin agent behavior to a known build.

```
codex-bridge version [--json]
```

## auth-status

Thin auth report (no full dependency check). `setup` is the heavyweight equivalent.

```
codex-bridge auth-status [--json]
```

## help

Machine-readable command catalog + exit-code table + global-flag list.

```
codex-bridge help --json
```

## task-resume-candidate

Report the latest resumable task for this Claude session. Useful before issuing `task --resume`.

```
codex-bridge task-resume-candidate [--json]
```
