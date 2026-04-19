# Error Recovery

Codex-bridge maps every failure to a semantic exit code and a structured error envelope so an agent can branch on `$?` before parsing stdout.

## Environment gotchas

- **Claude Code + Xcode `build.db` I/O errors.** When running `xcodebuild` from inside a Claude Code session on macOS, the sandbox around DerivedData intermittently returns `disk I/O error` on the build database. The workaround is to put DerivedData **outside** the workspace: `xcodebuild -derivedDataPath /tmp/<project>-dd …`. Never use the default workspace-side `DerivedData/` from inside Claude Code. Not a codex-bridge issue; hits every macOS user of the skill eventually.
- **XcodeGen / protoc / prisma / other generator outputs are not deterministic across re-runs.** If your verification step re-runs the generator and then compares diffs, you'll see phantom "pipeline rewrote my files" warnings that are actually just generator ordering noise. See orchestration-flows.md → "Post-[DONE] checklist" item 4.

## Exit Code → Action

| `$?` | Class | Retry? | Agent action |
|---|---|---|---|
| 2 | `usage` | No | Fix the command (unknown flag, missing positional, unknown subcommand). |
| 3 | `not_found` | No | The job/thread/resource doesn't exist. Re-check the id. |
| 4 | `auth` | No | Run `codex login`, then retry. |
| 5 | `conflict` | No | State mismatch (already running, mutually exclusive flags). Inspect `status`. |
| 6 | `validation` | No | Bad input (unsupported effort, empty prompt, context too large). Fix input. |
| 7 | `rate_limit` / `timeout` / `network` / `dependency_failed` | **Depends** | `rate_limit` / `timeout` / `network`: retry with backoff. `dependency_failed`: inspect `error.code` and `error.retryable` — some variants (e.g. `CODEX_UNAVAILABLE`, `GIT_NOT_INSTALLED`) are not retryable. |
| 1 | `internal` | Maybe | Crash / uncategorized. Escalate. |

### CLI-boundary codes introduced in the current build

- `INVALID_THREAD_ID` — validation, exit 6. `send`/`steer` rejected a non-UUID thread id. Suggestion points at the canonical UUID v7 shape (`019d9a86-1c8a-7f41-8032-6c76bbe730a1`); no `thr_` prefix.
- `WAIT_TIMEOUT` — timeout, exit 7. `wait` exceeded `--timeout-ms` with no terminal tag. `retryable: true` — agents may re-dispatch after checking `status <id>`.
- `REVIEW_EMPTY_DIFF` — validation, exit 6. `review --scope working-tree` (or `--scope auto` resolving there) against a clean tree and index. No billed Codex turn is spent; make a change and retry.
- `UNKNOWN_SUBCOMMAND` — usage, exit 2. Typo at the subcommand slot. The envelope is emitted even without `--json`; agents should fall back to `help --json` to enumerate valid subcommands.

## Codex `codexErrorInfo` → Exit Code

Task or review Codex turns may fail with a typed error from Codex itself. The bridge translates:

| `codexErrorInfo` | Class | `$?` |
|---|---|---|
| `Unauthorized` | auth | 4 |
| `ContextWindowExceeded` | validation | 6 |
| `BadRequest` | validation | 6 |
| `SandboxError` | conflict | 5 |
| `UsageLimitExceeded` | rate_limit | 7 |
| `HttpConnectionFailed` | network | 7 |
| `ResponseStreamConnectionFailed`, `ResponseStreamDisconnected` | network | 7 |
| `ClientTimeout` (transport went silent) | timeout | 7 |
| `ProcessDeath` (Codex app-server exited) | dependency_failed | 7 |
| `InternalServerError` | dependency_failed | 7 |
| `ResponseTooManyFailedAttempts` | internal | 1 |
| `ActiveTurnNotSteerable`, `Other` (fall-through) | internal | 1 |

## Error Types and What to Do

### ContextWindowExceeded
The conversation exceeded the model's context limit.
- **Do:** Start a new task with a shorter prompt, or fork the thread.
- **Do not:** Retry with the same prompt.

### UsageLimitExceeded
OpenAI rate limit or quota hit.
- **Do:** Wait and retry. Check `account rate-limits` for reset timing.

### HttpConnectionFailed / ResponseStreamDisconnected
Network issue between Codex and OpenAI.
- **Do:** Retry once. If persistent, check network connectivity.

### ResponseTooManyFailedAttempts
App-server exhausted its own retries — classified as `internal` / exit 1 because retrying would hit the same wall.
- **Do:** Read the result log for details. Do not retry the same prompt; try a different approach or a fresh thread.

### Unauthorized
Authentication failed.
- **Do:** Run `setup` command. Re-authenticate with `codex login`.

### ClientTimeout

A client-side timeout fired. There are **five independent origins** — each has a different first-response action. Read the `[ERROR]` event's `origin:` line in `.events` (or `result.pipeline.error` on the sync `task --json` envelope) to pick the right one.

| Origin (from `[ERROR]` line) | What timed out | First-response action |
|---|---|---|
| `origin: turn` + message mentions "No events received for…" | No-event idle watchdog (`idle_timeout_ms` / `--idle-timeout-ms`, default 300 s) | Re-run with `--idle-timeout-ms 600000` if the task is reasoning-heavy; otherwise suspect real stall → `cancel <id>` |
| `origin: turn` + message mentions "turn exceeded" | Per-turn ceiling (`turn_plan_ms` / `turn_default_ms`, `--turn-plan-ms` / `--turn-default-ms`) | Re-run with a larger `--turn-default-ms` (e.g. `1800000` for large scaffolds) |
| `origin: pipeline:review` / `pipeline:fix` / `pipeline:check` | Per-stage pipeline timeout (`pipeline_stage_ms`, `--pipeline-stage-timeout-ms`, default 5 min) | Re-run with larger `--pipeline-stage-timeout-ms`, or pass `--no-pipeline` if you want to own completion checking |
| `origin: pipeline:*` + message "Auto-pipeline exceeded …" | Total pipeline budget (`pipeline_total_ms`, `--pipeline-total-timeout-ms`, default 15 min) | Re-run with larger `--pipeline-total-timeout-ms`, or `--no-pipeline` |
| `QUESTION_TIMEOUT` ndjson entry (`question_answer_ms`, `--question-timeout-ms`, default 5 min) | Human/orchestrator didn't answer `requestUserInput` in time; bridge sent `{}` | If the answer was slow rather than missing, re-run with `--question-timeout-ms 1800000` |

All five surface as `ClientTimeout` in the events tag; `origin:` is the only way to disambiguate before retrying.

### ProcessDeath
Codex app-server process exited unexpectedly.
- **Do:** Check if Codex is installed. Run `setup` to verify.

## Decision Tree

```
[ERROR] received
  │
  ├── ContextWindowExceeded → new task, shorter prompt
  ├── Unauthorized → setup, re-auth
  ├── UsageLimitExceeded → wait, retry
  ├── ClientTimeout → branch by origin: line
  │     ├── origin: turn (idle)        → raise --idle-timeout-ms
  │     ├── origin: turn (turn-budget) → raise --turn-default-ms
  │     ├── origin: pipeline:<stage>   → raise --pipeline-stage-timeout-ms (or --no-pipeline)
  │     └── QUESTION_TIMEOUT (ndjson)  → raise --question-timeout-ms
  ├── ProcessDeath → verify installation, restart
  └── Other → read result log, assess
```

## Timeout Values

Every budget is configurable. Resolution order for each: CLI flag → `config.yaml` key → built-in default. Malformed values throw usage (exit 2) rather than silent fallback.

| Phase | Default | Config key | CLI flag |
|-------|---------|------------|----------|
| Plan turn | 5 min (300 000 ms) | `turn_plan_ms` | `--turn-plan-ms` |
| Execution turn | 10 min (600 000 ms) | `turn_default_ms` | `--turn-default-ms` |
| Question unanswered (auto-answers with `{answers: {}}`) | 5 min | `question_answer_ms` | `--question-timeout-ms` |
| Auto-pipeline per-stage (review / fix / check) | 5 min | `pipeline_stage_ms` | `--pipeline-stage-timeout-ms` |
| Auto-pipeline total | 15 min | `pipeline_total_ms` | `--pipeline-total-timeout-ms` |
| No-event idle (per-turn) | 5 min (300 000 ms) | `idle_timeout_ms` | `--idle-timeout-ms` |

A timeout fires a `ClientTimeout` error to the events file as `[ERROR] {threadId} failed | ClientTimeout`. The rendered message uses seconds/minutes (`Xs` under 60 s, `Xm` for whole minutes, `XmYYs` for mixed — e.g. `auto-review exceeded 5m`, `auto-fix exceeded 7m30s`). The underlying `TimeoutError` instance preserves the raw `timeoutMs` integer as a field — machine consumers should read `.timeoutMs` rather than parse the string. Every `[ERROR]` block also carries an `origin:` line (`turn` or `pipeline:<stage>`); pipeline-origin timeouts may coexist with a success envelope whose `phase: "incomplete"`.
