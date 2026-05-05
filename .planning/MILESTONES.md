# Milestones

## v2.0.0 Bridge Completion

**Status:** Shipped 2026-05-03  
**Phases:** 1-6  
**Plans:** 19/19 complete  
**Requirements:** 28/28 satisfied  
**Audit:** `.planning/milestones/v2.0.0-MILESTONE-AUDIT.md`
**Tag:** `v2.0.0` (local annotated tag)

### Key Accomplishments

1. Added a single static verification gate that rebuilds install layouts, runs all Node tests, and checks baseline contracts.
2. Routed supported Codex task, resume, respond, steer, cancel, result, and event flows through the backend adapter lifecycle.
3. Implemented review normalization, branch-bound verdicts, approved-head merge safety, and the closed-loop `iterate` workflow.
4. Hardened packaged plugin metadata, command/agent/hook references, Stop gate behavior, and spoof-resistant Monitor automation.
5. Hardened state, session logs, registry artifacts, and structured recovery outcomes.
6. Added tested release packaging, checksums, CI static smoke, update diagnostics, and live Codex runtime smoke.

### Validation

- `npm run verify:static` passed with 354 tests / 353 passed / 1 skipped and `Baseline contracts: OK`.
- `npm run smoke:runtime -- --require-codex --json` passed against `codex-cli 0.125.0`.
- `git diff --check` passed.

### Known Deferred Items

- Live Claude Code plugin-session hook invocation after marketplace install.
- Future backend implementations beyond Codex.
- Legacy skill retirement after plugin marketplace install confidence is proven across real user machines.
- PR creation and multi-job monitor auto-arm.
- Config validation, auto-update integrity hardening, and artifact retention/redaction controls.

### Closeout State

- Required local implementation work: complete.
- Required local planning work: complete.
- Redundant live audit copy: removed; archived audit remains authoritative.
- External publication work: not part of local milestone completion; push `main` and tag `v2.0.0` when ready.

## Post-v2.2 Documentation Migration

**Status:** Complete 2026-05-05
**Phases:** n/a
**Plans:** n/a

### Key Accomplishments

1. Made `.planning/` the only contributor and agent workflow authority.
2. Converted verified review, adapter, and documentation governance rules into
   `.planning/codebase/DOCUMENTATION.md` and `.planning/codebase/ADAPTERS.md`.
3. Captured migration rationale and extracted retired workflow lessons in
   `.planning/field-reports/2026-05-05-gsd-only-migration.md`.
4. Removed active non-GSD workflow surfaces outside runtime/public
   documentation exceptions.

### Closeout State

- Required implementation work: not applicable.
- Required local planning work: complete.
- New implementation phases still require `$gsd-new-milestone`.
