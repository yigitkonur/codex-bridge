# Field Report: GSD-Only Documentation Migration

**Date:** 2026-05-05
**Scope:** Documentation and workflow authority cleanup.

## Goal

Make `.planning/` the only contributor and agent workflow system while keeping
public/runtime documentation required for install, packaging, command use,
release history, and runtime assets.

## Inventory Result

Kept as runtime or public distribution surface:

- `README.md`, `MIGRATION.md`, `CHANGELOG.md`, and `plugin/README.md`.
- `skill/SKILL.md`, `skill/config.yaml`, `skill/references/**`.
- `plugin/skills/codex-bridge/SKILL.md` and packaged plugin reference docs.
- `plugin/commands/*.md`, `plugin/agents/*.md`, manifests, hooks, prompts,
  schemas, templates, generated bundles, tests, and CI workflows.
- `AGENTS.md` files and `CLAUDE.md` symlinks as maintainer compatibility files
  that point back to GSD and current source facts.

Converted into GSD:

- Review invariants from `REVIEW.md`.
- Re-bloat governance from `plugin/skills/codex-bridge/references/AGENTS.md`.
- Source-adjacent adapter prose from `src/adapters/**/README.md`,
  `src/adapters/**/INTERFACE.md`, and `src/adapters/_interface/*.md`.
- Verified lessons from the retired Superpowers implementation plan.

Deleted:

- `docs/superpowers/`.
- `REVIEW.md`.
- `plugin/skills/codex-bridge/references/AGENTS.md`.
- Source-adjacent adapter prose docs not loaded by runtime or package scripts.
- Ignored local artifacts `.DS_Store`, `dist/`, and `to-delete/`.

No OpenSpec artifacts were found.

## Verified Facts

- `package.json` declares version `2.2.0`, Node `>=22.0.0`, ESM modules, and
  scripts for `build`, `test`, `baseline:contracts`, `smoke:runtime`,
  `verify:static`, and release packaging.
- `node src/codex-bridge.mjs version --json` reports package version `2.2.0`,
  active backend `codex`, and Codex adapter capabilities.
- `src/adapters/index.mjs` registers only `codex` in `ADAPTER_LOADERS`.
- `hooks/hooks.json` registers `PreToolUse` only for `Agent`; it does not
  register a `PreToolUse(Bash)` hook. The packaged legacy Bash hook script
  remains tested but inactive unless a manifest registers it.
- `scripts/package-release.mjs` packages the legacy `skill/` payload and removes
  `skill/AGENTS.md` and `skill/CLAUDE.md` from release archives.
- `npm run build` emits runtime bundles and static prompt/schema/template
  assets into both `skill/` and `plugin/`, and copies root hooks into
  `plugin/hooks/`.

## Extracted Learnings

From the retired Superpowers plan, only code-verified lessons were retained:

- Validate user inputs at CLI boundaries before calling Codex app-server.
- Edit authored `src/` and run `npm run build` instead of hand-editing bundled
  files.
- Make event streams machine-readable enough for Monitor and follow-up agents.
- Preserve clear distinctions between task failure, pipeline failure, partial
  completion, and actionable recovery.
- Prefer runtime JSON envelopes, schemas, tests, and help output over duplicated
  Markdown tables.

From the deleted review workflow doc, the retained rules are:

- Preserve app-server JSONL framing with `{ id, method, params }` requests and
  no `jsonrpc` field.
- Keep `DEFAULT_CLIENT_INFO.name` stable as `codex_bridge`.
- Preserve synchronous append-only `.events` and `.ndjson` writes.
- Keep workspace state keyed by canonical workspace root.
- Keep disk-backed `requestUserInput` / `respond` IPC.
- Run build and tests when source, generated surfaces, hooks, prompts, schemas,
  templates, or packaged command/agent surfaces change.

## Migration Notes

This report does not create a new implementation milestone. `.planning/STATE.md`
already says v2.2.0 is complete and no phase is active. Future implementation
work should start with `$gsd-new-milestone`; smaller one-off documentation
repairs may be recorded as field reports under `.planning/field-reports/`.
