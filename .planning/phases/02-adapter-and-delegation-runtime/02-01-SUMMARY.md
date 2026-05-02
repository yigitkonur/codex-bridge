---
phase: 2
plan: 02-01
subsystem: adapter-capabilities
tags:
  - adapter
  - backend-precedence
  - setup-envelope
key-files:
  modified:
    - src/adapters/codex/index.mjs
    - src/codex-bridge.mjs
    - src/lib/render.mjs
    - scripts/baseline-contracts.mjs
    - test/adapter-registry.test.mjs
    - test/adapter-selection.test.mjs
    - test/baseline-contracts.test.mjs
metrics:
  commits: 1
  tests: npm run verify:static
---

# Plan 02-01 Summary: Adapter Capability Contract And Backend Precedence

## What Changed

- The Codex adapter now advertises questions, resume, and steering only because matching lifecycle methods are implemented.
- Setup output now reports the selected backend and adapter capability object.
- Baseline JSON envelope probes now require setup backend/capability fields.
- Existing backend precedence tests continue to cover CLI flag, environment, task metadata, routing, config layers, and default backend order.

## Commit

| Commit | Description |
|--------|-------------|
| `468a3e9` | `feat(adapter): route delegation through codex adapter` |

## Verification

- `npm run verify:static` passed.
- `setup --json` smoke returned `active_backend: codex` and adapter capabilities.
- `task --backend unknown --json probe` returned `BACKEND_INCAPABLE`.

## Deviations

None.

## Self-Check: PASSED

ADPT-02, ADPT-03, and ADPT-04 are covered.
