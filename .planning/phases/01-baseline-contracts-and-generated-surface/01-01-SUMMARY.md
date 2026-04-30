---
phase: 1
plan: 01-01
subsystem: baseline-static-gate
tags:
  - baseline
  - generated-surfaces
key-files:
  created:
    - scripts/baseline-contracts.mjs
  modified:
    - package.json
    - plugin/scripts/codex-bridge.mjs
    - skill/scripts/codex-bridge.mjs
metrics:
  commits: 2
  tests: npm run verify:static
---

# Plan 01-01 Summary: Static Gate And Generated-Output Inventory

## What Changed

- Added `npm run verify:static` as the single static gate.
- Added `npm run baseline:contracts` as the machine-readable baseline contract checker.
- Added generated-surface inventory and drift checks to `scripts/baseline-contracts.mjs`.
- Rebuilt generated CLI bundles so inlined `package.json` script metadata is synchronized.

## Commits

| Commit | Description |
|--------|-------------|
| `7e1dca9` | `feat(baseline): add static contract gate` |
| `9a0e39a` | `fix(baseline): fail closed on contract drift` |

## Verification

- `npm run baseline:contracts -- --check` passed.
- `npm run verify:static` passed after the follow-up review fixes.

## Deviations

None.

## Self-Check: PASSED

BASE-01 and BASE-02 are covered by the new gate and generated-surface inventory.
