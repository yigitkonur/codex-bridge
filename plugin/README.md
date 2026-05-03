# codex-bridge packaged plugin

this directory is the packaged claude code plugin layout for codex-bridge.

it contains the plugin-local command files, agent definitions, hook registry, generated runtime bundles, generated prompts/schemas/templates, and the packaged skill entry. source lives outside this directory; generated files are refreshed by `npm run build`.

## edit rules

- edit runtime source under `src/`.
- edit root hook source under `hooks/`.
- edit packaged command and agent surfaces under `plugin/commands/` and `plugin/agents/`.
- do not hand-edit generated runtime files under `plugin/scripts/`, `plugin/prompts/`, `plugin/schemas/`, `plugin/templates/`, or `plugin/config.yaml`.

after any source or surface change, run:

```bash
npm run build
npm test
```

## install check

from claude code, install the root plugin package and run:

```text
/codex-bridge:setup
```

from a shell inside an installed plugin, the equivalent check is:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" setup --json
```

see the root [readme](../README.md) for user-facing setup and command docs.
