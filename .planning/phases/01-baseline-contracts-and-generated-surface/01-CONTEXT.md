# Phase 1: Baseline Contracts And Generated Surface - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning
**Source:** Autonomous brownfield context from source, tests, package metadata, build config, generated bundles, and current command behavior.

<domain>
## Phase Boundary

Phase 1 delivers the baseline contracts that later phases depend on:

- A single static gate that rebuilds generated install layouts and runs all Node tests.
- A generated-surface inventory grounded in `esbuild.config.mjs`, not stale prose.
- Machine-readable JSON envelope probes for help, config, version, status, result, wait, events, setup, and error output.
- A mutating-command coverage map that names existing success/failure tests and explicit baseline gaps.

This phase does not implement new runtime delegation, review orchestration, hook behavior, or release smoke coverage. Those remain in later roadmap phases.
</domain>

<decisions>
## Implementation Decisions

### D-01 Static Gate
- The single documented static gate is `npm run verify:static`.
- The gate runs `npm run build`, `npm test`, and `npm run baseline:contracts -- --check` in that order.
- `npm run build` remains the source of generated `skill/` and `plugin/` runtime outputs.

### D-02 Contract Inventory
- The machine-readable baseline inventory lives in `scripts/baseline-contracts.mjs`.
- The script is a checked project artifact rather than a Markdown-only table so CI and local maintainers can fail on drift.
- The script exports functions for direct Node tests and also works as a CLI.

### D-03 Generated Surface Truth
- Generated surface checks must be derived from authored source paths and known build outputs:
  - `src/codex-bridge.mjs` -> `skill/scripts/codex-bridge.mjs`, `plugin/scripts/codex-bridge.mjs`
  - `src/adapters/codex/broker.mjs` -> `skill/app-server-broker.mjs`, `plugin/scripts/app-server-broker.mjs`
  - `src/prompts/adversarial-review.md` -> both prompt output layouts
  - `src/schemas/review-output.schema.json` -> both schema output layouts
  - `src/templates/execute-instructions.md` -> both template output layouts
  - `src/templates/plan-enforcement.md` -> both template output layouts
  - `skill/config.yaml` -> `plugin/config.yaml`
  - `hooks/` -> `plugin/hooks/` with plugin path transforms

### D-04 JSON Envelope Probe Style
- Envelope probes use isolated temp workspaces, `CODEX_BRIDGE_PLUGIN_DATA`, fake update cache data, and a restricted `PATH` containing only `node`.
- This keeps tests deterministic and prevents accidental Codex app-server or network dependency for baseline checks.
- The test asserts the shared envelope shape, command field, schema version, selected result fields, and JSON error envelope.

### D-05 Mutating Command Coverage
- Every command in `SUBCOMMAND_DISPATCH` must be classified as read-only or mutating.
- Mutating commands must list success and failure test files, or carry a named baseline gap explaining why static coverage is intentionally incomplete.
- Runtime-only gaps are not hidden; they are routed to later phases, especially Phase 6 authenticated smoke.

### D-06 Generated Bundle Inclusion
- Because `src/codex-bridge.mjs` imports `package.json`, changing package scripts changes the bundled package metadata in generated CLI outputs.
- Generated `skill/scripts/codex-bridge.mjs` and `plugin/scripts/codex-bridge.mjs` must be included with this phase's source change.

### the agent's Discretion
- The baseline map can live in a lightweight project script rather than a new dependency or documentation generator.
- The command coverage map can be conservative: it may name static baseline gaps instead of pretending app-server round trips are proven by local tests.
</decisions>

<canonical_refs>
## Canonical References

Downstream agents MUST read these before planning or implementing related work.

### Build and Package Truth
- `package.json` - package scripts and Node engine metadata.
- `esbuild.config.mjs` - generated output layout and static asset copy rules.
- `plugin/.claude-plugin/plugin.json` - packaged plugin path declarations.
- `skill/config.yaml` - source default config copied into the plugin layout.

### Runtime and Envelope Truth
- `src/codex-bridge.mjs` - command registry, handlers, setup/version/config/status/result/wait/events paths.
- `src/lib/cli-errors.mjs` - JSON success/error envelope builders.
- `src/lib/job-control.mjs` - status/result job resolution.
- `src/lib/state.mjs` - workspace state and job persistence.

### Test Truth
- `test/baseline-contracts.test.mjs` - Phase 1 envelope and baseline contract probes.
- `test/bridge-static.test.mjs` - static CLI/runtime contract coverage.
- `test/plugin-surfaces.test.mjs` - packaged plugin/generated surface coverage.
- `test/registry.test.mjs` - registry/verdict mutation coverage.
- `test/state.test.mjs` and `test/job-control.test.mjs` - state/job mutation coverage.
</canonical_refs>

<specifics>
## Specific Ideas

- `scripts/baseline-contracts.mjs --check` exits non-zero on missing scripts, stale static copies, unclassified dispatch commands, missing JSON probe targets, or coverage map entries that reference missing test files.
- `test/baseline-contracts.test.mjs` should run the runtime CLI with a fake Codex-free `PATH` so setup/version remain static and fast.
- `npm run verify:static` is the command later phases should cite for baseline verification.
</specifics>

<deferred>
## Deferred Ideas

- Authenticated Codex app-server smoke for task, review, send, steer, respond, and cancel remains deferred to Phase 6.
- Full iterate mutation coverage remains deferred to Phase 3 because the current command intentionally returns a staged envelope.
- Plugin/hook spoof-resistance expansion remains deferred to Phase 4.
</deferred>

---

*Phase: 01-baseline-contracts-and-generated-surface*
*Context gathered: 2026-04-30 via autonomous source exploration*
