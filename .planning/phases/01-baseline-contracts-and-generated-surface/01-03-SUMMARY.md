---
phase: 1
plan: 01-03
subsystem: command-coverage-map
tags:
  - baseline
  - command-coverage
key-files:
  created:
    - scripts/baseline-contracts.mjs
  modified:
    - test/baseline-contracts.test.mjs
metrics:
  commits: 2
  tests: npm run verify:static
---

# Plan 01-03 Summary: Mutating-Command Coverage Map And Baseline Gaps

## What Changed

- Added read-only vs mutating command classification for all 24 dispatched commands.
- Added success/failure test file mappings for all 14 mutating command groups.
- Added explicit baseline gaps for runtime-only behavior that static tests cannot honestly prove.
- Added contract checks that fail when a dispatch command is unclassified or when mapped test files are missing.

## Commits

| Commit | Description |
|--------|-------------|
| `7e1dca9` | `feat(baseline): add static contract gate` |
| `9a0e39a` | `fix(baseline): fail closed on contract drift` |

## Verification

- `node scripts/baseline-contracts.mjs --json` reports `dispatch_commands: 24`, `classified_commands: 24`, `mutating_commands: 14`, `read_only_commands: 11`.
- `npm run verify:static` passed after the follow-up review fixes.

## Deviations

None.

## Self-Check: PASSED

BASE-04 is covered by the coverage map and explicit baseline-gap list.
