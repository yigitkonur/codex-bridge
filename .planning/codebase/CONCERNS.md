---
last_mapped_commit: 6b3a78a98eb5396798d0ed2ee3d8f7451f204652
refreshed: 2026-05-05
---

# Codebase Concerns

## Active Risks

**Monolithic CLI dispatcher**
- Issue: `src/codex-bridge.mjs` owns command metadata, parsing, task/review
  orchestration, update/setup/config/status handlers, verdict/merge logic, and
  worker entrypoints in one large module.
- Impact: Public command changes have a wide review surface and can miss tests,
  generated outputs, or plugin docs.
- Guardrail: Keep changes surgical, update `COMMANDS` and
  `SUBCOMMAND_DISPATCH` together, and run `npm run build`, `npm test`, and
  baseline contracts after behavior or public-surface changes.

**Dual generated distribution drift**
- Issue: Runtime source and static assets ship through both `skill/` and
  `plugin/` layouts. Root hooks are copied into `plugin/hooks/`, while command
  and agent surfaces are authored directly under `plugin/`.
- Impact: A source, hook, prompt, schema, template, config, command, or agent
  change can leave installable artifacts stale if `npm run build` is skipped.
- Guardrail: Treat `esbuild.config.mjs` and CI generated-drift checks as the
  source of truth for generated outputs.

**Hook prose can drift from active hook registration**
- Issue: The active hook set is defined by `hooks/hooks.json` and
  `plugin/hooks/hooks.json`, not by the mere presence of scripts under
  `plugin/hooks/`.
- Current fact: `PreToolUse` is registered for `Agent`; `PostToolUse` is
  registered for `Bash|Agent`; `PreToolUse(Bash)` is not registered even though
  a packaged legacy script exists and has tests.
- Guardrail: Public docs should describe installed hooks from `hooks.json`.
  Future hook activation needs manifest changes and tests together.

**Codex app-server remains an external moving contract**
- Issue: Static tests cover local protocol/client assumptions, but live
  app-server task/review/send/respond/steer/cancel behavior depends on the
  installed Codex CLI.
- Impact: Protocol drift can ship with static tests passing.
- Guardrail: Before release, run `npm run smoke:runtime -- --require-codex
  --json` against an authenticated Codex install.

**State, registry, and session artifacts are filesystem-backed**
- Issue: Job state, task registry artifacts, pending request IPC, broker state,
  and session logs live in local files under workspace/plugin data roots and
  configured session directories.
- Impact: Concurrent commands can contend on mutable files; large event logs or
  diffs can slow status/watch and recovery flows.
- Guardrail: Preserve atomic writes, append-only event/NDJSON writes, retention
  controls, and secret redaction paths.

**Generated public docs can overclaim future backend support**
- Issue: The adapter boundary exists, but only Codex is loadable today.
- Impact: Docs that imply Gemini, Aider, Claude CLI, or Ollama support create a
  false product contract.
- Guardrail: Say "Codex-only runtime" unless `src/adapters/index.mjs`,
  tests, setup/auth behavior, command help, package docs, and release notes add
  a real backend together.

## Recently Closed Concerns

- Closed-loop `iterate` is implemented and covered by `test/iterate-loop.test.mjs`
  and plugin-surface tests. It is no longer a staged/manual placeholder.
- Structured briefs are validated, appended to prompts, and persisted as
  `brief.json` / `brief.md` under task registry artifacts.
- Config diagnostics now report unknown keys and invalid values by layer.
- Update metadata, cleanup retention, and opt-in redaction landed in v2.2.0.
- Active non-GSD workflow docs were removed or converted during the
  2026-05-05 GSD-only documentation migration.

## Verification Gaps

- Static tests do not prove authenticated app-server round trips.
- Live Claude Code plugin-session hook invocation is environment-dependent and
  should be manually checked after marketplace install changes.
- `merge --pr` remains unsupported; merge is local fast-forward only.
- Future backend work needs fresh GSD requirements and primary-source research
  before implementation.
