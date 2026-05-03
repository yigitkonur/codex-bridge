# Phase 6 Context: Release Readiness And Runtime Smoke

## Scope

Phase 6 makes release completion evidence explicit. A maintainer should be able to rely on one static gate, source-built release archives, checksums, release notes, and a runtime smoke harness that either proves live Codex behavior or fails closed when live proof is required.

## Source Evidence

- `package.json` owns the shipped script surface.
- `.github/workflows/build.yml` owns CI build/test/generated-drift behavior.
- `.github/workflows/release.yml` owns tagged release packaging.
- `scripts/baseline-contracts.mjs` owns baseline generated-surface and command-coverage contracts.
- `src/lib/update-check.mjs`, `src/codex-bridge.mjs`, `test/update-command.test.mjs`, and `test/auto-apply.test.mjs` own update diagnostics and rate-limited auto-apply behavior.

## Plan Set

- `06-01`: CI generated drift and packaged output gates.
- `06-02`: Release packaging from source and checksum artifacts.
- `06-03`: Authenticated runtime smoke and update diagnostics.
