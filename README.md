# codex-bridge

claude-code skill that hands coding work off to openai codex and tails it back through the monitor tool. claude stays in orchestration; codex does the heavy lift. the bridge is a single bundled node cli that speaks json-rpc to the codex app-server, writes append-only event + ndjson logs, and returns a uniform json envelope agents can switch on.

<p align="center">
  <a href="https://github.com/yigitkonur/codex-bridge/actions/workflows/build.yml"><img alt="build" src="https://github.com/yigitkonur/codex-bridge/actions/workflows/build.yml/badge.svg"></a>
  <a href="https://github.com/yigitkonur/codex-bridge/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/yigitkonur/codex-bridge?sort=semver"></a>
  <a href="#license"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522-brightgreen">
</p>

## what you get

- **delegate → monitor loop** — claude fires `task`, tails the events stream, and acts on `[PLAN]` / `[QUESTION]` / `[DONE]` / `[ERROR]` / `[INCOMPLETE]` tags. zero custom glue code.
- **uniform json envelope** — every `--json` call returns `{ok, schema_version, command, result, meta}` on success and `{ok:false, error:{class, code, retryable, suggestion}}` on failure. `error.class` maps 1:1 to exit code. agents branch on `$?` before parsing.
- **ready-to-paste monitor hint** — every `task` launch payload includes `result.monitor.tool_hint` shaped exactly for claude code's monitor tool (`{description, command, timeout_ms, persistent}`).
- **first-class blocking + streaming** — `wait <id>` blocks on the next terminal tag; `events <id> --follow --filter DONE,ERROR,PLAN,QUESTION` streams with prefix-aware filters. steers agents away from ad-hoc `tail -f`.
- **auto-pipeline** — optional silent review + completion check after every execute turn. findings feed a fix turn; completion check renders to `[DONE]` or `[INCOMPLETE]` with structured missing-items.
- **interactive question flow** — codex can ask via `requestUserInput`; the bridge emits `[QUESTION]` with a prebuilt `respond …` command carrying the exact request-id.
- **plan-mode guardrails** — first turn defaults to `readonly` sandbox; `task --mode default` bypasses the plan turn when you want execution directly. config.yaml is the session-wide default.
- **append-only session artifacts** — per-thread `.events` (monitor), `.ndjson` (jq), `.diff` (git diff), `.plan.md` (when codex produces a structured plan). ndjson records turn params, item completions, questions, steers, errors, pipeline stages.
- **typed error taxonomy** — codex's `codexErrorInfo` mapped to stable `error.code` values: `INVALID_THREAD_ID`, `REVIEW_EMPTY_DIFF`, `WAIT_TIMEOUT`, `UNKNOWN_SUBCOMMAND`, `CONTEXT_WINDOW_EXCEEDED`, and the rest.
- **structured review output** — `adversarial-review` returns findings conforming to a shipped json schema; pair with `review` for codex's native pass.
- **mid-turn steering + resume** — `steer <tid> <turn-id> "…"` sends guidance to a live turn; `task --resume-last` picks up the session's latest resumable thread.
- **no telemetry. no sidecar manifest.** everything lives in `SKILL.md` frontmatter + the single bundled cli.

## requirements

- node.js ≥ 22
- codex cli on `$PATH`, authenticated: `npm i -g @openai/codex && codex login`
- macos or linux (broker uses unix sockets)

## install as a claude code skill

three flavors, pick whichever matches how you run claude.

### 1. user scope (recommended) — download the release bundle

```bash
# pick your skills scope — .claude is the anthropic-native path,
# .agents is the cross-client convention (vs code uses it by default).
SKILLS=~/.claude/skills                # or ~/.agents/skills
VERSION=v1.0.0                         # check github releases for the latest

mkdir -p "$SKILLS"
curl -fsSL "https://github.com/yigitkonur/codex-bridge/releases/download/${VERSION}/codex-bridge-${VERSION}.tar.gz" \
  | tar -xz -C "$SKILLS"

# sanity-check the install
node "$SKILLS/codex-bridge/scripts/codex-bridge.mjs" setup --json | jq .result.ready
```

the tarball already has the correct layout — you extract and you're done. every release also ships a matching `.zip` + `SHA256SUMS` if you prefer.

### 2. project scope — clone + symlink

```bash
git clone https://github.com/yigitkonur/codex-bridge
cd codex-bridge
npm ci && npm run build

# inside the project you want the skill available to:
mkdir -p .claude/skills
ln -s "$(pwd)/skill" .claude/skills/codex-bridge
```

project scope wins over user scope on collision, per the agentskills.io spec.

### 3. hack on it locally

```bash
git clone https://github.com/yigitkonur/codex-bridge
cd codex-bridge
npm ci
npm run build                # rebundles skill/scripts/codex-bridge.mjs
node skill/scripts/codex-bridge.mjs setup --json
```

edit `src/`, re-`npm run build`, verify against the cli. never hand-edit `skill/scripts/*` — it's a build output and the next build overwrites it.

## how the skill shows up

once installed, claude code picks up the skill via its `SKILL.md` frontmatter (`name: codex-bridge`). the description field lists every trigger claude should route to this skill — "ask codex", "run this by codex", "adversarial review", background codex jobs, tailing terminal events, etc. claude activates it automatically; you don't invoke it by name.

full user-facing docs live at [`skill/SKILL.md`](skill/SKILL.md). topical references:

| file | read when |
|---|---|
| [command-reference.md](skill/references/command-reference.md) | every subcommand, flag, exit code, envelope shape |
| [monitor-patterns.md](skill/references/monitor-patterns.md) | monitor presets, `events --follow` vs `wait` vs raw `tail -f` |
| [notification-format.md](skill/references/notification-format.md) | exact `[DONE]` / `[ERROR]` / `[PLAN]` / `[QUESTION]` / `[PIPELINE:*]` shapes |
| [ndjson-guide.md](skill/references/ndjson-guide.md) | ndjson writer vocab + jq recipes |
| [orchestration-flows.md](skill/references/orchestration-flows.md) | end-to-end flow diagrams |
| [error-recovery.md](skill/references/error-recovery.md) | `codexErrorInfo` → exit code, recovery strategies |
| [config-reference.md](skill/references/config-reference.md) | yaml keys, defaults, precedence |
| [prompt-writing.md](skill/references/prompt-writing.md) | writing prompts codex will actually execute well |

## quick usage

```bash
# sync, self-sufficient — envelope carries phase + next_action
node "$SKILLS/codex-bridge/scripts/codex-bridge.mjs" task --json \
  "fix the auth bug in src/auth.ts" \
  | jq '.result.phase, .result.next_action.command'

# async launch + tail via the built-in events subcommand
LAUNCH=$(node "$SKILLS/codex-bridge/scripts/codex-bridge.mjs" task --background --write --json \
  "add a cancel button to the todo list")
JOB=$(echo "$LAUNCH" | jq -r .result.jobId)

# paste this straight into the monitor tool — it's pre-built in the payload
echo "$LAUNCH" | jq -r .result.monitor.command

# or block
node "$SKILLS/codex-bridge/scripts/codex-bridge.mjs" wait "$JOB" --timeout-ms 600000 --json
```

## repo layout

```
src/                             authored source (esm, node 22+)
├── codex-bridge.mjs             cli entry + per-subcommand handlers
├── app-server-broker.mjs        standalone json-rpc multiplexer
├── lib/                         app-server client, turn capture, session log, auto-pipeline, …
├── prompts/                     adversarial-review prompt (copied into skill/)
├── schemas/                     review-output.schema.json (copied into skill/)
└── templates/                   execute-instructions.md, plan-enforcement.md (copied into skill/)

skill/                           the skill bundle (what gets shipped)
├── SKILL.md                     user-facing skill doc + frontmatter (hand-edited)
├── config.yaml                  default config (hand-edited)
├── references/                  hand-edited reference docs
├── scripts/codex-bridge.mjs     ← bundle output (gitignored)
├── app-server-broker.mjs        ← bundle output (gitignored)
├── prompts/ schemas/ templates/ ← copied from src/ (gitignored)

.github/workflows/               ci: build.yml (on pr/push), release.yml (on tag)
test-gherkin/*.feature           behavioral specs (not runnable — contract docs)
derailment-logbook/              round-by-round skill-quality observations
docs/superpowers/plans/          implementation plans
```

## ci / release

- every push to `main` and every pr builds the bundle on node 22 and runs static sanity checks (`help --json` parses, unknown-subcommand returns the right envelope, invalid thread-id is rejected). see [`.github/workflows/build.yml`](.github/workflows/build.yml).
- pushing a `vX.Y.Z` tag builds the bundle, stages it under a `codex-bridge/` directory (per agentskills.io spec — install dir name must match the `name` frontmatter), packages `.tar.gz` + `.zip` + `SHA256SUMS`, and attaches everything to the github release. see [`.github/workflows/release.yml`](.github/workflows/release.yml).

users never need to run `npm run build` unless they're hacking on the source.

## spec conformance

the skill targets the [agentskills.io spec](https://agentskills.io/specification). audit status:

- `SKILL.md` frontmatter: `name`, `description`, `compatibility`, `license`, `allowed-tools`, `metadata` — all in spec; description imperative, under 1024 chars, trigger-keyword-dense per the optimizing-descriptions guide.
- body: under 500 lines, reference files one level deep, cross-linked from SKILL.md.
- scripts: shipped as a single `node` entry under `scripts/` inside the skill; non-interactive, `--help` on every subcommand, meaningful exit codes (0/1/2/3/4/5/6/7/8), stdout for data, stderr for progress.
- discovery: installed at `~/.claude/skills/codex-bridge/` or `~/.agents/skills/codex-bridge/` — both scopes supported by clients per the spec.
- no sidecar manifest. all metadata lives in frontmatter.

## contributing

read [`AGENTS.md`](AGENTS.md) (symlinked as `CLAUDE.md`) before touching source. per-folder `AGENTS.md` files scope the conventions: `src/lib/AGENTS.md` locks in protocol invariants against the codex app-server spec; `skill/AGENTS.md` says which files under `skill/` are authored vs generated; `test-gherkin/AGENTS.md` is the contract for behavioral specs.

## license

MIT © yigit konur
