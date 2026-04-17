# 15 / 01 — Post-hardening regression sweep

Smoke-ran the 14 script-hardening commits (`0065fcd…f31f078`) against the live bundled CLI. One commit per plan task; this file documents what exercising each surface looked like as an agent.

## Working outcomes

| # | Surface | Command | Result |
|---|---|---|---|
| 1 | INVALID_THREAD_ID (Task 1) | `send thr_abc 'x' --json` | `validation` / `INVALID_THREAD_ID`, exit 6 ✓ |
| 2 | USAGE_ERROR for bad mode (Tasks 2+12) | `send <uuid> --mode execute 'x' --json` | `usage` / `USAGE_ERROR`, exit 2 ✓ |
| 3 | Task-resume filter (Task 3) | `task-resume-candidate --json` | `available: true`, `candidate.status === "completed"` ✓ |
| 4 | Unknown-subcommand envelope (Task 4) | `bogus --json` | `usage` / `UNKNOWN_SUBCOMMAND`, exit 2 ✓ |
| 5 | Seconds-formatted timeout messages (Task 5) | `TimeoutError('auto-review', 300000)` | `message === "auto-review exceeded 5m"`, `.timeoutMs === 300000` ✓ |
| 6 | Fully-qualified next_action (Task 6) | grep bundle | `` `node ${SCRIPT_PATH} send <tid> …` `` in all 5 setPhase branches ✓ |
| 7 | `wait` subcommand (Task 7) | `wait task-mo2n0i8z-cbefzo --timeout-ms 5000 --json` | `terminalTag: "ERROR"`, `elapsedMs: 45`, exit 0 ✓ |
| 8 | `events` subcommand + filter (Task 8) | `events <job> --filter DONE,ERROR,INCOMPLETE` | Emits only terminal-tag lines ✓ |
| 9 | Monitor hint in launch payload (Task 9) | `task --background --write 'noop' --json` | `.result.monitor.command` = `node <abs path> events <jobId> --follow --filter …`, `terminal_tags` `["DONE","ERROR","INCOMPLETE"]` ✓ |
| 10 | `result`/`status` by thread-id (Task 10) | `result <uuid> --json` | Resolves via `job.threadId` ✓ |
| 11 | `review` short-circuit on clean tree (Task 11) | `review --scope working-tree --json` (clean tree) | `validation` / `REVIEW_EMPTY_DIFF`, exit 6, no billed turn ✓ |
| 12 | `task --mode` passthrough (Task 12) | `task --mode banana --write 'x' --json` | `usage` / `USAGE_ERROR`, exit 2 ✓ |
| 13 | `[ERROR]` origin field (Task 13) | formatter isolated | `origin: turn` / `origin: pipeline:review` emitted ✓ |
| 14 | `ITEM_COMPLETED` NDJSON (Task 14) | bundle grep | 2 live call-sites emit the tag ✓ |

## Minor issues noted during the sweep (not fixed in this plan)

- **`wait` on a thread that has no `.events` file at all** (e.g. a review job whose artifact was never created) does not correctly hit the timeout branch — it resolves with `{terminalTag: null, elapsedMs: null}` and exit 0 instead of throwing `WAIT_TIMEOUT` / exit 7. Reproduces with the CLI's `wait <review-job-id>` when the job never wrote to `.events`. Likely cause: the pollTimer path in `waitForTerminalEvent` has a resolution race when the file never materializes. File a follow-up task.
- **`--mode` on `task --background`** is accepted, persisted into the stored job request, but the detached worker (`handleTaskWorker`) calls `executeTaskRun` directly and does NOT route through `runBridgeTask`, so the override doesn't change the worker's behavior. Noted in Task 12 subagent report. Foreground sync `task` honors `--mode` correctly.
- **Docs referencing `300000ms`** in notification-format / error-recovery / Gherkin — the emission now uses seconds. Doc sweep is its own follow-up task (out of scope per user's "no micro PR" guidance; will ride the next batch).

## Stop-gate reviewer turn `task-mo2u5uo5-wmgt7m`

The earlier stop-hook review surfaced that the Task 1 validator rejected `thr_abc` which was itself the literal used in the repo's own examples. Fixed in commit `0e60daa` — `help --json` / `COMMANDS` table now print real UUIDs. Verified.

## Artifacts on disk

Every commit rebuilds `skill/scripts/codex-bridge.mjs` (gitignored). No hand-edits to build output. Working tree is clean after this sweep; no stray active jobs.
