# Error Recovery

Codex-bridge maps every failure to a semantic exit code and a structured error envelope so an agent can branch on `$?` before parsing stdout.

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
Our client-side timeout fired (no app-server timeout exists).
- **Do:** Check if Codex is actually stuck. Cancel if needed, retry with simpler prompt.

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
  ├── ClientTimeout → check if stuck, cancel + retry
  ├── ProcessDeath → verify installation, restart
  └── Other → read result log, assess
```

## Timeout Values

| Phase | Timeout |
|-------|---------|
| Plan turn | 5 minutes (`turnTimeoutMs = 300_000` when `mode: plan`) |
| Execution turn | 10 minutes (`turnTimeoutMs = 600_000` when `mode: default`) |
| Question unanswered | 5 minutes — auto-answers with `{answers: {}}` (`DEFAULT_QUESTION_TIMEOUT_MS` in `src/lib/pending-requests.mjs`) |
| Auto-pipeline per-stage (review / fix / check) | 5 minutes each (`STAGE_TIMEOUT_MS = 300_000` in `src/lib/auto-pipeline.mjs`) |
| Auto-pipeline total | 15 minutes (`PIPELINE_TIMEOUT_MS = 900_000`) |
| No-event idle | 2 minutes (`idleTimeoutMs = 120_000`, per-turn) |

A timeout fires a `ClientTimeout` error to the events file as `[ERROR] {threadId} failed | ClientTimeout`. The rendered message uses seconds/minutes (`Xs` under 60 s, `Xm` for whole minutes, `XmYYs` for mixed — e.g. `auto-review exceeded 5m`, `auto-fix exceeded 7m30s`). The underlying `TimeoutError` instance preserves the raw `timeoutMs` integer as a field — machine consumers should read `.timeoutMs` rather than parse the string. Every `[ERROR]` block also carries an `origin:` line (`turn` or `pipeline:<stage>`); pipeline-origin timeouts may coexist with a success envelope whose `phase: "incomplete"`.
