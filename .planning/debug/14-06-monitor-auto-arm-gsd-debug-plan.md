---
status: fixing
trigger: "14.06 monitor not auto-armed despite skill claim"
created: 2026-05-06
updated: 2026-05-06
---

# Phase 1 — Analysis

## Focus Case 14.06 — Monitor Not Auto-Armed Despite Skill Claim

| Field | Analysis |
|---|---|
| Problem | The packaged plugin skill promises that hooks auto-arm Monitor on background dispatches, but the bridge only emits `result.monitor.tool_hint` and a plugin-bundled `PostToolUse` hook attempts to surface that hint through `additionalContext`. In reported sessions, that `additionalContext` did not reach the orchestrator, so no Monitor was armed. |
| Root cause | `plugin/skills/codex-bridge/references/monitor-patterns.md` and `plugin/skills/codex-bridge/SKILL.md` describe a best-effort hook path as dependable wiring. The runtime has `hooks/post-tool-bash.mjs`, but `setup` has no user-settings mirror installer to bypass the Claude Code plugin-hook `additionalContext` delivery bug documented by the feedback corpus and upstream issue #16538. |
| Is it real? | Yes, with severity adjusted from absolute P0 to P0 for parallel orchestration visibility. The bridge cannot force Claude Code's plugin hook delivery, but it can stop making a false promise, provide an opt-in user-settings mirror, and make setup report whether that mirror exists. |
| Blast radius | Users launching long-running or parallel background jobs may run blind. The failure is silent because the absence of a Monitor stream is easy to miss, especially when runners return a normal-looking JSON envelope. It compounds false-completion and event-summary failures, but this case's local fix surface is setup/docs/hook handoff only. |
| Dependencies / overlaps | Overlaps with runner false-completion only at the visibility layer. It shares hook/additionalContext risk with SessionStart and PreToolUse docs, but this plan does not redesign hooks globally. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Case | Shared surface | Decision |
|---|---|---|---|
| Monitor handoff truth | 14.06 | Packaged skill reference, orchestration flow prose, task command guidance | Replace reliable-auto-arm wording with attempt-plus-verify guidance. |
| User-settings hook mirror | 14.06 | `setup` handler, setup command docs, tests | Add `setup --install-monitor-hook` to install an idempotent `PostToolUse` mirror in `~/.claude/settings.json`. |
| Setup observability | 14.06 | `setup --json`, rendered setup report | Report mirror status and give a next step when missing. |

## Sequencing

1. Add setup status/install helper.
   Verify: unit/CLI test against a temp `HOME` shows idempotent settings mutation and JSON status.
2. Rewrite monitor handoff docs.
   Verify: static test rejects the previous "hooks auto-arm Monitor" promise.
3. Rebuild generated plugin/skill scripts.
   Verify: `npm run build`.
4. Run focused and full tests.
   Verify: `npm test`.

## Per-Cluster Work Items

| Cluster | Files / modules | Behavior contract | Verification |
|---|---|---|---|
| Monitor handoff truth | `plugin/skills/codex-bridge/SKILL.md`, `plugin/skills/codex-bridge/references/monitor-patterns.md`, `plugin/skills/codex-bridge/references/orchestration-flows.md`, `plugin/commands/task.md`, root skill docs where setup is referenced | The docs say hooks attempt to surface a Monitor payload; the orchestrator must verify a Monitor stream appears and use `result.monitor.tool_hint` manually if not. | Static grep/test ensures packaged docs no longer contain the false reliable-auto-arm wording. |
| User-settings hook mirror | `src/handlers/meta.mjs`, generated `skill/scripts/codex-bridge.mjs`, generated `plugin/scripts/codex-bridge.mjs` | `setup --install-monitor-hook` appends one safe `PostToolUse` mirror entry to `~/.claude/settings.json`, pointing at the installed `post-tool-bash.mjs`, and does not duplicate it on rerun. | CLI test with temp `HOME`; parse settings JSON and assert one entry. |
| Setup observability | `src/handlers/meta.mjs`, `src/lib/render.mjs`, `src/commands-meta.mjs`, `plugin/commands/setup.md`, `skill/references/command-reference.md` | `setup --json` includes mirror status and rendered setup includes the mirror line and next-step guidance. | Baseline probe and setup regression test. |

## Risk + Rollback Notes

| Risk | Mitigation / rollback |
|---|---|
| User settings mutation can disturb an existing Claude settings file. | The install flag is explicit and opt-in. The implementation parses first, writes atomically, and only appends a single entry under `hooks.PostToolUse`. Rollback is removing the entry whose command points at `post-tool-bash.mjs`. |
| Absolute hook path can become stale after plugin reinstall. | `setup --json` reports the path it found; rerunning `setup --install-monitor-hook` after reinstall updates/keeps the mirror for the active install. |
| Docs overpromise after upstream fixes the plugin bug. | The new wording remains valid: hooks can work, but users still verify the stream instead of trusting hidden context injection. |

## Acceptance Criteria

| Case | Check |
|---|---|
| 14.06 | Running `setup --install-monitor-hook --json` under a temp `HOME` creates exactly one `hooks.PostToolUse` user-settings entry that delegates to `post-tool-bash.mjs`, and packaged docs instruct users to verify Monitor instead of assuming auto-arm. |

## Verification Evidence

| Check | Result |
|---|---|
| `npm run build && npm run baseline:contracts -- --check` | Pass |
| `node --test test/plugin-surfaces.test.mjs` | Pass |
| `node --test test/baseline-contracts.test.mjs` | Pass |
| `node src/codex-bridge.mjs setup --json` | Reports `monitorHookInstalled`, `monitorHookSettingsPath`, and the install next step when the mirror is missing. |
| `npm test` | Fails only in unrelated concurrent-change surfaces: `test/bridge-static.test.mjs` expects the old `captureTaskDiff` source text, and `test/session-log.test.mjs` expects an unquoted cwd in the timeout action. |

## Out of Scope

- Rewriting the full hook architecture from feedback docs 10-13.
- Implementing bridge-side "Monitor detached" detection with `lsof`.
- Adding a standalone `verify-monitor-attached` script.
- Fixing runner false-completed semantics from case 14.01.
- Changing Claude Code's upstream plugin hook delivery behavior.
