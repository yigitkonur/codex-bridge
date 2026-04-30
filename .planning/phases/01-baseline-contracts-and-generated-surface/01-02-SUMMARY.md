---
phase: 1
plan: 01-02
subsystem: cli-json-envelopes
tags:
  - baseline
  - cli
  - json
key-files:
  created:
    - test/baseline-contracts.test.mjs
  modified:
    - scripts/baseline-contracts.mjs
metrics:
  commits: 2
  tests: node --test test/baseline-contracts.test.mjs
---

# Plan 01-02 Summary: CLI JSON Envelope And Setup/Config/Version Probes

## What Changed

- Added deterministic JSON envelope probes for help, config, version, setup, status, result, wait, events, and error output.
- Added an isolated CLI fixture using temp plugin data, fake update cache, temp session dir, fake Codex-free PATH, seeded job state, and a seeded `.events` file.
- Added baseline report metadata naming the expected fields and proving test for each probe.

## Commits

| Commit | Description |
|--------|-------------|
| `7e1dca9` | `feat(baseline): add static contract gate` |
| `9a0e39a` | `fix(baseline): fail closed on contract drift` |

## Verification

- `node --test test/baseline-contracts.test.mjs` passed.
- `npm run verify:static` passed after the follow-up review fixes.

## Deviations

None.

## Self-Check: PASSED

BASE-03 is covered by the new envelope probe test and contract report entries.
