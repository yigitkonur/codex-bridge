# Migration: codex-bridge v1.x skill -> v2.x plugin

v2.x is a structural rewrite from the old standalone skill to the Claude Code
plugin. The CLI surface stays compatible; the install path and teaching surface
change.

## What changed

| Surface | v1.x | v2.x |
|---|---|---|
| Install path | `~/.agents/skills/codex-bridge/` (user-level skill, symlinked into `~/.claude/skills/`) | `${CLAUDE_PLUGIN_ROOT}` (Claude Code plugin) |
| Distribution | `npx skills add yigitkonur/codex-bridge` | `/plugin marketplace add yigitkonur/codex-bridge`, then `/plugin install codex-bridge@codex-bridge` |
| Teaching surface | large standalone skill reference set | slimmer plugin skill plus runtime help and GSD contributor docs |
| Active hooks | 3 (SessionStart, SessionEnd, Stop) | Three dispatchers: `lifecycle.mjs`, `tool.mjs`, `stop.mjs` |
| Worktree-per-dispatch | manual | explicit `--write --worktree-auto` |
| Monitor auto-arm | manual (rule taught in SKILL.md) | automatic via PostToolUse hook |
| Brief schema | none | `plugin/schemas/brief.schema.json` |
| Iterate workflow | none | `/codex-bridge:iterate` task -> review -> verdict -> follow-up loop |
| Verdict + merge gate | none | `/codex-bridge:verdict` + gated `/codex-bridge:merge` |
| Adapter abstraction | none | `src/adapters/` (Codex-only runtime today; future backends need fresh requirements and tests) |

## Hook entrypoints

The v2.x hook surface now uses three dispatcher files under `hooks/`:
`lifecycle.mjs`, `tool.mjs`, and `stop.mjs`. Forks or derivative plugins that
referenced older per-event hook filenames should update their hook wiring to
call the dispatcher with the Claude hook event name as `process.argv[2]`, for
example `node "${CLAUDE_PLUGIN_ROOT}/hooks/tool.mjs" PreToolUse`.

The previous hook state helper was replaced by `hooks/lib/workspace-state.mjs`
and hook wiring now reaches shared hook helpers through the dispatchers. Do not
reference the deleted old filenames from downstream `hooks.json` files.

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
   /plugin marketplace add yigitkonur/codex-bridge
   /plugin install codex-bridge@codex-bridge
   /reload-plugins
   ```
   The plugin script lives at `${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs`. The legacy skill at `~/.agents/skills/codex-bridge/scripts/codex-bridge.mjs` continues to work; both speak the same bridge protocol.

2. **Run side-by-side for ~7 days.** New tasks go through the plugin; in-flight v1.x jobs you can finish with the legacy skill. Both write to `~/.codex-bridge/`.

3. **Uninstall the legacy skill** when you're confident:
   ```bash
   rm -rf ~/.agents/skills/codex-bridge ~/.claude/skills/codex-bridge
   ```

## What you have to relearn (very little)

- **Don't manually pass the Monitor invocation.** The PostToolUse hook does it. If you see Monitor unarmed after a background dispatch, check `~/.codex-bridge/hook-errors/`.
- **`task --write` should use `--worktree-auto` for isolated work.** The active plugin manifest does not register a Bash preflight hook, so rely on the slash commands, runner agent, and explicit flags rather than a Bash hook rejection.
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
