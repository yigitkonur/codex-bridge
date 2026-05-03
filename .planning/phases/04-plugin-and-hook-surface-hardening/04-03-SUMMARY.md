---
plan: 04-03
phase: 04-plugin-and-hook-surface-hardening
status: complete
completed: 2026-05-03
---

# 04-03 Summary

## Delivered

- Promoted staged plugin hook files into authored root `hooks/` so build synchronization owns the packaged copies.
- Registered `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, and `SubagentStop` in `hooks/hooks.json` and regenerated `plugin/hooks/hooks.json`.
- Reused monitor command validation in `hooks/pre-tool-agent.mjs` / `plugin/hooks/pre-tool-agent.mjs` before emitting Monitor payloads from bridge stdout.
- Replaced skipped PostToolUse spoof tests with active cases for malformed JSON, noisy stdout, `ok:false`, wrong command, completed state, job mismatch, newline injection, subshell injection, unknown flags, prompt-only `--background`, and status-vs-phase gating.
- Preserved Stop hook lock/setup gating, pending verdict checks, timeout margin, SIGKILL, and turn-timeout tests.

## Validation

- `node --test test/plugin-surfaces.test.mjs` passed: 47 passed, 1 skipped.
- `node --test test/app-server-abort.test.mjs` passed after an initial unrelated full-suite race.
- `npm run verify:static` passed: 341 tests / 340 passed / 1 skipped, baseline contracts OK.

