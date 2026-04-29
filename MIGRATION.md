# Migration: codex-bridge v1.x skill → v2.0 plugin

v2.0 is a structural rewrite. The CLI surface stays compatible; the install path and teaching surface change.

## What changed

| Surface | v1.x | v2.0 |
|---|---|---|
| Install path | `~/.agents/skills/codex-bridge/` (user-level skill, symlinked into `~/.claude/skills/`) | `${CLAUDE_PLUGIN_ROOT}` (Claude Code plugin) |
| Distribution | `npx skills add yigitkonur/codex-bridge` | `/plugin install codex-bridge@yigitkonur` |
| Teaching surface | 22,061 words across 9 markdown files | 3,626 words across 7 files (-84%) |
| Hooks | 3 (SessionStart, SessionEnd, Stop) | 7 (+PreToolUse Agent/Bash, PostToolUse Bash, UserPromptSubmit, SubagentStop) |
| Worktree-per-dispatch | manual | auto-injected for write-mode by PreToolUse hook |
| Monitor auto-arm | manual (rule taught in SKILL.md) | automatic via PostToolUse hook |
| Brief schema | none | `plugin/schemas/brief.schema.json` |
| Iterate workflow | none | staged `/codex-bridge:iterate` helper + reviewer subagent |
| Verdict + merge gate | none | `/codex-bridge:verdict` + gated `/codex-bridge:merge` |
| Adapter abstraction | none | `src/adapters/` (codex-only in v2.0; future backends are mechanical) |

## Compatibility

- **CLI flags** — every existing flag stays. New flags are additive.
- **Envelope schema** — remains `1.0` while additions to `result.*` (`worktree`, `task_dir`, `provenance`, etc.) are additive. The `--legacy-envelope` flag is accepted for compatibility but does not select a separate schema version yet.
- **Slash commands** — `/codex-bridge:*` namespace unchanged. New commands (`merge`, `verdict`, `iterate`) are net additions.
- **Artifact layout** — flat `~/.codex-bridge/sessions/<threadId>.*` remains readable for backward compatibility. New tasks write per-task directories at `~/.codex-bridge/jobs/<task_id>/`; there is no automated promotion command yet, so keep old session files until you are sure you no longer need them.

## Rollback

Hooks read `CODEX_BRIDGE_HOOK_DISABLE` first. Disable individually or `=all` to fall back to the v1.x experience while keeping the plugin installed:

```bash
CODEX_BRIDGE_HOOK_DISABLE=all claude
```

The `--no-hooks` global CLI flag bypasses every hook-driven behavior on a per-invocation basis. Hooks never block on errors — any internal exception writes to `~/.codex-bridge/hook-errors/<ts>.log` and emits `{"continue": true}`.

## Two-phase install (recommended)

If you want to keep the v1.x skill running while you adopt the v2.0 plugin:

1. **Install the plugin.**
   ```bash
   /plugin install codex-bridge@yigitkonur
   ```
   The plugin script lives at `${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs`. The legacy skill at `~/.agents/skills/codex-bridge/scripts/codex-bridge.mjs` continues to work; both speak the same bridge protocol.

2. **Run side-by-side for ~7 days.** New tasks go through the plugin; in-flight v1.x jobs you can finish with the legacy skill. Both write to `~/.codex-bridge/`.

3. **Uninstall the legacy skill** when you're confident:
   ```bash
   rm -rf ~/.agents/skills/codex-bridge ~/.claude/skills/codex-bridge
   ```

## What you have to relearn (very little)

- **Don't manually pass the Monitor invocation.** The PostToolUse hook does it. If you see Monitor unarmed after a background dispatch, check `~/.codex-bridge/hook-errors/`.
- **`task --write` requires `--worktree-auto`.** The PreToolUse hook will reject without it; the message includes the corrected command. To opt out, set `CODEX_BRIDGE_DISABLE_WORKTREE_AUTO=1`.
- **Verdict before merge.** `/codex-bridge:merge` refuses to run while verdict ≠ approved. Use `/codex-bridge:verdict --discard` to abandon a task without merging.
- **Briefs replace prompt-writing.md.** Use `--brief @path.json` for non-trivial work. The legacy `prompt-writing.md` was renamed to `brief-composition.md`.

## What you don't have to relearn

- All `--json` envelopes. `result.next_action.command`, `result.monitor.tool_hint`, `result.eventsPath`, `error.code`, `error.suggestion` — all stable.
- All exit codes (0/2/3/4/5/6/7/8/1).
- All terminal tags (`[DONE]`, `[ERROR]`, `[INCOMPLETE]`, etc.). New tags are forward-compatible (Monitor uses `--exclude HEARTBEAT`, not `--filter`).
- The `[QUESTION]` / `[PLAN]` interrupt flow.

## What's gone (and why)

| File / surface | Reason |
|---|---|
| `references/command-reference.md` | `<sub> --help --json` is canonical. |
| `references/config-reference.md` | `config show --json` is canonical. |
| `references/ndjson-guide.md` | Runtime event output is canonical. |
| Envelope JSON examples in SKILL.md | Owned by `--help --json` output. |
| Exit-code tables in SKILL.md | Emitted in every error envelope's `error.class`/`error.code`. |
| Timeout matrix in SKILL.md | Owned by per-subcommand `--help`. |
| Monitor patterns A-E | Collapsed to Preset A only (see `references/monitor-patterns.md`). |

## Issues, questions

File against [yigitkonur/codex-bridge](https://github.com/yigitkonur/codex-bridge/issues). For the rollback path, set `CODEX_BRIDGE_HOOK_DISABLE=all` and capture the hook-errors directory contents in your issue.
