# Roadmap: codex-bridge

## Overview

This milestone makes the existing v2 bridge surface complete, internally consistent, and verifiable before adding new product breadth. The work starts by locking down baseline contracts and generated-output discipline, then hardens the adapter/delegation runtime, review loop, plugin and hook surface, state/artifact resilience, and release readiness with authenticated runtime smoke checks.

## Evidence Inputs

- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/research/SUMMARY.md`
- `.planning/codebase/CONCERNS.md`
- `.planning/codebase/TESTING.md`

Repository Markdown outside `.planning/` is not used as roadmap evidence.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions, if needed later

- [x] **Phase 1: Baseline Contracts And Generated Surface** - Maintainers can trust the static gate, generated-output map, JSON envelopes, and baseline coverage contracts. Completed 2026-04-30.
- [x] **Phase 2: Adapter And Delegation Runtime** - Users can delegate Codex work through backend-aware runtime paths and observe/control foreground and background sessions. Completed 2026-05-01.
- [ ] **Phase 3: Review Verdict And Iterate Loop** - Users can run reviews, track verdicts, enforce approved-head merge safety, and execute the closed-loop iterate workflow.
- [ ] **Phase 4: Plugin And Hook Surface Hardening** - Maintainers can ship a consistent plugin layout with safe, bounded hook behavior.
- [ ] **Phase 5: State Artifact And Recovery Resilience** - Users can trust workspace state, session logs, task artifacts, and recovery outcomes under failure.
- [ ] **Phase 6: Release Readiness And Runtime Smoke** - Maintainers can release from source with CI, packaging, authenticated smoke checks, and update diagnostics aligned.

## Phase Details

### Phase 1: Baseline Contracts And Generated Surface
**Goal**: Maintainers can trust the baseline contracts that all later runtime and packaging work depends on.
**Depends on**: Nothing (first phase)
**Requirements**: BASE-01, BASE-02, BASE-03, BASE-04
**Success Criteria** (what must be TRUE):
  1. Maintainer can run one documented static gate that rebuilds both install layouts and runs the full Node test suite.
  2. Maintainer can identify every authored source surface that requires generated `skill/` or `plugin/` output updates.
  3. Maintainer can inspect JSON envelopes for help, config, version, status, result, wait, events, setup, and error output.
  4. Maintainer can trace every mutating command to tests for success and failure behavior, or to a named baseline gap.
**Plans**: 3 plans

Plans:
- [x] 01-01: Static gate and generated-output inventory
- [x] 01-02: CLI JSON envelope and setup/config/version probes
- [x] 01-03: Mutating-command coverage map and baseline gaps

Completion evidence:
- Implementation commits: `7e1dca9 feat(baseline): add static contract gate`, `9a0e39a fix(baseline): fail closed on contract drift`
- Phase artifacts: `.planning/phases/01-baseline-contracts-and-generated-surface/`
- Static gate: `npm run verify:static` passed on 2026-04-30

### Phase 2: Adapter And Delegation Runtime
**Goal**: Users can delegate Codex work through backend-aware runtime paths and reliably observe or control foreground and background sessions.
**Depends on**: Phase 1
**Requirements**: ADPT-01, ADPT-02, ADPT-03, ADPT-04, DLGT-01, DLGT-02, DLGT-03, DLGT-04
**Success Criteria** (what must be TRUE):
  1. Maintainer can prove supported command paths use the backend adapter contract and unsupported capabilities fail with structured validation errors.
  2. User can select or detect the active backend through documented precedence and see backend capability state in version/setup output.
  3. User can start a foreground task in plan or default mode and receive session artifacts, status, final output, and errors in the standard envelope.
  4. User can start a background task, monitor it through events or status, and retrieve the completed result.
  5. User can resume, answer prompts, steer supported turns, and receive classified timeout/handoff information for silent or long-running turns.
**Plans**: 4 plans

Plans:
- [x] 02-01: Adapter capability contract and backend precedence
- [x] 02-02: Runtime dispatch migration for supported Codex operations
- [x] 02-03: Foreground/background delegation envelopes and monitoring
- [x] 02-04: Resume/respond/steer and timeout/handoff contracts

Completion evidence:
- Implementation commit: `468a3e9 feat(adapter): route delegation through codex adapter`
- Phase artifacts: `.planning/phases/02-adapter-and-delegation-runtime/`
- Static gate: `npm run verify:static` passed on 2026-05-01
- Runtime smoke: setup, foreground task, send/resume, background task, wait, result, events, and unsupported-backend probes passed on 2026-05-01

### Phase 3: Review Verdict And Iterate Loop
**Goal**: Users can hand work to Codex, regain control through review and verdict gates, and continue the loop without manual assembly.
**Depends on**: Phase 2
**Requirements**: REVW-01, REVW-02, REVW-03, REVW-04
**Success Criteria** (what must be TRUE):
  1. User can run native review and adversarial review over working-tree or branch context with structured actionable output.
  2. User can run the auto-pipeline and see review, conditional fix, check, budget, and partial-completion state explicitly.
  3. User can record verdicts, inspect pending verdicts, and merge only an approved branch whose reviewed head still matches.
  4. User can run `iterate` as task -> review -> verdict -> follow-up orchestration, or receive an explicit incomplete result with preserved artifacts.
**Plans**: 3 plans

Plans:
- [ ] 03-01: Native/adversarial review schema and context proof (wave 1; creates shared review-result and registry review artifact contracts)
- [ ] 03-02: Auto-pipeline partial-completion and check-stage proof (wave 2; depends on 03-01 shared parser/contracts)
- [ ] 03-03: Verdict, approved-head merge, and iterate orchestration (wave 3; depends on 03-01 and 03-02)

Planning evidence:
- Phase artifacts: `.planning/phases/03-review-verdict-and-iterate-loop/`
- Plan check: `.planning/phases/03-review-verdict-and-iterate-loop/03-PLAN-CHECK.md`
- Execution readiness: ready for `$gsd-execute-phase 3`

### Phase 4: Plugin And Hook Surface Hardening
**Goal**: Maintainers can ship a consistent packaged plugin surface with safe hook activation, bounded decisions, and tested metadata relationships.
**Depends on**: Phase 3
**Requirements**: PLUG-01, PLUG-02, PLUG-03, PLUG-04
**Success Criteria** (what must be TRUE):
  1. Maintainer can verify packaged plugin manifest, commands, agents, hooks, config, scripts, prompts, schemas, and templates resolve inside the packaged `plugin/` tree.
  2. Maintainer can verify root plugin metadata, package version, generated plugin metadata, and skill metadata follow an explicit tested version/canonicality relationship.
  3. User sees the Stop hook block only when project lock and setup state prove the review gate is active, with enough timeout margin to emit a decision.
  4. User sees session, subagent, user-prompt, and post-tool hooks reject unsafe monitor text or spoofed stdout and emit safe diagnostics.
**Plans**: 3 plans

Plans:
- [ ] 04-01: Packaged plugin path resolution and generated assets
- [ ] 04-02: Version/canonicality metadata and distribution stance
- [ ] 04-03: Stop gate, monitor, and hook spoof-resistance

### Phase 5: State Artifact And Recovery Resilience
**Goal**: Users can trust workspace state, session logs, task artifacts, and recovery outcomes when jobs run concurrently or fail midway.
**Depends on**: Phase 4
**Requirements**: STAT-01, STAT-02, STAT-03, STAT-04
**Success Criteria** (what must be TRUE):
  1. User can run multiple processes against the same workspace without dropping concurrent jobs or keying state to the wrong root.
  2. User can read append-only `.events` and `.ndjson` logs to replay progress, terminal outcomes, and failures.
  3. User can inspect per-task brief, metadata, review, verdict, diff, and event artifacts in stable JSON or patch formats.
  4. User receives structured, retry-aware outcomes for cancel, orphan pruning, stale locks, corrupt state, and missing artifacts.
**Plans**: 3 plans

Plans:
- [ ] 05-01: Workspace state concurrency and canonical root proof
- [ ] 05-02: Session log replay and registry artifact contracts
- [ ] 05-03: Cancel, prune, stale-lock, corrupt-state, and missing-artifact recovery

### Phase 6: Release Readiness And Runtime Smoke
**Goal**: Maintainers can call a release complete only after static gates, release packaging, authenticated smoke checks, and update diagnostics agree.
**Depends on**: Phase 5
**Requirements**: REL-01, REL-02, REL-03, REL-04
**Success Criteria** (what must be TRUE):
  1. Maintainer can rely on CI to reject stale generated bundles and missing packaged outputs.
  2. Maintainer can build release payloads from source, remove maintainer-only files from archives, and attach checksummed artifacts.
  3. Maintainer can run authenticated smoke checks for setup, task, review, and event streaming against a real Codex install before release completion.
  4. User sees update checks and auto-apply paths stay rate-limited, non-blocking on hot paths, and diagnostic when network or installer calls fail.
**Plans**: 3 plans

Plans:
- [ ] 06-01: CI generated drift and packaged output gates
- [ ] 06-02: Release packaging from source and checksum artifacts
- [ ] 06-03: Authenticated runtime smoke and update diagnostics

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Baseline Contracts And Generated Surface | 3/3 | Complete | 2026-04-30 |
| 2. Adapter And Delegation Runtime | 4/4 | Complete | 2026-05-01 |
| 3. Review Verdict And Iterate Loop | 0/3 | Not started | - |
| 4. Plugin And Hook Surface Hardening | 0/3 | Not started | - |
| 5. State Artifact And Recovery Resilience | 0/3 | Not started | - |
| 6. Release Readiness And Runtime Smoke | 0/3 | Not started | - |
