# Phase 9 Plan: Config Validation And Diagnostics

**Status:** Complete
**Milestone:** v2.2.0

## Goal

Expose config typos and invalid values by source layer without changing config
precedence.

## Delivered

- Added known-key/type/enum diagnostics for merged config layers.
- `config show --json` now includes `diagnostics`, `warnings`, and `errors`.
- Diagnostics preserve layer and file path so users know where to edit.
- Added retention/redaction config defaults.

## Verification

- `test/config-diagnostics.test.mjs`
- `test/bridge-static.test.mjs`
