---
description: Show, set, reset, or explain codex-bridge configuration
argument-hint: "show | set <key>=<value> | reset [<key>] | explain <key> | path | validate | template"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" config $ARGUMENTS`

<!--
Operations:

- **show [<key-glob>]** — print effective config with `# ← <source>` provenance
- **set <key>=<value>** — write a key to `.claude/codex-bridge.local.md`
- **reset [<key>]** — remove a key (or all keys) from the local config file
- **explain <key>** — one-paragraph description of a config knob and its valid values
- **path** — print the resolved `.claude/codex-bridge.local.md` path
- **validate** — schema-validate the workspace local config file
- **template** — print a blank `.claude/codex-bridge.local.md` template

After **set** or **reset**: restart Claude Code to apply (hooks load at session start).

Examples:
  /codex-bridge:config show
  /codex-bridge:config set mode=default
  /codex-bridge:config set idle_timeout_ms=600000
  /codex-bridge:config reset mode
  /codex-bridge:config reset
  /codex-bridge:config explain mode
  /codex-bridge:config path
  /codex-bridge:config validate
  /codex-bridge:config template
-->
