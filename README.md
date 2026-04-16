# codex-bridge

A Claude Code skill that orchestrates OpenAI's Codex as Claude's execution aide. Claude plans and orchestrates; the bridge writes structured session events; Codex does the heavy-lifting turn-by-turn under a JSON-RPC contract.

The payload is a single Node.js CLI (`src/codex-bridge.mjs`) bundled into the skill at `skill/scripts/codex-bridge.mjs`. Claude activates the skill, shells out through `Bash(node *)`, and tails the `.events` file through `Monitor` for interactive flows.

## Requirements

- Node.js ≥ 22
- Codex CLI on `$PATH`, authenticated: `npm i -g @openai/codex && codex login`
- macOS or Linux (broker uses unix sockets)

## Build

```bash
npm install
npm run build          # bundles src/codex-bridge.mjs → skill/scripts/
```

## Quick use

```bash
# Sync, self-sufficient (envelope carries phase + next_action)
node skill/scripts/codex-bridge.mjs task --json "Fix the auth bug in src/auth.ts" | jq '.result.phase, .result.next_action.command'

# Health check
node skill/scripts/codex-bridge.mjs setup --json

# Machine-readable command catalog
node skill/scripts/codex-bridge.mjs help --json
```

Full usage, lifecycle, and Monitor patterns: [`skill/SKILL.md`](skill/SKILL.md).

## Repo layout

| Path | Role |
|---|---|
| `src/` | Authored source (ESM, Node 22+). |
| `src/codex-bridge.mjs` | CLI entry + per-subcommand handlers. |
| `src/lib/` | Library modules: app-server client, codex turn capture, state, session log, auto-pipeline. |
| `src/app-server-broker.mjs` | Standalone JSON-RPC multiplexer (spawned detached). |
| `src/prompts/`, `src/schemas/`, `src/templates/` | Authored assets copied into `skill/` by esbuild. |
| `skill/SKILL.md` | Hand-edited user-facing skill doc. |
| `skill/config.yaml` | Hand-edited default config. |
| `skill/references/**` | Hand-edited reference docs (commands, events, flows, error recovery, config). |
| `skill/scripts/`, `skill/prompts/`, `skill/schemas/`, `skill/templates/` | Build output (gitignored). |
| `test-gherkin/*.feature` | Behavioral specs (not runnable; read as contract). |
| `AGENTS.md`, `CLAUDE.md`, `REVIEW.md`, `*/AGENTS.md` | Agent/contributor instructions (`CLAUDE.md` is a symlink to `AGENTS.md`). |

## License

MIT
