---
description: Delegate implementation, debugging, or follow-up work to Codex Bridge with Monitor-ready events
argument-hint: "[--background|--wait] [--backend <name>] [--write] [--mode plan|default] [--resume|--resume-last|--fresh] [--model <model|spark>] [--effort <low|medium|high|xhigh>] [task prompt]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent, Monitor
---

Invoke the `codex-bridge:codex-bridge-runner` subagent via the `Agent` tool (`subagent_type: "codex-bridge:codex-bridge-runner"`), forwarding the raw user request as the prompt.
`codex-bridge:codex-bridge-runner` is a subagent, not a skill. Do not call `Skill(codex-bridge:codex-bridge-runner)` or re-enter this command from the subagent.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, preserve it and route to the subagent.
- If the request includes `--wait`, route to the subagent in foreground mode and do not forward `--wait`.
- If neither flag is present, default to foreground for a short bounded task and background for a broad or multi-step task.
- If the request includes `--resume`, `--resume-last`, or `--fresh`, preserve that routing choice.
- Otherwise, before starting Codex, check for a resumable task thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skill/scripts/codex-bridge.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be `Continue current Codex thread` and `Start a new Codex thread`.
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, add `--resume-last` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.
- If the user did not supply a request, ask what Codex should investigate or fix.

Monitor handling:

- Background task output should include a JSON envelope with `result.jobId` and `result.monitor.tool_hint`.
- When live progress is useful, pass `result.monitor.tool_hint` directly to the Monitor tool.
- If Monitor is not available, the equivalent command is `node "${CLAUDE_PLUGIN_ROOT}/skill/scripts/codex-bridge.mjs" events <job-id> --follow --exclude HEARTBEAT`.
- Do not fabricate completion while Monitor is still running. Report status only, then wait for the terminal `[DONE]`, `[ERROR]`, or `[INCOMPLETE]` tag.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/skill/scripts/codex-bridge.mjs" task ...` and return stdout as-is.
- Return the bridge stdout verbatim to the user unless you also attach Monitor for a background run.
- Do not paraphrase, summarize, rewrite, or add commentary before or after a foreground result.
- Leave `--effort` and `--model` unset unless the user explicitly asks for them. If they ask for `spark`, map it to `gpt-5.3-codex-spark`.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex-bridge:setup`.
