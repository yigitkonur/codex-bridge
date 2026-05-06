---
description: Delegate implementation, debugging, or follow-up work to Codex Bridge with Monitor-ready events
argument-hint: "[--background|--wait] [--backend <name>] [--write] [--group <name>] [--mode plan|default] [--resume|--resume-last|--fresh] [--model <model|spark>] [--effort <low|medium|high|xhigh>] [task prompt]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent, Monitor
---

Dispatch a codex worker for the user's task. Choose effort based on task shape (review: medium, implementation: high, audit: high; config owns the full default map). The runtime auto-arms Monitor from the envelope's `tool_hint`; read it verbatim, do not modify. Dispatch is read-only unless the prompt explicitly involves file changes. Maximum bound: one `--background` dispatch per turn. If the user wants multiple parallel codex workers, use `/codex-bridge:fan-out` instead.

Raw user request:
`$ARGUMENTS`

Use the `Agent` tool with `subagent_type: "codex-bridge:codex-bridge-runner"` and forward the raw request as the prompt. The runner is a subagent, not a skill; do not call `Skill(codex-bridge:codex-bridge-runner)` or re-enter this command from inside it.

If neither `--background` nor `--wait` is present, keep short bounded tasks foreground and broad or multi-step tasks background. Preserve explicit routing flags, including `--resume`, `--resume-last`, `--fresh`, and `--group <name>` (use `/codex-bridge:status --group <name>` for that wave). When no routing flag is provided, first run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" task-resume-candidate --json
```

If a resumable thread is available, ask once with `AskUserQuestion`: `Continue current Codex thread` or `Start a new Codex thread`, recommending continue only for clear follow-up prompts. Add `--resume-last` or `--fresh` from that answer before dispatch.

Return bridge stdout verbatim for foreground work. For background work, use `result.monitor.tool_hint` exactly as provided and do not claim completion before `[DONE]`, `[ERROR]`, `[INCOMPLETE]`, or `[PLAN]`.
