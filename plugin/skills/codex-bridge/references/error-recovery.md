# Error recovery — decision tree

Every error envelope ships `error.class`, `error.code`, `error.retryable`, and `error.suggestion`. Read `error.suggestion` first — it's the runtime's best-effort fix. Use this tree when the suggestion isn't enough.

## Decision tree by `error.code`

```
error.code
│
├─ Unauthorized                  → `codex login` (error.class=auth)
├─ CODEX_UNAVAILABLE              → `npm i -g @openai/codex` then re-run setup
├─ ContextWindowExceeded          → split the task; rerun with a tighter brief
├─ SandboxError                   → see "Sandbox path" below
├─ ClientTimeout                  → branch on origin (next section)
├─ RESPONSE_CHAIN_LOST            → new task, NOT send; reseed from committed state
├─ RATE_LIMIT                     → wait the suggested window; retryable=true
│
├─ BRIEF_FILE_NOT_FOUND           → check the @path you passed
├─ BRIEF_INVALID_JSON             → JSON parse failed; check brief.json
├─ BRIEF_SCHEMA_VIOLATION         → error.details has the AJV array
├─ BRIEF_PARENT_NOT_FOUND         → parent_task_id refers to a missing job
├─ BRIEF_BACKEND_UNAVAILABLE      → backend_hint not registered on this install
│
├─ BACKEND_INCAPABLE              → adapter doesn't support the requested verb
├─ TASK_DIR_LOCKED                → another worker holds <task_id>/lock
├─ VERDICT_NOT_APPROVED           → run review; resolve verdict before merge
│
├─ WORKTREE_CREATE_FAILED         → check disk space, base ref, branch name
├─ WORKTREE_READ_ONLY_CONFLICT    → --worktree-auto + --read-only is incoherent
├─ WRITE_READ_ONLY_CONFLICT       → choose --write or --read-only
└─ REVIEW_*                       → see "Review path" below
```

## ClientTimeout — branch on `origin:`

The `[ERROR]` block on the events file carries an `origin:` line. Same field shows in `error.origin`:

| `origin:` | First action |
|---|---|
| `idle` | Increase `--idle-timeout-ms`; relaunch. |
| `turn` | Increase `--turn-default-ms` / `--turn-plan-ms`. |
| `pipeline:<stage>` | Read `failing_stage:`; rerun review only with `review --task <id>`. |
| `upstream:transport` | Bridge auto-retries 3×; on exhaust, send the same prompt fresh. |
| `upstream:compact-proxy` | Tighten the brief; required-reads is too wide. |
| `upstream:response-chain-lost` | New task. The resp_id is dead. Pair with `[HANDOFF]` block in events. |
| `upstream:auth` | Reauth at the right layer (Codex or proxy). Don't retry. |
| `upstream:invalid-request` | Bridge auto-retries; on exhaust, rebuild the prompt. |
| `bridge:stall` / `bridge:unhandled-exit` | Bridge bug — file with task_id + events file. |

## Sandbox path

`SandboxError` means Codex tried a write its sandbox forbade. Two recovery paths:

1. **You wanted that write** → loosen `sandbox_policy` in `~/.codex-bridge/config.yaml` (or per-call `--write` to flip the mode-derived default). Default is `danger-full-access`; `workspace-write` restricts to cwd; `read-only` forbids writes.
2. **You didn't want it** → the brief is wrong. Re-brief explicitly forbidding the path Codex tried, and rerun.

## Review path

| code | meaning |
|---|---|
| `REVIEW_EMPTY_DIFF` | working-tree review requested but no changes; either make changes or use `--scope branch` |
| `REVIEW_FOCUS_UNSUPPORTED` | native `review` rejects focus text; use `adversarial-review` |
| `REVIEW_BRIEF_UNSUPPORTED` | native `review` rejects `--brief`; use `adversarial-review` |
| `REVIEW_CONCERN_UNSUPPORTED` | native `review` rejects `--concern`; use `adversarial-review` |
| `REVIEW_TARGET_UNSUPPORTED` | native review only handles working-tree + branch targets |

## When `[HANDOFF]` precedes `[ERROR]`

Upstream-origin errors that exhaust their retry budget emit `[HANDOFF]` **before** the terminal `[ERROR]`. The handoff carries artifact paths, committed shas, retry history, and upstream request id. Same payload is on the envelope at `error.handoff`. Use it to reseed a fresh task (or a fresh agent) without rebuilding state from `git log`.

`[PARTIAL] commits=[…]` may precede `[HANDOFF]` when commits landed before the failure. Cheap way to answer "did anything actually happen before this died": check `error.partial.commits`.

## When the bridge itself appears stuck

If Monitor goes silent and `status <task_id>` still reports `running` past the relevant timeout plus ~60 s buffer, the worker is genuinely stuck. `cancel <task_id>` recovers, releases the registry lock, and leaves the worktree intact for inspection.

If `status` returns `running` but the pid is dead: `status --prune-orphans --json` is idempotent and reaps the ghost.

## Where to look beyond this file

- `error.suggestion` — runtime's best-effort fix, always read first.
- `error.code` + `error.class` — pair this with the table above.
- `node …/codex-bridge.mjs <sub> --help` — per-subcommand recovery hints.
- `~/.codex-bridge/crashes/<ts>.json` — full unhandled-exception dumps (argv, cwd, nodeVersion, stack).
