# Roadmap: codex-bridge

## Milestones

- ✅ **v2.0.0 Bridge Completion** — Phases 1-6, shipped 2026-05-03. Archive: `.planning/milestones/v2.0.0-ROADMAP.md`
- ✅ **v2.1.0 Claude Plugin Field Report Remediation** — Phase 7, completed 2026-05-03.
- ✅ **v2.2.0 Ergonomics And Safety Hardening** — Phases 8-12, completed 2026-05-03.

## Phases

<details>
<summary>✅ v2.0.0 Bridge Completion (Phases 1-6) — SHIPPED 2026-05-03</summary>

- [x] Phase 1: Baseline Contracts And Generated Surface (3/3 plans) — completed 2026-04-30
- [x] Phase 2: Adapter And Delegation Runtime (4/4 plans) — completed 2026-05-01
- [x] Phase 3: Review Verdict And Iterate Loop (3/3 plans) — completed 2026-05-02
- [x] Phase 4: Plugin And Hook Surface Hardening (3/3 plans) — completed 2026-05-03
- [x] Phase 5: State Artifact And Recovery Resilience (3/3 plans) — completed 2026-05-03
- [x] Phase 6: Release Readiness And Runtime Smoke (3/3 plans) — completed 2026-05-03

Completion evidence:

- Audit: `.planning/milestones/v2.0.0-MILESTONE-AUDIT.md`
- Requirements archive: `.planning/milestones/v2.0.0-REQUIREMENTS.md`
- Latest static gate: `npm run verify:static` passed with 354 tests / 353 passed / 1 skipped and baseline contracts OK.
- Latest live smoke: `npm run smoke:runtime -- --require-codex --json` passed against `codex-cli 0.125.0`.

</details>

## Next Milestone

No active next milestone is defined yet. The living roadmap is closed after
v2.2.0; new implementation phases should start from `$gsd-new-milestone` so the
next scope gets fresh requirements instead of being appended casually.

Candidate v2.x themes from deferred backlog:

- Config validation and unknown-key diagnostics.
- Auto-update safety hardening and installer integrity.
- Session/artifact retention and redaction controls.
- Future backend readiness beyond the Codex adapter.
- Legacy skill retirement after plugin marketplace install confidence is proven across real user machines.
- PR creation and multi-job monitor auto-arm.

## Completed v2.2.0 Phases

- [x] Phase 8: Monitor And Artifact Ergonomics — completed 2026-05-03
- [x] Phase 9: Config Validation And Diagnostics — completed 2026-05-03
- [x] Phase 10: Update Safety And Installer Integrity — completed 2026-05-03
- [x] Phase 11: Retention, Redaction, And Cleanup Controls — completed 2026-05-03
- [x] Phase 12: Backend Readiness Audit And Closeout — completed 2026-05-03

## Completed v2.1.0 Phase

- [x] Phase 7: Claude Plugin Field Report Remediation (3/3 plans) — completed 2026-05-03
  - Scope: implement the P0/P1 runtime fixes from `.planning/field-reports/2026-05-03-codex-bridge-claude-plugin-issues.md`, align skill/docs/generated plugin surfaces, and close with full static verification.
  - Plans:
    - [x] 07-01 Runtime Contract Fixes
    - [x] 07-02 Skill And Agent Experience Alignment
    - [x] 07-03 Final Verification And Closeout

Completion evidence:

- Verification: `.planning/phases/07-claude-plugin-field-report-remediation/07-VERIFICATION.md`
- Latest static gate: `npm run verify:static` passed with 359 tests / 358 passed / 1 skipped and baseline contracts OK.

## Progress

| Milestone | Phases | Plans Complete | Status | Completed |
|---|---:|---:|---|---|
| v2.0.0 Bridge Completion | 6/6 | 19/19 | Complete | 2026-05-03 |
| v2.1.0 Claude Plugin Field Report Remediation | 1/1 | 3/3 | Complete | 2026-05-03 |
| v2.2.0 Ergonomics And Safety Hardening | 5/5 | 5/5 | Complete | 2026-05-03 |

## Completion Closeout

| Item | Status | Evidence |
|---|---|---|
| v2.0.0 phases | Complete | 6/6 phases and 19/19 plans are archived under `.planning/phases/` and summarized in `.planning/milestones/v2.0.0-ROADMAP.md`. |
| v2.0.0 requirements | Complete | `.planning/milestones/v2.0.0-MILESTONE-AUDIT.md` reports 28/28 requirements satisfied. |
| Static validation | Complete | Latest verified gate: `npm run verify:static` passed with 365 tests / 364 passed / 1 skipped and baseline contracts OK. |
| Runtime validation | Complete | Latest live smoke: `npm run smoke:runtime -- --require-codex --json` passed against `codex-cli 0.128.0`. |
| Field-report remediation | Complete | Phase 7 fixed the P0 defects, feasible P1 runtime/docs defects, and rebuilt generated plugin/skill surfaces. |
| v2.2 ergonomics and safety | Complete | Phases 8-12 added task artifact aliases, wait-any, config diagnostics, update metadata, cleanup retention, and opt-in redaction. |
| Living plan state | Complete | No active phase remains; next work starts by creating a fresh milestone. |
