---
plan: 06-02
phase: 06-release-readiness-and-runtime-smoke
status: complete
completed: 2026-05-03
requirements:
  - REL-02
---

# 06-02 Summary

## Delivered

- Added `scripts/package-release.mjs` as the tested source of release packaging truth.
- Added `npm run release:package`.
- The packaging script validates tag/version alignment, stages the installable `skill/` payload under `codex-bridge/`, removes maintainer-only docs, writes `.tar.gz`, `.zip`, `SHA256SUMS`, and `RELEASE_NOTES.md`.
- Updated release workflow to run static verification and call the packaging script.
- Added archive/checksum/release-note tests.

## Validation

- `node --test test/release-readiness.test.mjs` passed.
- `npm run verify:static` passed after full Phase 6 changes.

