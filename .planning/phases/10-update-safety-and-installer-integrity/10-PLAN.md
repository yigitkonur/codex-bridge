# Phase 10 Plan: Update Safety And Installer Integrity

**Status:** Complete
**Milestone:** v2.2.0

## Goal

Make update checks and apply attempts more inspectable for scripts and agents.

## Delivered

- `update --json` includes structured `update_check` metadata.
- `update --json` includes structured `apply` intent/command/result metadata.
- Apply failure envelopes still preserve dependency-failure semantics.

## Verification

- `test/bridge-static.test.mjs`
- Full static gate after build.
