# gherkin-tests-v2 — behavioral contract for codex-bridge

Second-generation Gherkin specs for codex-bridge. The first generation (`test-gherkin/` referenced from `AGENTS.md`) never existed in this branch; v2 replaces it from scratch after a deep code exploration. These files are **contract docs, not runnable tests** — there is no `cucumber-js` / `vitest-cucumber` in `package.json`. Treat each scenario as: "here is an invariant the code must hold; here is how you'd verify it by hand or in CI."

## Why v2

Every scenario in here was extracted from a targeted code read — the four Explore agents mapped:

1. **CLI surface** (`src/codex-bridge.mjs`, `src/lib/args.mjs`) — every subcommand, flag, exit code, envelope shape.
2. **Event + artifact lifecycle** (`src/lib/session-log.mjs`, `src/lib/codex.mjs`, `src/lib/auto-pipeline.mjs`, `src/lib/pending-requests.mjs`) — every tag, every `.ndjson` kind, every `{threadId}.*` artifact.
3. **Config surface** (`src/lib/config.mjs`) — every `codex_bridge:` key, every CLI override, every cross-key coupling.
4. **Error taxonomy + auto-pipeline** (`src/lib/cli-errors.mjs`, `src/lib/auto-pipeline.mjs`) — every `error.code`, every pipeline stage, every known `ok:true` + `[ERROR]` ambiguity.

Each scenario cites which finding it exercises. If the code later drifts, the citation tells you what broke.

## Layout

```
gherkin-tests-v2/
├── AGENTS.md                                    (this file)
├── 01-lifecycle/                                task lifecycle: plan → approve → execute → pipeline
│   ├── 01-plan-approval-happy-path.md
│   ├── 02-plan-revision-cycle.md
│   └── 03-direct-default-mode-skips-plan.md
├── 02-questions/                                requestUserInput vs plain-text fallback
│   ├── 01-forced-tool-question.md
│   ├── 02-plain-text-fallback-when-footer-empty.md
│   └── 03-question-timeout-empty-answers.md
├── 03-config/                                   YAML toggles and their observable effects
│   ├── 01-auto-review-false-shortcircuits-pipeline.md
│   ├── 02-empty-post-task-prompt-skips-check.md
│   └── 03-plan-mode-masks-effort-config.md
├── 04-errors/                                   typed error envelopes and exit codes
│   ├── 01-invalid-thread-id.md
│   ├── 02-unknown-subcommand.md
│   ├── 03-review-empty-diff.md
│   └── 04-wait-timeout.md
├── 05-ambiguities/                              known flex points where docs and code disagree
│   ├── 01-pipeline-error-coexists-with-ok-true.md
│   └── 02-allow-questions-flag-not-enforced.md
├── 06-artifacts/                                session files: .events, .ndjson, .plan.md, .diff
│   ├── 01-events-ndjson-append-only.md
│   ├── 02-plan-md-absent-without-structured-plan.md
│   └── 03-review-json-is-phantom-file.md
├── 07-orchestration/                            background jobs, monitor, cancel, resume
│   ├── 01-background-worker-ignores-mode-override.md
│   ├── 02-events-follow-prefix-aware-filter.md
│   ├── 03-wait-blocks-on-terminal-tag.md
│   └── 04-cancel-interrupts-running-turn.md
└── 08-review-and-resume/                        review commands and resume semantics
    ├── 01-adversarial-review-structured-findings.md
    └── 02-resume-last-vs-fresh-conflict.md
```

**24 scenarios total.** Non-repetitive — every file exercises at least one invariant no other file tests.

## Scenario template

Every `*.md` follows this shape:

```markdown
# <context>-<slug>

**Derived from:** <citation: file.mjs:line, SKILL.md section, explore-agent finding>
**What this catches:** <one-paragraph regression narrative>
**Runtime cost:** <fast (sub-second) | medium (<30 s) | slow (minutes)>
**Test subject:** <the fixture — usually "single-page HTML site" so assertions are concrete>

## Feature: <high-level feature>

### Background

Given `bridge()` is defined as `node ${REPO_ROOT}/skill/scripts/codex-bridge.mjs "$@"` (see "Which binary the specs target" below — this is non-negotiable; the function form is portable across bash and zsh, a raw `$BRIDGE` variable is not)
And `${REPO_ROOT}` is this repo's root (`git rev-parse --show-toplevel`)
And `npm run build` has been run since the last `src/` edit
And <other preconditions — config, cwd, git state, auth>

### Scenario: <assertion name>

Given <state>
When <action>
Then <observable>
And <observable>

### Pass / fail predicate

<exact shell assertion — e.g. `jq -e '.result.phase == "plan-pending"' task.json`>

### Enhancement candidates

<what a future skill update or script fix would improve — the derailment this would have caught>
```

**Why this format:** it survives the lack of a runner. A future maintainer can read the scenario, paste the Given/When steps into a shell, and eyeball the Then clauses. The pass/fail predicate is deliberately a jq / grep expression so it's mechanically checkable.

## Which binary the specs target (READ THIS BEFORE WRITING A SPEC)

**Every spec MUST target the repo's own bundle at `${REPO_ROOT}/skill/scripts/codex-bridge.mjs` — never `~/.claude/skills/codex-bridge/…` or any globally-installed copy.**

### Why this matters

The global path `~/.claude/skills/codex-bridge/scripts/codex-bridge.mjs` is populated by `npx skills add` from whatever commit of this repo's `main` branch is on GitHub. A developer can:

1. Edit `src/codex-bridge.mjs` in the repo
2. Run `npm run build` — `skill/scripts/codex-bridge.mjs` in the repo updates
3. Run the specs — **against the stale global copy that still reflects the last release**
4. See green. Merge. Ship a broken skill to every user who installed via `npx skills add`.

That's the derailment a stop-hook review caught in v1 of these specs. The fix is structural: the specs *verify* the repo's current bundle. The global install is for *using* the skill in Claude Code, not for testing it.

### The single rule

Every spec's Background section MUST define `bridge` as a shell function with exactly this form:

```sh
# The canonical definition — paste into every Background.
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
bridge() { node "${REPO_ROOT}/skill/scripts/codex-bridge.mjs" "$@"; }
```

Then every invocation is `bridge task --json "…"`, `bridge help --json`, etc. — not `$BRIDGE …`.

**Why a function, not a string variable?** A plain `BRIDGE="node /path/to/script"` followed by `$BRIDGE help` works in bash (word-split on expansion) but silently fails in zsh (no split by default — the whole string becomes a single command name and you get `command not found` / exit 127). The function form works identically in both shells and is the only portable idiom for this repo.

Not `~/.claude/skills/codex-bridge/…`. Not `npx …`. Not any installed copy anywhere on disk. The repo bundle via `bridge`, always.

### Before running specs, rebuild

Because the bundle is a build artifact (committed to git per `.github/workflows/build.yml` drift check), contributors who edit `src/` must `npm run build` before running specs. A spec that verifies a stale `skill/scripts/codex-bridge.mjs` is as bad as one that verifies the wrong binary — it's just one step removed. Put this at the top of any harness script:

```sh
cd "$(git rev-parse --show-toplevel)"
npm run build >/dev/null
export BRIDGE="node $PWD/skill/scripts/codex-bridge.mjs"
```

### Dev-loop alternative (not for contract verification)

For iterating on `src/` without rebuilding, you MAY redefine `bridge` to the unbundled entry:

```sh
# Dev-only. Do NOT commit specs that require this path.
bridge() { node "${REPO_ROOT}/src/codex-bridge.mjs" "$@"; }
```

The code surface is identical — both entries dispatch through the same handlers, and `ROOT_DIR` detection in `src/codex-bridge.mjs:97-103` resolves correctly for both layouts. The real differences are operational: `src/` picks up uncommitted edits instantly (good for iteration, bad for reproducibility), while the bundle is a frozen snapshot of the last `npm run build`. Use `src/` to fail fast during development; always re-run against `skill/scripts/codex-bridge.mjs` before claiming a spec passes.

### Summary — forbidden vs allowed spec paths

| Spec says | Verdict | Reason |
|---|---|---|
| `bridge()` function wrapping `node ${REPO_ROOT}/skill/scripts/codex-bridge.mjs` | canonical | works in bash and zsh; references the repo's build |
| `bridge()` wrapping `node $PWD/skill/scripts/...` (from repo root) | equivalent | same file, different prefix |
| `bridge()` wrapping `node ${REPO_ROOT}/src/codex-bridge.mjs` | dev-loop | fine locally; do not commit specs that require it |
| `BRIDGE="node ..."` + `$BRIDGE args` (string variable) | forbidden | silently fails in zsh (no word-splitting on expansion — exit 127) |
| `node ~/.claude/skills/codex-bridge/scripts/codex-bridge.mjs` | forbidden | verifies the installed copy, not the repo's current build |
| `node /Users/<name>/.claude/skills/codex-bridge/…` | forbidden | hardcoded user path; not portable |
| `node .agents/skills/codex-bridge/...` or any project-scope install | forbidden | same class of bug as the global path |
| `npx skills add …` or any install command embedded in a spec | forbidden | specs assume the bundle is already built |

## Fixture convention

Most scenarios use **"build a one-page HTML site with hero + feature list + footer"** as the test subject. Rationale:

- Codex reliably produces a structured plan for this prompt (exercises `[PLAN]` emission).
- The output is a small, easily inspected file tree (`index.html`, maybe `styles.css`).
- It's fast enough that slow-mode scenarios finish in 3–8 minutes instead of 20+.
- Visual verification is trivial: open the file in a browser.

Scenarios that deliberately provoke non-HTML outputs (prompt injection tests, error paths) say so explicitly.

## What's NOT in scope

- **Cross-agent install tests** (skills.sh, agentskills.io spec conformance) — covered by `.github/workflows/` and the README's guided bootstrap.
- **Performance / latency benchmarks** — no runtime budgets are asserted; only correctness and envelope shape.
- **Codex upstream behavior** — if Codex's LLM produces nondeterministic output, we assert on *structural* properties (envelope fields, event tag presence) not on text contents.
- **Broker internals** — unix socket lifecycle, JSON-RPC framing, reconnect logic. Those belong to a unit-test layer under `src/lib/` that doesn't exist yet.

## Mapping from derailments to scenarios

This is the payoff: each scenario was chosen because a specific derailment in SKILL.md or a specific corner-case in the code suggested the skill could fail there.

| Derailment / corner-case | Scenario(s) |
|---|---|
| "Codex may ask questions via plain text instead of using `requestUserInput`" | `02-questions/02-plain-text-fallback-when-footer-empty.md` |
| "`--write` has no effect until plan approval with `--mode default`" | `01-lifecycle/03-direct-default-mode-skips-plan.md`, `03-config/03-plan-mode-masks-effort-config.md` |
| "task --background --mode default stores override but worker reads config.mode" | `07-orchestration/01-background-worker-ignores-mode-override.md` |
| "`[ERROR]` fires for pipeline timeouts but sync envelope can still be `ok:true, phase:incomplete`" | `05-ambiguities/01-pipeline-error-coexists-with-ok-true.md` |
| "`allow_questions: false` is not actually enforced" | `05-ambiguities/02-allow-questions-flag-not-enforced.md` |
| "`[REVIEW]`, `[PHASE]`, `{threadId}.review.json` are defined but not emitted" | `06-artifacts/03-review-json-is-phantom-file.md` |
| "Review turns cannot be steered — upstream `-32600`" | implicitly covered via `08-review-and-resume/01-adversarial-review-structured-findings.md` commentary |
| "`[QUESTION]` response file read is destructive (`unlinkSync`)" | `02-questions/03-question-timeout-empty-answers.md` |
| "Plan mode forces effort:xhigh regardless of config/CLI" | `03-config/03-plan-mode-masks-effort-config.md` |
| "120 s idle watchdog" | `04-errors/04-wait-timeout.md` (sibling behaviour) |
| "`.events` tags `[DONE]` `[ERROR]` `[INCOMPLETE]` are terminal; Monitor self-terminates" | `07-orchestration/03-wait-blocks-on-terminal-tag.md`, `07-orchestration/02-events-follow-prefix-aware-filter.md` |

## How to add a new scenario

1. Pick (or create) the right `NN-<context>/` directory. Contexts should cluster on *what surface the scenario exercises*, not what outcome it asserts.
2. Number sequentially: `01-`, `02-`, ... — preserve order even after deletions; a gap is a signal that a scenario was retired.
3. Slugify the scenario name: kebab-case, 3–6 words, describes the invariant.
4. Cite one concrete file:line or explore-agent finding in **Derived from**. If you can't cite anything, you're writing a hypothetical, not a contract.
5. Keep runtime cost honest — if the scenario invokes Codex, mark it `slow`. Fast scenarios should be provable with a single `--json` call on a canned input.
6. Update this index.

## Caveat — this is observation, not policing

Several scenarios document *current behavior that could be argued to be bugs* (see `05-ambiguities/`). They assert what the code does today so future refactors know what they're breaking. If the behavior should change, change the scenario at the same time as the code — never silently.
