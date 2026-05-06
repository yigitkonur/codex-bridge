# Phase 1 — Analysis

| Case | Verdict | Priority |
|---|---|---|
| 14.18 — `result.adapterResult.raw` control characters make JSON unsafe | Real contract risk; not reproducible in current source because the result envelope now uses `JSON.stringify`; regression coverage is present | P1 historically, P2 current residual risk |

## What The Problem Actually Is

The reported failure is that `node src/codex-bridge.mjs result <job> --json` produced a JSON envelope that standard parsers rejected before consumers could access `result.adapterResult.raw`. The field carried raw Codex output containing literal ASCII control characters such as LF, TAB, ESC, or NUL inside a JSON string instead of JSON escape sequences. The observable breakage was `jq`, `JSON.parse`, and similar tools failing with `Invalid string: control characters from U+0000 through U+001F must be escaped`.

In the current implementation, `handleResult` builds a plain payload and calls `emitSuccess("result", payload, ..., { json: true })`; `emitSuccess` serializes the whole envelope with `JSON.stringify(envelope, null, 2)`. `codexAdapter.getResult` returns the stored final message as `summary` and `finalMessage`, and nests the original job detail under `adapterResult.raw`. A local probe with newline, tab, ANSI escape, and NUL characters parsed successfully and round-tripped all strings.

## Root Cause

The historical root cause was a broken serialization boundary: arbitrary model/user/job text reached a `--json` surface without being passed through a JSON serializer. The likely implementation shape was manual JSON construction or a pre-serialized fragment inserted into the envelope.

The current residual root cause was weaker but still worth fixing: the project had tests for full final-message preservation and transcript rendering, but no explicit regression test that `result --json` remains valid when stored raw output contains control characters. Without that guardrail, a future optimization or rendering refactor could reintroduce the exact failure. The guardrail is now present in `test/result-summary-contract.test.mjs`.

## Is It A Real Problem?

Yes as a JSON contract violation: every `--json` output must be valid JSON, regardless of raw text contents. The reported blast radius and parser behavior are correct.

For the current source, the claim is overstated as an active runtime defect. The present result path uses `JSON.stringify`, and the failure is not reproducible against `src/codex-bridge.mjs`. The right current action is a regression guard, not a serializer rewrite.

## Blast Radius

| Surface | Breakage If Regressed | Who Notices | When |
|---|---|---|---|
| `result --json` | JSON parser fails before consumers can inspect any fields | Orchestrators, CI, dashboards, batch runners | Any job whose stored result includes literal control characters |
| `adapterResult.summary` / `finalMessage` | Same parser failure if emitted through an unsafe path | Result consumers seeking final output | Completed jobs with multiline or terminal-colored output |
| `adapterResult.raw.storedJob.result.rawOutput` | Same parser failure in diagnostic raw job payload | Forensics and recovery tooling | Debug sessions and post-processing |
| `events --json` | Similar failure if event lines are manually embedded | Monitor-like consumers | Event text with control characters |

## Dependencies / Overlaps

| Related Area | Relationship |
|---|---|
| Case 14.07 result summary truncation | Same consumer goal: obtain complete final Codex output programmatically. Different root cause: truncation/selection vs. JSON serialization. |
| Event stream JSON contract | Same invariant: machine-readable surfaces must use `JSON.stringify` and avoid raw text concatenation. Current `events --json` already has a JSON-envelope test. |
| `emitSuccess` / `emitError` | Shared serialization chokepoints. Keeping result output behind these helpers prevents command-specific JSON bugs. |
| State/job persistence | `writeJobFile` uses JSON persistence; stored control characters are safe on disk when written through that API. |

# Phase 2 — GSD Implementation Plan

## Grouping

| Cluster | Cases | Shared Fix Surface | Status |
|---|---|---|---|
| Result JSON serialization contract | 14.18 | `src/handlers/inspect.mjs`, `src/lib/cli-errors.mjs`, `src/adapters/codex/index.mjs`, `test/result-summary-contract.test.mjs` | Regression guard added; no runtime serializer change needed |

## Sequencing

| Wave | Prerequisite | Work | Verification |
|---|---|---|---|
| 1 — Evidence | Focus file read; current source traced | Confirm result envelope path and reproduce with synthetic control-character output | One-off CLI probe parses with `JSON.parse` and round-trips strings |
| 2 — Guardrail | Wave 1 proves current code is safe | Verify the focused regression test for `result --json` with LF, TAB, ESC, and NUL in stored raw output | `node --test test/result-summary-contract.test.mjs` |
| 3 — Bundle verification | Wave 2 passes | Run `npm run build` as the repository standard generated-surface check | `npm run build` |
| 4 — Suite verification | Wave 3 passes | Run the full Node test suite | `npm test` |

## Per-Cluster Work Items

| Cluster | Files / Modules Likely Touched | Behavior Change | Contract Fixed | Verification Method |
|---|---|---|---|---|
| Result JSON serialization contract | `test/result-summary-contract.test.mjs`; diagnostic plan file `.planning/debug/14-18-result-raw-control-chars-json-unsafe-gsd-plan-codex-2026-05-06.md` | No runtime behavior change; CI coverage now proves result envelopes parse and round-trip control-character output | `result --json` output is valid RFC-8259 JSON even when stored raw output contains control chars | Spawn CLI against an isolated synthetic job; `JSON.parse(stdout)` must succeed and parsed strings must equal the original raw output |

## Risk + Rollback Notes

| Risk | Mitigation | Rollback |
|---|---|---|
| Test fixture accidentally depends on global bridge state | Use temp workspace, temp state root via `CODEX_BRIDGE_PLUGIN_DATA`, and restore env in `t.after` | Remove the single test block |
| Assertion overfits to exact JSON escaping | Assert parser success and semantic round-trip; only assert literal NUL/ESC are absent because those are always invalid/control-risk in JSON text | Drop byte-level assertions and keep round-trip assertions |
| Pre-existing dirty generated files confuse review | Touch only the focused test and unique GSD plan file | Revert only this test block and this plan file |

## Acceptance Criteria

| Case | One-Line Check |
|---|---|
| 14.18 | A synthetic completed job whose stored raw output contains `\n`, `\t`, `\u001b`, and `\u0000` returns `result --json` output that `JSON.parse` accepts, with `adapterResult.finalMessage`, `adapterResult.summary`, and `adapterResult.raw.storedJob.result.rawOutput` equal to the original string. |

## Out Of Scope

This plan does not address broader architecture critiques from `00–13`, `15`, the flat `14-real-world-failure-cases.md`, or other per-issue files. It does not redesign result field names, event-stream semantics, summary selection, multi-agent orchestration, hook lifecycle, CLI flag parsing, worktree isolation, or monitor UX. It also does not add a `jq` dependency to CI; Node `JSON.parse` is the standard-library parser gate for this package.
