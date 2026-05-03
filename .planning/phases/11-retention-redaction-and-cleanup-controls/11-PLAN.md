# Phase 11 Plan: Retention, Redaction, And Cleanup Controls

**Status:** Complete
**Milestone:** v2.2.0

## Goal

Add explicit cleanup and secret-masking controls without weakening forensic
artifact usefulness.

## Delivered

- Added `artifact_retention_jobs`, `artifact_retention_days`, and
  `redact_secrets` defaults.
- Extended `status --cleanup` with `--dry-run`, `--retention-days`, and
  `--retention-jobs`.
- Added event/ndjson redaction for common token/key patterns when
  `redact_secrets` is enabled.

## Verification

- `test/session-log.test.mjs`
- `test/config-diagnostics.test.mjs`
- `test/bridge-static.test.mjs`
