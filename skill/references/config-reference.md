# Configuration Reference

## Config file resolution

Bridge config is layered. Each layer overrides the one above it (lowest → highest):

1. **Built-in defaults** — hardcoded in `src/lib/config.mjs::DEFAULT_CONFIG`. Used when nothing else exists.
2. **Skill config** — `${CLAUDE_SKILL_DIR}/config.yaml`, e.g. `~/.claude/skills/codex-bridge/config.yaml` for a global install. This is the file that ships with the skill bundle; edit it to change defaults for every project.
3. **Workspace override** — `$(pwd)/config.yaml` (where `pwd` is the cwd passed to the command, via `-C` flag or the default process cwd). This is per-project. Use it when one repo needs different settings than your global skill config.

If any file is missing or malformed, that layer is skipped silently — the next layer's values apply. The system never crashes on config errors.

**Workspace override is new (2026-04-18).** Before that, only the skill config was read; a `config.yaml` sitting next to your project was silently ignored. See `unexpected-bridge-observations/07-cwd-config-yaml-is-ignored.md` for the original derailment.

**Quick check**: `node ${CLAUDE_SKILL_DIR}/scripts/codex-bridge.mjs setup --json | jq .result.config` surfaces the effective merged config. Use it when a knob seems to have no effect.

## Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mode` | string | `"plan"` | Collaboration mode: `"plan"` (plan first) or `"default"` (execute directly) |
| `model` | string | `"gpt-5.4"` | Default model. Inherited from Codex user config if not set. |
| `effort` | string | `"high"` | Execution reasoning effort. Plan mode always uses `"xhigh"` regardless. |
| `auto_review` | boolean | `true` | Run automatic review after task execution completes |
| `post_task_prompt` | string | (see below) | Completion check prompt. Empty string disables it. |
| `prompt_footer` | string | (see below) | Text appended to every prompt. Used to instruct Codex to use `requestUserInput` tool for questions. |
| `allow_questions` | boolean | `true` | Allow Codex to ask questions in Default mode. Always enabled in Plan mode. |
| `session_dir` | string | `"~/.codex-bridge/sessions"` | Where session logs are stored. `~` expands to home directory. |

## Default post_task_prompt

```
Review your own work critically:
1. Is this task 100% complete?
2. Are there any edge cases you missed?
3. Did you run all relevant tests?
List any unfinished items.
```

The completion check uses structured output (JSON schema) to get a binary `complete: true/false` result with specific `missing_items`.

## Examples

### Minimal (plan mode, auto-review, all defaults)
```yaml
codex_bridge:
  mode: "plan"
```

### Skip planning (direct execution)
```yaml
codex_bridge:
  mode: "default"
```

### No auto-review, no completion check
```yaml
codex_bridge:
  auto_review: false
  post_task_prompt: ""
```

### Custom completion check
```yaml
codex_bridge:
  post_task_prompt: |
    Verify:
    1. All functions have JSDoc comments
    2. No console.log statements remain
    3. TypeScript strict mode passes
    Report any violations.
```

## Resetting to Defaults

Delete `config.yaml`. Hardcoded defaults in the script take over.
