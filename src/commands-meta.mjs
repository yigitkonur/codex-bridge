// Single source of truth for subcommand synopses, exit codes, and global
// flag documentation. Pure data — no logic, no side effects, safe to import
// from any tier (dispatcher, handlers, tests).
//
// Every COMMANDS entry must match the actual `booleanOptions` /
// `valueOptions` list in its handler; treat this table as the CLI contract
// and update it in the same commit as any flag move.

export const COMMANDS = Object.freeze({
  task: {
    synopsis: "task [--write] [--read-only] [--worktree-auto|--no-worktree-auto] [--base-ref <ref>] [--on-branch <name>] [--brief @<path>.json|<inline-json>] [--mode plan|default] [--effort <level>] [-m <model>] [--prompt-file <path>] [--resume|--resume-last] [--fresh] [--background] [--no-pipeline] [--quiet] [--idle-timeout-ms <ms>] [--turn-plan-ms <ms>] [--turn-default-ms <ms>] [--pipeline-stage-timeout-ms <ms>] [--pipeline-total-timeout-ms <ms>] [--question-timeout-ms <ms>] [--legacy-envelope] [--json] [prompt or file.md]",
    summary: "Start a new Codex task. Defaults: plan mode, configured sandbox, foreground. Use --mode default to skip planning and execute directly. Write-mode tasks use per-task worktree isolation by default; --worktree-auto remains accepted for explicitness, and --no-worktree-auto opts into in-place edits. Prompts for isolated work must use repo-relative paths, not absolute paths inside the launch checkout. Base ref can be set with --base-ref <ref> (branch, ref, SHA, or current); omit it to inherit the current branch. Use --on-branch <name> to fail before dispatch if the launch checkout is not on the expected branch. --brief @path.json appends a structured brief to the worker prompt and persists it under the artifact registry. Background Monitor hints are single-job; for N > 1 parallel jobs, use wait --any --predicate both for the next actionable job, wait --all for the wave barrier, or status --watch for a live table.",
    examples: [
      'codex-bridge task --write "Fix the auth bug in src/auth.ts"',
      'codex-bridge task --mode default --write "Trivial typo fix"',
      "codex-bridge task --prompt-file prompt.md --effort high --write",
      'codex-bridge task --resume-last "Continue the previous thread"',
      'codex-bridge task --background --write "Rewrite tests" --json',
      'codex-bridge task --background --write --base-ref main --brief @brief.json --json "Implement the task described in the structured brief"'
    ]
  },
  send: {
    synopsis: "send <thread-id> [--backend <name>] [--mode plan|default] [--on-branch <name>] [--effort <level>] [--quiet] [--idle-timeout-ms <ms>] [--turn-timeout-ms <ms>] [--question-timeout-ms <ms>] [--json] [prompt or file.md]",
    summary: "Resume a thread with a new prompt. Use for plan approval, revisions, and follow-ups. <thread-id> is a UUID returned by task. Use --on-branch <name> to fail before dispatch if the checkout is not on the expected branch.",
    examples: [
      'codex-bridge send 019d9a86-1c8a-7f41-8032-6c76bbe730a1 --mode default "Implement the plan."',
      'codex-bridge send 019d9a86-1c8a-7f41-8032-6c76bbe730a1 "Revise step 2: use token bucket instead"'
    ]
  },
  steer: {
    synopsis: "steer <thread-id> <turn-id> [--backend <name>] [prompt or file.md]",
    summary: "Send mid-turn guidance to an active Codex turn. Not valid for review/compaction turns. Both ids are UUIDs.",
    examples: ['codex-bridge steer 019d9a86-1c8a-7f41-8032-6c76bbe730a1 019d9a86-2012-7152-bcc9-228a263d286a "Focus on auth first"']
  },
  respond: {
    synopsis: "respond <request-id> [--backend <name>] (--question-id <qid> --answer <answer> | --json-payload <json>) [--json]",
    summary: "Answer a [QUESTION] emitted by Codex (requestUserInput).",
    examples: [
      'codex-bridge respond req-xyz --question-id q1 --answer "jwt"',
      "codex-bridge respond req-xyz --json-payload '{\"answers\":{\"q1\":{\"answers\":[\"jwt\"]}}}'"
    ]
  },
  review: {
    synopsis: "review [--backend <name>] [--task <task_id>] [--scope auto|working-tree|branch] [--base <ref>] [-m <model>] [--json]",
    summary: "Run a standalone code review using Codex's built-in reviewer. With --task, review the task worktree and bind the JSON review_result to the reviewed branch HEAD.",
    examples: [
      "codex-bridge review --scope working-tree",
      "codex-bridge review --scope branch --base main",
      "codex-bridge review --task task-mo5xxx --json"
    ]
  },
  "adversarial-review": {
    synopsis: "adversarial-review [--backend <name>] [--task <task_id>] [--scope auto|working-tree|branch] [--base <ref>] [-m <model>] [--brief @<path>.json] [--concern <text>]... [--json] [focus text...]",
    summary: "Run an adversarial review with a structured JSON result. With --task, review the task worktree and bind the JSON review_result to the reviewed branch HEAD. --brief and --concern populate the {{OPUS_CONCERNS}} channel in the prompt — the orchestrator's privileged focus signal. Brief items precede flag items and are de-duped while preserving order.",
    examples: [
      'codex-bridge adversarial-review "focus on SQL injection risks"',
      "codex-bridge adversarial-review --scope branch --base main",
      "codex-bridge adversarial-review --brief @review-brief.json",
      'codex-bridge adversarial-review --concern "Don\'t swallow non-retryable 4xx" --concern "Make timeout configurable"',
      "codex-bridge adversarial-review --task task-mo5xxx --json"
    ]
  },
  iterate: {
    synopsis: "iterate <task_id_or_prompt> [--max <n>] [--brief <path>] [--backend <name>] [--write] [--json]",
    summary: "Run task -> adversarial review -> verdict -> follow-up until approved or the iteration limit is reached.",
    examples: [
      'codex-bridge iterate "Implement the brief" --max 3 --json',
      "codex-bridge iterate task-abc --max 2"
    ]
  },
  summary: {
    synopsis: "summary <thread-id> [--tail <n>] [--json]",
    summary: "Generate a readable transcript from the NDJSON session log (default tail=200).",
    examples: ["codex-bridge summary 019d9a86-1c8a-7f41-8032-6c76bbe730a1 --tail 400"]
  },
  status: {
    synopsis: "status [job-id] [--all] [--session <id>] [--since <iso-ts>] [--filter running|completed_success|completed_fail|completed_incomplete|cancelled|needs_attention] [--wait] [--watch [--interval 10s] [--watch-timeout-ms <ms>]] [--prune-orphans|--cleanup [--dry-run] [--retention-days <n>] [--retention-jobs <n>]] [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]",
    summary: "List jobs, or inspect one by id. List JSON includes result.jobs (always an array), result.summary, result.as_of, and active-job progress digests. Multi-job status includes event-derived summary counts and needs_attention for failed/incomplete/interrupted jobs. With --wait, poll one job to terminal. With --watch, repeatedly render the multi-job table and exit when all tracked jobs reach terminal state (Ctrl-C-safe). Use --watch for N-job orchestration.",
    examples: [
      "codex-bridge status",
      "codex-bridge status task-abc --wait --timeout-ms 600000",
      "codex-bridge status --all --json",
      "codex-bridge status --all --session claude-session-id --json",
      "codex-bridge status --since 2026-05-06T12:00:00.000Z --json",
      "codex-bridge status --filter completed_fail --json",
      "codex-bridge status --filter needs_attention --json",
      "codex-bridge status --watch --interval 5s",
      "codex-bridge status --watch --all --json"
    ]
  },
  result: {
    synopsis: "result [job-id] [--transcript [--final-only] [--format markdown|text|json]] [--json]",
    summary: "Get the full result of a completed job. Omit job-id for the latest in this session.",
    examples: [
      "codex-bridge result task-abc --json",
      "codex-bridge result task-abc --transcript --final-only --format text"
    ]
  },
  wait: {
    synopsis: "wait [--all|--any] [--jobs <ids>] <job-id-or-thread-id...> [--predicate terminal|interrupt|error|both] [--timeout-ms <ms>] [--json]",
    summary: "Block until all targets match a predicate (default: terminal) or, with --any, return the first matching job. Predicates are event-backed: terminal=[DONE]/[ERROR]/[INCOMPLETE]/[PLAN]/[CANCELLED], interrupt=[PLAN]/[QUESTION], error=[ERROR]/[INCOMPLETE], both=terminal+interrupt.",
    examples: [
      "codex-bridge wait task-abc --timeout-ms 600000 --json",
      "codex-bridge wait --all --jobs \"task-a task-b task-c\" --json",
      "codex-bridge wait --any --predicate both task-a task-b task-c --json",
      "codex-bridge wait 019d9a86-1c8a-7f41-8032-6c76bbe730a1"
    ]
  },
  events: {
    synopsis: "events <job-id-or-thread-id> [--follow] [--filter <tags> | --exclude <tags>] [--timeout-ms <ms>] [--json]",
    summary: "Stream the target's events file. `--filter` keeps only listed tags (inclusion); `--exclude` drops listed tags and shows everything else (exclusion — forward-compatible default for Monitor). Flags are mutually exclusive.",
    examples: [
      "codex-bridge events task-abc --follow --exclude HEARTBEAT,CHECKPOINT  # default Monitor shape",
      "codex-bridge events task-abc --filter DONE,ERROR,INCOMPLETE,PLAN,CANCELLED  # narrow inclusion view",
      "codex-bridge events 019d9a86-1c8a-7f41-8032-6c76bbe730a1 --follow --exclude HEARTBEAT --timeout-ms 600000  # include verbose checkpoints"
    ]
  },
  cancel: {
    synopsis: "cancel [job-id] [--keep-worktree] [--keep-branch] [--keep-all] [--json]",
    summary: "Cancel a running job. Attempts `turn/interrupt`, terminates the worker tree, and removes bridge-created worktree artifacts unless preserved.",
    examples: [
      "codex-bridge cancel task-abc",
      "codex-bridge cancel task-abc --keep-all"
    ]
  },
  merge: {
    synopsis: "merge <task_id> [--no-tests] [--pr] [--json]",
    summary: "Fast-forward merge an approved worktree task branch back into its recorded base ref.",
    examples: [
      "codex-bridge merge task-abc --json",
      "codex-bridge merge task-abc --no-tests"
    ]
  },
  "await-artifact": {
    synopsis: "await-artifact <job-id> <path> [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]",
    summary: "Block until <path> exists and is stable (size unchanged across consecutive polls), or the target job reaches a terminal state, or timeout. Primitive for multi-job orchestration when success = 'artifact exists at path'. Exit 7 on timeout or job-terminal-without-artifact.",
    examples: [
      "codex-bridge await-artifact task-abc report.md --timeout-ms 600000",
      "codex-bridge await-artifact 019d9a86-1c8a-7f41-8032-6c76bbe730a1 ./out/summary.json --json"
    ]
  },
  setup: {
    synopsis: "setup [--json] [--install-monitor-hook] [--enable-review-gate | --disable-review-gate]",
    summary: "Health check: Node/npm/Codex install, auth, broker runtime; install the Monitor hook mirror; toggle stop-gate review.",
    examples: ["codex-bridge setup --json", "codex-bridge setup --install-monitor-hook --json"]
  },
  version: {
    synopsis: "version [--backend <name>] [--check-update] [--json]",
    summary: "Print bridge version, schema version, Node version, Codex version, active backend, capability list, and cached update status. `--check-update` forces a fresh GitHub round-trip.",
    examples: ["codex-bridge version --json", "codex-bridge version --backend codex --json", "codex-bridge version --check-update --json"]
  },
  update: {
    synopsis: "update [--force] [--apply|--yes] [--json]",
    summary: "Check GitHub releases for a newer codex-bridge and print the install recipe. Does not self-modify the skill — run the printed command yourself when you want to upgrade.",
    examples: ["codex-bridge update --json", "codex-bridge update --force"]
  },
  config: {
    synopsis: "config show [--json]",
    summary: "Show effective merged config + which files the values came from (defaults < skill-dir < workspace-root < cwd). Use when a config knob seems to have no effect.",
    examples: ["codex-bridge config show", "codex-bridge config show --json"]
  },
  "auth-status": {
    synopsis: "auth-status [--json]",
    summary: "Report Codex auth state (thin wrapper; `setup` is the heavyweight equivalent).",
    examples: ["codex-bridge auth-status --json"]
  },
  "task-resume-candidate": {
    synopsis: "task-resume-candidate [--json]",
    summary: "Report the latest resumable task for this Claude session (useful before `task --resume`).",
    examples: ["codex-bridge task-resume-candidate --json"]
  },
  verdict: {
    synopsis: "verdict <task-id> [--set approved|needs-attention|must-fix --summary <text> [--finding <text>]... | --payload-stdin | --discard] [--json]",
    summary: "Read or write a task's verdict.json. Read mode (no flags) prints the current verdict. Write mode (--set) persists; stdin mode (--payload-stdin) reads a JSON object without putting review text in argv. --discard removes the artifact directory and clears the Stop gate's pending list. The Stop hook blocks while approved verdicts are unmerged.",
    examples: [
      "codex-bridge verdict task-mo5xxx",
      'codex-bridge verdict task-mo5xxx --set approved --summary "Tests green; concerns dismissed."',
      'codex-bridge verdict task-mo5xxx --set must-fix --finding "Drops 4xx errors silently" --json',
      "codex-bridge verdict task-mo5xxx --payload-stdin --json",
      "codex-bridge verdict task-mo5xxx --discard"
    ]
  },
  verdicts: {
    synopsis: "verdicts --pending [--json]",
    summary: "Flat list of approved-but-unmerged or needs-attention verdicts. Used by the Stop gate hook to decide whether to block session exit. Idempotent.",
    examples: ["codex-bridge verdicts --pending --json"]
  }
});

export const EXIT_CODE_DOC = [
  "Exit codes:",
  "  0  success",
  "  1  crash / unhandled internal error",
  "  2  usage error (unknown subcommand, unknown flag, missing argument)",
  "  3  not found (job, thread, or resource)",
  "  4  auth failure (run `codex login`)",
  "  5  conflict (already running, state mismatch)",
  "  6  validation error (bad input)",
  "  7  transient error (timeout, network, rate-limit)  — retry with backoff",
  "  8  partial success (check result details)"
].join("\n");

export const GLOBAL_FLAGS_DOC = [
  "Global flags (parsed before or after the subcommand):",
  "  --json            Machine-readable output (error envelope under failures).",
  "  -C, --cwd <dir>   Override the working directory for all bridge operations.",
  "  -h, --help        Show help for the subcommand and exit."
].join("\n");
