# Phase 1 — Analysis

| Focus case | Validated status | Priority judgment |
|---|---|---|
| `14.08 --cwd flag has two distinct bugs: positional rejection AND pre-flight check leakage` | Parser claim is real. Pre-flight leakage is not reproduced in the current modular source when `--cwd` is accepted after the subcommand. | Downgrade from P0 to P1 for current code: documented syntax is broken and blocks naive orchestration, but `task --cwd <repo> ...` and `cd <repo> && ...` remain viable workarounds. |

## What The Problem Actually Is

The current CLI dispatcher treats `process.argv[2]` as the subcommand before any shared flag parsing runs. Because of that, a documented global invocation like:

```bash
codex-bridge --cwd /path/to/repo status --json
```

is routed as subcommand `--cwd` and fails with `UNKNOWN_SUBCOMMAND`. The same applies to `-C`, `--json`, and `--help` when they appear before the subcommand. The help text says these are global flags for every subcommand, but the implementation only lets handlers parse them after the dispatcher has already selected a subcommand.

The second reported issue, "pre-flight checks ignore `--cwd`", is not supported by the current source shape for the main handler paths. `handleTask`, `handleStatus`, `handleSetup`, `handleVersion`, `handleReview`, and related handlers resolve `cwd` through `resolveCommandCwd(options)` and then pass that value into workspace resolution, config loading, Codex availability checks, Git checks, state lookup, and adapter calls. `ensureCodexAvailable(cwd)` delegates to `getCodexAvailability(cwd)`, which passes the cwd into `binaryAvailable`. `ensureGitRepository(cwd)` runs Git with that cwd. The leakage described in the report is likely either from an older bundled script or from the parser failure preventing the intended cwd from reaching the handler at all.

## Root Cause

| Layer | Root cause |
|---|---|
| Dispatcher | `main()` destructures `[subcommand, ...argv] = process.argv.slice(2)` before recognizing global flags. |
| Parser boundary | `parseCommandInput()` knows `-C -> cwd`, but it only runs inside subcommand handlers. It cannot help if the dispatcher rejects the invocation first. |
| Documentation | `GLOBAL_FLAGS_DOC` describes globals as an every-subcommand contract without stating positional limitations. Since the code now needs true globals, docs should say they are parsed before or after the subcommand. |
| Pre-flight cwd | No broad current-code root cause found. The effective cwd is already threaded through the inspected pre-flight surfaces once the handler receives `options.cwd`. |

## Is It A Real Problem?

Yes for positional global parsing. I reproduced the live failure from a non-repo CWD targeting a temporary Git repo:

```bash
CODEX_BRIDGE_NO_UPDATE_CHECK=1 node src/codex-bridge.mjs --cwd "$repo" status --json
```

Before the fix, this returned `UNKNOWN_SUBCOMMAND: --cwd` with exit code 2.

The pre-flight leakage half is overstated for this branch. A post-subcommand invocation:

```bash
CODEX_BRIDGE_NO_UPDATE_CHECK=1 node src/codex-bridge.mjs status --cwd "$repo" --json
```

correctly resolves `result.workspaceRoot` to the target repo even when launched from `/tmp`. Source review also shows Codex and Git checks receiving the resolved cwd in current handler/runtime code.

## Blast Radius

| User / workflow | Breakage |
|---|---|
| Orchestrators with stable non-repo CWD | Natural documented syntax fails before any handler runs. |
| Multi-repo fan-out scripts | Authors must remember to place `--cwd` after the subcommand or wrap every call in `cd <repo> && ...`. |
| Machine consumers using `--json` first | JSON mode can be stripped from the intended command path unless the top-level error scanner happens to notice it. |
| Help discovery | `--help <subcommand>` and `--cwd <repo> <subcommand> --help` do not behave like a true global-flag surface. |

Users notice immediately on dispatch or status/config discovery. It manifests before Codex starts, so it does not corrupt state or mutate repositories.

## Dependencies / Overlaps

| Related item | Relationship |
|---|---|
| `15 §15.2 --repo <path>` | Related ergonomics, not required to fix this case. `--repo` would be additive semantic sugar after `--cwd` is made truthful. |
| `09 absolute paths / worktree isolation` | Shares "target repo path contract" concerns, but no shared fix surface for this parser bug. |
| Generated bundle outputs | Any `src/codex-bridge.mjs` or command metadata change must be rebuilt into `skill/scripts/codex-bridge.mjs` and `plugin/scripts/codex-bridge.mjs`. |
| Other active workspace changes | `src/commands-meta.mjs`, `src/handlers/meta.mjs`, and generated bundles have concurrent edits from other agents. Stage only this case's hunks. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Cases | Fix surface | Contract fixed |
|---|---|---|---|
| A. True global dispatcher flags | 14.08 positional rejection | `src/codex-bridge.mjs`, `src/commands-meta.mjs`, `src/handlers/meta.mjs`, generated CLI bundles | `--json`, `-j`, `--cwd`, `-C`, `--help`, and `-h` are accepted before or after the subcommand, before `--`, and forwarded into existing handler parsers. |
| B. Effective cwd guardrails | 14.08 pre-flight leakage claim | Tests and source audit only | Current cwd-dependent checks continue to use handler-resolved cwd; no new `--repo` abstraction. |

## Sequencing

| Wave | Prerequisite | Work | Verify |
|---|---|---|---|
| 1. Reproduce and audit | Focus file read | Confirm `--cwd <repo> status --json` fails before subcommand; inspect handler/runtime cwd flow. | Manual red repro returns `UNKNOWN_SUBCOMMAND`; post-subcommand `--cwd` succeeds. |
| 2. Dispatcher fix | Wave 1 | Add a small top-level global scanner in `src/codex-bridge.mjs`; keep handler parsers as the single source for subcommand-specific flags. | Targeted CLI tests pass. |
| 3. Docs and machine help | Wave 2 | Update global flag docs to state globals are parsed before or after the subcommand and cwd applies to all bridge operations. | `task --help` shows corrected global flag wording. |
| 4. Regression coverage | Wave 2 | Add `test/global-flags.test.mjs` with non-repo CWD -> target repo coverage. | `node --test test/global-flags.test.mjs`. |
| 5. Generated outputs and full verification | Waves 2-4 | Run `npm run build`; run `npm test`. | Generated bundles include parser/doc changes; tests pass or failures are attributed to concurrent unrelated edits. |

## Per-Cluster Work Items

| Cluster | Files / modules likely touched | Behavior change | Verification method |
|---|---|---|---|
| A. True global dispatcher flags | `src/codex-bridge.mjs`; `src/commands-meta.mjs`; `src/handlers/meta.mjs`; generated `skill/scripts/codex-bridge.mjs`; generated `plugin/scripts/codex-bridge.mjs` | Top-level dispatch strips documented globals before selecting the subcommand, canonicalizes them back into handler argv, preserves `--` passthrough, and uses normalized argv for help/update/error JSON detection. | Spawn CLI from a non-git cwd with `--cwd <repo> status --json`, `--json -C <repo> status`, and `--cwd <repo> task --help`. |
| B. Effective cwd guardrails | `test/global-flags.test.mjs`; source audit of `src/handlers/*`, `src/lib/task-runtime.mjs`, `src/adapters/codex/codex.mjs`, `src/lib/git.mjs` | No behavior change beyond making pre-subcommand cwd reach the same already-correct handler cwd path. | Assert returned `status.result.workspaceRoot` equals target repo; source audit confirms Codex/Git checks accept cwd parameters. |

## Risk + Rollback Notes

| Risk | Mitigation | Rollback |
|---|---|---|
| Prompt text after `--` gets parsed as global flags | The scanner stops global parsing after handler passthrough begins and preserves the `--` delimiter for the handler parser. | Revert the dispatcher helper and tests; post-subcommand behavior returns to previous state. |
| Duplicate globals before and after subcommand behave unexpectedly | The top-level scanner keeps last-write-wins semantics for documented globals, matching existing `parseArgs` behavior for repeated value options. | Revert helper or move to handler-only parsing. |
| Top-level parsing steals handler-owned values such as `--prompt-file --cwd` | Only pre-subcommand globals are stripped at the dispatcher boundary; once a subcommand is found, existing handler parsers own all remaining argv. | Revert the top-level helper and keep post-subcommand-only parsing. |
| Auto-update/help/error JSON detection sees the wrong argv shape | `main()` and `catch()` use normalized dispatch argv while retaining raw argv as fallback for JSON detection. | Revert normalized detection and keep only dispatch parsing. |
| Concurrent agent edits in shared files are accidentally committed | Stage only hunks for this focus case. Do not stage unrelated monitor/setup/doc changes. | Use `git restore --staged <path>` and restage selected hunks. |

## Acceptance Criteria

| Case | One-line proof |
|---|---|
| 14.08 positional `--cwd` rejection | From a non-git directory, `node src/codex-bridge.mjs --cwd <git-repo> status --json` exits 0 and returns `command: "status"` with `result.workspaceRoot` equal to `<git-repo>`. |
| 14.08 global `-C` + `--json` | From a non-git directory, `node src/codex-bridge.mjs --json -C <git-repo> status` exits 0 and emits a JSON success envelope. |
| 14.08 help-doc truth | `node src/codex-bridge.mjs --cwd <git-repo> task --help` prints task help and says global flags are parsed before or after the subcommand. |
| 14.08 parser compatibility | `node src/codex-bridge.mjs task --prompt-file --cwd` treats `--cwd` as the prompt-file value, proving post-subcommand value parsing remains handler-owned. |
| 14.08 pre-flight cwd guardrail | Source and tests show the target repo cwd reaches existing status/config/Git/Codex pre-flight paths; no `process.cwd()` fallback is used for those handler-resolved checks. |

## Out Of Scope

- Adding `--repo <path>`.
- Fixing worktree absolute-path isolation from case `09`.
- Redesigning hook architecture, Monitor lifecycle, event-stream semantics, or multi-agent scalability from documents `00-13` or `15`.
- Changing Codex availability semantics beyond passing the effective cwd already resolved by handlers.
- Reworking config precedence or state-root hashing.
