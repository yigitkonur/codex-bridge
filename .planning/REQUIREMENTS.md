# Requirements: codex-bridge

**Defined:** 2026-04-30
**Core Value:** Claude Code can hand work to Codex and regain reliable, inspectable control through stable commands, events, artifacts, reviews, and merge gates.

## v1 Requirements

These requirements define the next GSD milestone for an established codebase: make the current v2 bridge surface complete, internally consistent, and verifiable enough for future feature work.

### Baseline Contracts

- [x] **BASE-01**: Maintainer can run a single documented static gate that rebuilds both install layouts and runs all Node tests. Validated in Phase 1 by `npm run verify:static`.
- [x] **BASE-02**: Maintainer can identify all authored source surfaces that require generated `skill/` or `plugin/` output updates. Validated in Phase 1 by `scripts/baseline-contracts.mjs`.
- [x] **BASE-03**: Maintainer can use machine-readable CLI envelopes to inspect help, config, version, status, result, wait, events, setup, and error output. Validated in Phase 1 by `test/baseline-contracts.test.mjs`.
- [x] **BASE-04**: Maintainer can trace every command that mutates workspace, state, registry, or hook behavior to tests that cover its success and failure contracts. Validated in Phase 1 by `mutating_command_coverage`.

### Adapter Runtime

- [ ] **ADPT-01**: Runtime command dispatch uses the backend adapter contract for supported Codex operations instead of bypassing implemented adapter methods.
- [ ] **ADPT-02**: Adapter capability flags never advertise unsupported lifecycle methods, and unsupported capabilities fail with structured validation errors.
- [ ] **ADPT-03**: Backend resolution honors explicit flag, environment, task metadata, adapter routing, cwd config, workspace config, user/skill config, and default backend precedence.
- [ ] **ADPT-04**: Version and setup output expose active backend and capability state without requiring a live task run.

### Delegation Runtime

- [ ] **DLGT-01**: User can start a foreground task in plan or default mode and receive session artifacts, status, final output, and errors in the standard envelope.
- [ ] **DLGT-02**: User can start a background task, monitor it through `events --follow` or `status --watch`, and retrieve the completed result.
- [ ] **DLGT-03**: User can resume a task thread, answer `requestUserInput` prompts, and steer active turns only when the upstream runtime supports it.
- [ ] **DLGT-04**: Long-running or silent Codex turns terminate with classified timeout/handoff information rather than losing partial work silently.

### Review And Iteration

- [ ] **REVW-01**: User can run native review and adversarial review over working-tree or branch context with structured output and actionable findings.
- [ ] **REVW-02**: Auto-pipeline can run review, conditional fix, and check stages with stage and total budgets that surface partial completion explicitly.
- [ ] **REVW-03**: User can record verdicts, inspect pending verdicts, and merge only an approved worktree branch whose reviewed head still matches.
- [ ] **REVW-04**: `iterate` can orchestrate task -> review -> verdict -> follow-up without requiring the user to manually assemble the loop.

### Plugin And Hook Surface

- [ ] **PLUG-01**: Packaged plugin manifest, commands, agents, hooks, config, scripts, prompts, schemas, and templates all resolve inside the packaged `plugin/` tree.
- [ ] **PLUG-02**: Root plugin metadata, package version, generated plugin metadata, and skill metadata have an explicit, tested version/canonicality relationship.
- [ ] **PLUG-03**: Stop hook blocks only when the project lock and setup state prove the review gate is active, and it always leaves enough timeout margin to emit a decision.
- [ ] **PLUG-04**: Session, subagent, user-prompt, and post-tool hooks cannot be spoofed by arbitrary stdout or unsafe monitor command text.

### State And Artifacts

- [ ] **STAT-01**: Workspace state is keyed by canonical workspace root and survives multiple processes without dropping concurrent jobs.
- [ ] **STAT-02**: Session `.events` and `.ndjson` logs are append-only, readable by monitor commands, and sufficient for replaying progress and failures.
- [ ] **STAT-03**: Per-task registry artifacts persist brief, metadata, review, verdict, diff, and events in stable JSON/patch formats.
- [ ] **STAT-04**: Cancel, orphan pruning, stale locks, corrupt state, and missing artifacts produce structured, retry-aware outcomes.

### Release Readiness

- [ ] **REL-01**: CI rejects stale generated bundles and missing packaged outputs.
- [ ] **REL-02**: Release packaging builds from source, stages installable skill payloads, removes maintainer-only files from archives, and attaches checksummed artifacts.
- [ ] **REL-03**: Authenticated runtime smoke checks cover setup, task, review, and event streaming against a real Codex install before a release is called complete.
- [ ] **REL-04**: Update checks and auto-apply paths are rate-limited, non-blocking on hot paths, and produce actionable diagnostics when network or installer calls fail.

## v2 Requirements

Deferred until the v1 contracts above are complete.

### Future Backends

- **BEND-01**: Additional backend can implement the adapter contract without changing user-facing command semantics.
- **BEND-02**: Adapter routing can select backends by subagent type with full capability validation and test coverage.

### Distribution

- **DIST-01**: Plugin marketplace metadata can advertise the canonical v2 plugin directly when the packaged surface is no longer alpha.
- **DIST-02**: Legacy skill distribution can be retired only after install/update guidance and release packaging no longer depend on it.

### Runtime UX

- **RUX-01**: Closed-loop iteration can open pull requests or external review requests after local verdict approval.
- **RUX-02**: Monitor auto-arm can follow multiple concurrent jobs with robust wake-up behavior across Claude sessions.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Shipping a second backend in v1 | The existing adapter loader only includes `codex`; backend abstraction must be completed before adding another implementation. |
| Guaranteeing Windows broker behavior | Current tests and hooks primarily exercise Unix-like local socket/plugin paths. |
| Replacing the Node test runner | The project already uses `node --test test/*.test.mjs` and has no runtime dependency need for a larger framework. |
| Hand-editing generated bundles | Generated paths must come from `esbuild.config.mjs` and source assets. |
| Treating repository Markdown as implementation evidence | The initialization intentionally avoids trusting stale prose. |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| BASE-01 | Phase 1 | Complete |
| BASE-02 | Phase 1 | Complete |
| BASE-03 | Phase 1 | Complete |
| BASE-04 | Phase 1 | Complete |
| ADPT-01 | Phase 2 | Pending |
| ADPT-02 | Phase 2 | Pending |
| ADPT-03 | Phase 2 | Pending |
| ADPT-04 | Phase 2 | Pending |
| DLGT-01 | Phase 2 | Pending |
| DLGT-02 | Phase 2 | Pending |
| DLGT-03 | Phase 2 | Pending |
| DLGT-04 | Phase 2 | Pending |
| REVW-01 | Phase 3 | Pending |
| REVW-02 | Phase 3 | Pending |
| REVW-03 | Phase 3 | Pending |
| REVW-04 | Phase 3 | Pending |
| PLUG-01 | Phase 4 | Pending |
| PLUG-02 | Phase 4 | Pending |
| PLUG-03 | Phase 4 | Pending |
| PLUG-04 | Phase 4 | Pending |
| STAT-01 | Phase 5 | Pending |
| STAT-02 | Phase 5 | Pending |
| STAT-03 | Phase 5 | Pending |
| STAT-04 | Phase 5 | Pending |
| REL-01 | Phase 6 | Pending |
| REL-02 | Phase 6 | Pending |
| REL-03 | Phase 6 | Pending |
| REL-04 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 28 total
- Mapped to phases: 28
- Unmapped: 0

---
*Requirements defined: 2026-04-30*
*Last updated: 2026-04-30 after roadmap creation*
