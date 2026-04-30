# REVIEW.md — codex-bridge review rules

Rules to apply when reviewing diffs to this repo. Grounded in repo evidence and in the upstream Codex app-server protocol spec and test suite. Not a general best-practices list.

Severity:
- **[ERROR]** — breaks the protocol or user-visible lifecycle; reviewer must block.
- **[WARN]** — breaks a tested invariant or a documented conventon; reviewer must require a fix or an explicit waiver.
- **[INFO]** — a worth-flagging smell; reviewer may request a fix.

## Critical areas (must block on ERROR)

### Protocol fidelity with the Codex app-server

1. **[ERROR]** `DEFAULT_CLIENT_INFO.name` in `src/adapters/codex/protocol.mjs` must remain ASCII, no CR/LF/colons. Upstream echoes it as the `originator` HTTP header on every `/v1/responses` call; invalid values return `-32600 "Invalid clientInfo.name..."`. Tested upstream in `initialize.rs::initialize_rejects_invalid_client_name`.
2. **[ERROR]** Never add `"jsonrpc": "2.0"` to outbound messages. The upstream README explicitly documents the field is omitted. Parsers on both ends will mis-handle the addition.
3. **[ERROR]** Wire framing on stdio must stay newline-delimited JSON. Any change to read/write path must preserve this — the upstream Rust client enforces the same framing and will drop the connection if it breaks.
4. **[ERROR]** `turn/interrupt` handling must not treat the `{}` response as "turn done". The state machine in `src/adapters/codex/codex.mjs::captureTurn` must wait for `turn/completed` with `status: "interrupted"`. Any shortcut that resolves the turn earlier corrupts subsequent follow-ups.
5. **[ERROR]** `serverRequest/resolved` must precede `turn/completed` for any outstanding server request. Our state machine upholds this by draining `pendingCollaborations`. A change that resolves the capture before the drain will regress against upstream tests `request_user_input.rs` / `request_permissions.rs`.
6. **[ERROR]** `outputSchema` must be passed per-turn, never cached at thread level. Upstream tests pin this (`output_schema.rs::turn_start_output_schema_is_per_turn_v2`).
7. **[ERROR]** `turn/steer` must never be sent to review turns or manual-compact turns, and must always include `expectedTurnId`. Upstream rejects with `-32600` and we should pre-empt.
8. **[ERROR]** `experimentalApi: true` must stay set in `DEFAULT_CAPABILITIES` as long as we call any of: `item/tool/requestUserInput`, `item/plan/delta`, `collaborationMode/list`. Flipping it off silently breaks plan mode and user-input handling.

### State and persistence

9. **[ERROR]** `src/lib/session-log.mjs` writes to `.events` and `.ndjson` exclusively via `appendFileSync`. A PR that introduces `fs.promises.appendFile` or batched async writes here will interleave lines from concurrent turns.
10. **[ERROR]** `src/lib/state.mjs::saveState` must remain the only writer of `state.json`. Bypassing it skips job-pruning and leaves orphaned `jobs/*.json` detail files on disk.
11. **[ERROR]** `src/lib/state.mjs` must keep using `fs.realpathSync.native` (not `realpathSync` or `path.resolve`) when computing workspace hashes. Changing it will shift the state dir for every existing user's checkout and orphan their job history.
12. **[ERROR]** Dual-write of `writeJobFile` + `upsertJob` in `src/lib/tracked-jobs.mjs` must stay ordered detail-first, index-second. A failure between the two must never leave the state index pointing at a missing detail file.

### Lifecycle and IPC

13. **[ERROR]** The `pending-requests` protocol (disk-based IPC for `requestUserInput`) must be preserved. The worker process is the sole writer of `.pending.json`; the `respond` CLI is the sole writer of `.response.json`; the response file is consumed on read. PRs that add a second writer, or switch to an in-memory channel, break cross-process semantics.
14. **[ERROR]** `broker.mjs::STREAMING_METHODS` exclusive-ownership semantics must remain: another client making a non-interrupt request during an active stream gets `-32001 BROKER_BUSY_RPC_CODE`. The `turn/interrupt` carve-out must remain, so hung turns can be cancelled from a sibling client.

## Security

15. **[ERROR]** Spawned commands that are expected to finish quickly (e.g. `captureGitDiff` in `src/lib/session-log.mjs`, git helpers in `src/lib/git.mjs`) must retain explicit timeout caps (currently 10 s). Long-lived processes (`codex app-server`, the broker) are deliberately uncapped but must preserve their explicit shutdown/cleanup paths (`close()` + `terminateProcessTree` + best-effort socket/pid cleanup).
16. **[ERROR]** Shell quoting in `src/lib/args.mjs::splitRawArgumentString` is the only place user-supplied raw argument strings are parsed. Changes must not introduce command injection. Regression: any change that evaluates or forwards argument content through `shell: true` beyond what already exists for Windows parity.
17. **[WARN]** User-controlled text must never be interpolated into `<role>`, `<task>`, or other directive blocks of `src/prompts/*.md`. Focus text lives inside `{{USER_FOCUS}}` specifically to prevent role hijacking.
18. **[WARN]** `src/lib/git.mjs::formatUntrackedFile` inlines untracked files only when `isProbablyText && size < 24 KB` (`MAX_UNTRACKED_BYTES`). A PR that increases the threshold or drops the text-sniff will leak binary blobs into review prompts and session logs.
19. **[WARN]** Developer-instruction templates in `src/templates/` must keep the "do not ask questions" rule in execute mode. Removing it will cause auto-pipeline stages to stall on `waitForResponse` for 5 min.

## Conventions

20. **[WARN]** Edits under `src/` must be accompanied by a `npm run build` run locally before commit when CI doesn't cover it. The `skill/scripts/*` bundle is gitignored, so commits containing `src/` changes without a matching tree update will ship stale bundles to end users.
21. **[WARN]** New bundled assets must land in both `esbuild.config.mjs::copies` and `.gitignore` in the same change. Missing either leaks build output into git or leaves the skill without the asset at runtime.
22. **[WARN]** New CLI subcommands need: handler in `src/codex-bridge.mjs`, `main()` switch entry, `printUsage()` line, AND a reference entry in `skill/references/command-reference.md`. Once `feat/runtime-improvements` lands, also require behavioral coverage in `test/<name>.test.mjs`; on this branch alone the test suite is not yet wired so reviewers must instead exercise the new subcommand against an authenticated Codex install. PRs missing the non-test items are incomplete.
23. **[WARN]** New notification tags need: format helper in `src/lib/session-log.mjs`, spec in `skill/references/notification-format.md`. Once `feat/runtime-improvements` lands, also require behavioral coverage in `test/<name>.test.mjs`; on this branch alone the suite is not yet wired so verify the tag end-to-end via the CLI. PRs missing the non-test items are incomplete.
24. **[INFO]** Prefer `outputCommandResult(payload, rendered, options.json)` over raw `console.log` in handlers. Consistent JSON flag support.
25. **[INFO]** Prefer `src/lib/` helpers to inline logic in `src/codex-bridge.mjs`. Handler file already pushes ~1500 lines.

## Performance

26. **[WARN]** Completion is preferentially driven by `turn/completed`, but `src/adapters/codex/codex.mjs::scheduleInferredCompletion` (defined at line 382, called from agent-message and drained-subagent paths at lines 422/441/587) is an intentional fallback that completes the capture when `turn/completed` is missing after a final-answer item plus drained collaboration work. Do not remove or short-circuit that path; do not infer completion from text alone outside that helper.
27. **[WARN]** Idle-check interval is `Math.min(5000, idleTimeoutMs)`. Hard-coding 5000 regresses short timeouts; removing the check regresses stall detection.
28. **[INFO]** Broker ready-poll interval is 50 ms with no published justification. Changes should note the startup-latency / syscall-budget tradeoff.

## Patterns to keep

29. **[WARN]** JSON-RPC ID allocation must stay centralized in the client (monotonic `this.nextId++`). Exposing ID generation to callers (as the Rust reference client does) is error-prone in JS where `Promise`-based awaits encourage interleaved requests.
30. **[WARN]** Workspace vs cwd split: state and jobs key off workspace root (`src/lib/workspace.mjs::resolveWorkspaceRoot`); git and Codex spawn env use cwd. Blending them will break per-subdirectory invocations in the same repo.
31. **[INFO]** Prefer the existing typed-ish JSDoc in `src/adapters/codex/protocol.d.ts` over ad-hoc shapes. If a new upstream field is used, add it to the .d.ts first.

## Ignore

- **Style**: 2-space indent, double quotes in JS strings, trailing semicolons — present but not enforced by tooling. Don't block on these.
- **Naming**: camelCase for JS, kebab-case for .mjs file names. Don't block on preference-level renames.
- **Comments**: existing code is sparsely commented by design (see root AGENTS.md rule on comment-hygiene inherited from system prompt). Don't require new comments unless they pay off a non-obvious WHY.
- **Import order**: not mechanically enforced; group node:* first, then local lib/*. Don't block on reorders.

## Testing

- **The runnable test suite arrives with `feat/runtime-improvements`** (`test/*.test.mjs` via `npm test`, Node built-in test runner). On this branch alone `package.json` declares only `build` and `dev`, so `npm test` is not yet runnable — reviewers must manually verify behavior a PR changes by running `npm run build && node skill/scripts/codex-bridge.mjs …` against a real Codex install. Once that stack lands, the suite will cover static contracts (plugin surfaces, config defaults, command coverage) but will still not exercise live app-server round trips, so the manual verification step remains required for protocol-affecting changes.
- **Before approving a PR that touches protocol code**, run a task round-trip locally: `node src/codex-bridge.mjs task --write "<trivial prompt>"`, observe the plan, approve with `send --mode default`, wait for `[DONE]`. Confirm `.events` and `.ndjson` are well-formed.
- **Before approving a PR that touches `captureTurn` or the state machine**, additionally run a task with `--write` that triggers a question (`requestUserInput` path) and verify `respond` works end-to-end.
- **Before approving a PR that changes `protocol.mjs` wire handling**, additionally re-read `codex-rs/app-server/README.md` and diff-check `src/adapters/codex/protocol.d.ts` against a freshly-regenerated TS schema from the upstream `codex app-server generate-ts --experimental` command.

## Upstream drift watchlist

Things to re-verify whenever Codex releases a new version:

- `protocol/common.rs::ClientRequest` / `ServerNotification` / `ServerRequest` — method string names and enum variants.
- `error_code.rs` — numeric constants; especially `-32001` behavior.
- `codex-rs/app-server/tests/suite/v2/*` — new tests often reveal new invariants. Check for additions to `request_user_input.rs`, `request_permissions.rs`, `turn_interrupt.rs`, `review.rs`, `thread_resume.rs`.
- `codex-rs/app-server-client/src/lib.rs` — default timeouts, backpressure behavior, server-request auto-rejection codes.

When any of those change, open a separate PR that updates this REVIEW.md and the corresponding rules in `src/lib/AGENTS.md`.
