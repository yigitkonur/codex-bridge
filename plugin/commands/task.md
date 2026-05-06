---
description: Delegate implementation, debugging, or follow-up work to Codex Bridge with Monitor-ready events
argument-hint: "[--background|--wait] [--backend <name>] [--write] [--worktree-auto|--no-worktree-auto] [--base-ref <ref>] [--on-branch <name>] [--mode plan|default] [--resume|--resume-last|--fresh] [--model <model|spark>] [--effort <low|medium|high|xhigh>] [task prompt]"
allowed-tools: Bash(node:*), AskUserQuestion, Monitor
---

Dispatch the request directly with `Bash`, not through an Agent wrapper. The bridge process is the worker boundary; the slash command's job is only to start it, preserve the JSON envelope, and attach Monitor when needed.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, preserve it and add `--json` if it is missing.
- If the request includes `--wait`, do not forward `--wait`; omit `--background` and run the task in the foreground.
- If neither flag is present, default to foreground for a short bounded task and background for a broad or multi-step task.
- If the request includes `--resume`, `--resume-last`, or `--fresh`, preserve that routing choice.
- Otherwise, before starting Codex, check for a resumable task thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be `Continue current Codex thread` and `Start a new Codex thread`.
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, add `--resume-last` before dispatch.
- If the user chooses a new thread, add `--fresh` before dispatch.
- If the helper reports `available: false`, do not ask. Dispatch normally.
- If the user did not supply a request, ask what Codex should investigate or fix.

Dispatch:

- Use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task ...` with the final flags and task text.
- Return the bridge stdout verbatim to the user unless you also attach Monitor for a background run.
- If Bash is denied or the bridge command fails, report that failure as the task result. Do not translate a denied or failed dispatch into a successful completion.

Monitor handling:

- Background task output should include a JSON envelope with `result.jobId` and `result.monitor.tool_hint`.
- When live progress is useful, pass `result.monitor.tool_hint` directly to the Monitor tool. Do not assume a hook already armed it; verify that Monitor starts streaming within a few seconds.
- For N > 1 parallel background tasks, do not arm one Monitor per job. Use `wait --any --predicate both <job-id...> --json` to wake on the next actionable job, `wait --all --jobs "<job ids>" --json` as the wave barrier, or `/codex-bridge:status --watch` for a live table.
- Do not wrap Monitor in an Agent subagent. Monitor is the parent-thread tool for this job and should return only on terminal tags.
- If Monitor is not available, the equivalent command is `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" events <job-id> --follow --exclude HEARTBEAT,CHECKPOINT`.
- Do not fabricate completion while Monitor is still running. Report status only, then wait for the terminal `[DONE]`, `[ERROR]`, `[INCOMPLETE]`, `[PLAN]`, or `[CANCELLED]` tag.

Operating rules:

- Do not paraphrase, summarize, rewrite, or add commentary before or after a foreground result.
- Leave `--effort` and `--model` unset unless the user explicitly asks for them. If they ask for `spark`, map it to `gpt-5.3-codex-spark`.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex-bridge:setup`.
