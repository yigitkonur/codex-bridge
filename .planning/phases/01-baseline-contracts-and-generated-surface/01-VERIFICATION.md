---
phase: 1
status: passed
verified: 2026-04-30
requirements:
  - BASE-01
  - BASE-02
  - BASE-03
  - BASE-04
commits:
  - 7e1dca9
  - 9a0e39a
automated_checks:
  - npm run verify:static
---

# Phase 1 Verification: Baseline Contracts And Generated Surface

## Status

`passed`

## Goal

Maintainers can trust the baseline contracts that all later runtime and packaging work depends on.

## Must-Haves

| Requirement | Verification | Result |
|-------------|--------------|--------|
| BASE-01 | `package.json` exposes `npm run verify:static`, chaining `npm run build`, `npm test`, and `npm run baseline:contracts -- --check`. | Passed |
| BASE-02 | `scripts/baseline-contracts.mjs` reports and checks 8 generated source/output surface groups, including fresh esbuild comparison for bundle outputs. | Passed |
| BASE-03 | `test/baseline-contracts.test.mjs` probes help, config, version, setup, status, result, wait, events, and error JSON envelopes in an isolated fixture. | Passed |
| BASE-04 | `scripts/baseline-contracts.mjs` classifies all 24 dispatch commands and maps 14 mutating command groups to success/failure tests or explicit baseline gaps. | Passed |

## Automated Checks

```bash
npm run verify:static
```

Result on 2026-04-30:

- `npm run build` passed for both generated layouts.
- `npm test` passed: 294 tests, 285 passed, 9 skipped, 0 failed.
- `npm run baseline:contracts -- --check` passed with `Baseline contracts: OK`.

## Review Closure

The first code-review pass found one blocker and two warnings:

- Bundle generated surfaces were declared but not compared.
- Dispatch command coverage failed open if parsing broke.
- JSON probe and coverage metadata could drift because only existence was checked.

Fix commit `9a0e39a` addressed these by:

- Building expected bundle outputs into a temporary directory and byte-comparing checked-in bundle outputs.
- Failing closed when `SUBCOMMAND_DISPATCH` is missing or parses to zero commands.
- Requiring JSON probe `expected` fields, requiring test-file coverage paths, and adding regression tests for these cases.
- Reusing baseline probe metadata in the envelope test so declared expected paths are asserted against produced envelopes.

## Remaining Gaps

No Phase 1 gaps remain. Runtime-only app-server smoke gaps are intentionally tracked in later roadmap phases, especially Phase 6.

## Human Verification

Not required for this phase; the deliverables are source/test/package contract artifacts covered by the automated static gate.
