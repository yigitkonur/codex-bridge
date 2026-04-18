# codex-bridge

A [Claude Code](https://code.claude.com/) skill that hands coding work off to **OpenAI Codex** and tails it back through the Monitor tool. Claude stays in orchestration; Codex does the heavy lift. The bridge is a single bundled Node.js CLI that speaks JSON-RPC to the Codex app-server, writes append-only event + ndjson logs, and returns a uniform JSON envelope agents can switch on.

<p align="center">
  <a href="https://github.com/yigitkonur/codex-bridge/actions/workflows/build.yml"><img alt="build" src="https://github.com/yigitkonur/codex-bridge/actions/workflows/build.yml/badge.svg"></a>
  <a href="https://github.com/yigitkonur/codex-bridge/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/yigitkonur/codex-bridge?sort=semver"></a>
  <a href="#license"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522-brightgreen">
</p>

---

## tl;dr — install on a new machine in 3 commands

```bash
# 1. install Codex and sign in (opens a browser)
npm i -g @openai/codex && codex login

# 2. install the skill into Claude Code (user-scope, works for every project)
npx -y skills add yigitkonur/codex-bridge -a claude-code -g -y

# 3. verify the install
node ~/.claude/skills/codex-bridge/scripts/codex-bridge.mjs setup --json | jq .result.ready
```

If `setup` reports `true`, you're done. Fire up Claude Code in any repo and ask it to "run this by Codex" — the skill takes over from there.

If you don't have Node, `jq`, or `npm`, jump to the [guided bootstrap](#guided-bootstrap-zero-to-working) below.

---

## what you get

- **delegate → monitor loop** — Claude fires `task`, tails the events stream, and acts on `[PLAN]` / `[QUESTION]` / `[DONE]` / `[ERROR]` / `[INCOMPLETE]` tags. Zero custom glue code.
- **uniform JSON envelope** — every `--json` call returns `{ok, schema_version, command, result, meta}` on success and `{ok:false, error:{class, code, retryable, suggestion}}` on failure. `error.class` maps 1:1 to exit code. Agents branch on `$?` before parsing.
- **ready-to-paste monitor hint** — every `task` launch payload includes `result.monitor.tool_hint` shaped exactly for Claude Code's Monitor tool (`{description, command, timeout_ms, persistent}`).
- **first-class blocking + streaming** — `wait <id>` blocks on the next terminal tag; `events <id> --follow --filter DONE,ERROR,PLAN,QUESTION` streams with prefix-aware filters.
- **auto-pipeline** — optional silent review + completion check after every execute turn. Findings feed a fix turn; completion check renders to `[DONE]` or `[INCOMPLETE]` with structured missing-items.
- **interactive question flow** — Codex can ask via `requestUserInput`; the bridge emits `[QUESTION]` with a prebuilt `respond …` command carrying the exact request-id.
- **plan-mode guardrails** — first turn defaults to `readonly` sandbox; `task --mode default` bypasses the plan turn when you want execution directly. `config.yaml` is the session-wide default.
- **append-only session artifacts** — per-thread `.events` (Monitor), `.ndjson` (jq), `.diff` (git diff), `.plan.md`, `.review.json`. ndjson records turn params, item completions, questions, steers, errors, pipeline stages.
- **typed error taxonomy** — Codex's `codexErrorInfo` mapped to stable `error.code` values: `INVALID_THREAD_ID`, `REVIEW_EMPTY_DIFF`, `WAIT_TIMEOUT`, `UNKNOWN_SUBCOMMAND`, `CONTEXT_WINDOW_EXCEEDED`, and the rest.
- **structured review output** — `adversarial-review` returns findings conforming to a shipped JSON schema; pair with `review` for Codex's native pass.
- **mid-turn steering + resume** — `steer <tid> <turn-id> "…"` sends guidance to a live turn; `task --resume-last` picks up the session's latest resumable thread.
- **no telemetry. no sidecar manifest.** Everything lives in `SKILL.md` frontmatter + the single bundled CLI.

---

## guided bootstrap (zero to working)

Safe to run on a clean macOS or Linux machine. Each step has a one-line verification.

### 1. Install Node.js 22 or newer

**macOS (Homebrew):**
```bash
brew install node@22 && brew link --overwrite --force node@22
```

**Linux / macOS (nvm, recommended if you juggle Node versions):**
```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# restart your shell, then:
nvm install 22 && nvm use 22 && nvm alias default 22
```

**Verify:**
```bash
node --version   # expect v22.x.x or newer
npm --version
```

### 2. Install the Codex CLI and sign in

```bash
npm i -g @openai/codex
codex login      # opens your browser — sign in with your OpenAI account
```

**Verify:**
```bash
codex --version
codex auth status   # expect: logged in
```

### 3. Install `codex-bridge` as a Claude Code skill

```bash
npx -y skills add yigitkonur/codex-bridge -a claude-code -g -y
```

What the flags mean:
- `-a claude-code` → target Claude Code specifically (skips the interactive "which agent?" prompt).
- `-g` → global install to `~/.claude/skills/codex-bridge/` (available in every project). Drop this flag to install into `./.claude/skills/` in the current project instead.
- `-y` → skip confirmation prompts.

**Verify:**
```bash
node ~/.claude/skills/codex-bridge/scripts/codex-bridge.mjs setup --json \
  | jq '.result | {ready, node, codex, auth}'
```

You should see `ready: true` and non-null strings for `node`, `codex`, `auth`. If any field is missing, `setup` tells you what to fix — no guessing.

### 4. Use it from Claude Code

Open any repo in Claude Code and try:

> "Have Codex add a dark-mode toggle to the settings page and review it before you hand it back."

Claude auto-activates the skill (no `@` mention needed — the SKILL.md description lists the trigger keywords: "ask Codex", "run this by Codex", "adversarial review", etc.). You'll see the task launch, `[PLAN]` come back for approval, then `[DONE]` or `[QUESTION]` events stream via the Monitor tool.

---

## other install paths

Pick whichever matches your workflow. The `skills` CLI path above is the easiest; these are for people who want something specific.

### alternate agents (Cursor, Codex-as-client, OpenCode, etc.)

The [`skills` CLI](https://skills.sh/docs/cli) supports 40+ agents — swap the `-a` target:

```bash
npx -y skills add yigitkonur/codex-bridge -a cursor  -g -y
npx -y skills add yigitkonur/codex-bridge -a codex   -g -y
npx -y skills add yigitkonur/codex-bridge -a opencode -g -y
```

### release tarball (air-gapped / CI / no npx)

```bash
SKILLS=~/.claude/skills
VERSION=v1.0.0
mkdir -p "$SKILLS"
curl -fsSL "https://github.com/yigitkonur/codex-bridge/releases/download/${VERSION}/codex-bridge-${VERSION}.tar.gz" \
  | tar -xz -C "$SKILLS"
```

Each release ships `.tar.gz`, `.zip`, and `SHA256SUMS`.

### clone and hack on it

```bash
git clone https://github.com/yigitkonur/codex-bridge
cd codex-bridge
npm ci
npm run build
ln -s "$(pwd)/skill" ~/.claude/skills/codex-bridge   # or use a project-scope symlink
```

Edit `src/`, re-run `npm run build`, commit the regenerated bundle alongside your source changes (CI enforces this — see [contributing](#contributing)).

---

## how the skill shows up in Claude Code

Once installed, Claude Code reads `skill/SKILL.md` front matter (`name: codex-bridge`). The description field lists every trigger Claude should route to this skill — "ask Codex", "run this by Codex", "adversarial review", background Codex jobs, tailing terminal events, etc. Claude activates it automatically; you don't invoke it by name.

Full user-facing docs live at [`skill/SKILL.md`](skill/SKILL.md). Topical references:

| file | read when |
|---|---|
| [command-reference.md](skill/references/command-reference.md) | every subcommand, flag, exit code, envelope shape |
| [monitor-patterns.md](skill/references/monitor-patterns.md) | monitor presets, `events --follow` vs `wait` vs raw `tail -f` |
| [notification-format.md](skill/references/notification-format.md) | exact `[DONE]` / `[ERROR]` / `[PLAN]` / `[QUESTION]` / `[PIPELINE:*]` shapes |
| [ndjson-guide.md](skill/references/ndjson-guide.md) | ndjson writer vocab + jq recipes |
| [orchestration-flows.md](skill/references/orchestration-flows.md) | end-to-end flow diagrams |
| [error-recovery.md](skill/references/error-recovery.md) | `codexErrorInfo` → exit code, recovery strategies |
| [config-reference.md](skill/references/config-reference.md) | yaml keys, defaults, precedence |
| [prompt-writing.md](skill/references/prompt-writing.md) | writing prompts Codex will actually execute well |

---

## quick usage from the shell

```bash
SKILL=~/.claude/skills/codex-bridge
BRIDGE="node $SKILL/scripts/codex-bridge.mjs"

# sync, self-sufficient — envelope carries phase + next_action
$BRIDGE task --json "fix the auth bug in src/auth.ts" \
  | jq '.result.phase, .result.next_action.command'

# async launch + tail via the built-in events subcommand
LAUNCH=$($BRIDGE task --background --write --json "add a cancel button to the todo list")
JOB=$(echo "$LAUNCH" | jq -r .result.jobId)

# paste this straight into the Monitor tool — it's pre-built in the payload
echo "$LAUNCH" | jq -r .result.monitor.command

# or block
$BRIDGE wait "$JOB" --timeout-ms 600000 --json
```

---

## troubleshooting

| symptom | fix |
|---|---|
| `setup --json` shows `codex: null` | `npm i -g @openai/codex` — the global Codex CLI isn't on `$PATH`. |
| `setup --json` shows `auth: null` | `codex login` — sign in via the browser flow. |
| `node --version` below 22 | Upgrade Node (see [step 1](#1-install-nodejs-22-or-newer)). |
| `npx skills add` errors with "no skills found" | You're on an old cached `skills` CLI — re-run with `npx -y skills@latest add …`. |
| Claude Code doesn't auto-activate the skill | Open `~/.claude/skills/codex-bridge/SKILL.md` and confirm the front-matter parses (valid YAML, `name: codex-bridge`). If you edited it, revert to the shipped version. |
| Skill installed to the wrong agent | `npx skills remove codex-bridge -a <wrong-agent> -g`, then re-run the add command with `-a claude-code`. |
| Permission denied writing to `~/.claude/skills/` | Use project scope instead: drop `-g` and run from inside your project directory. |
| `ERROR_CODE: CONTEXT_WINDOW_EXCEEDED` mid-task | Break the task into smaller prompts or increase the Codex reasoning budget via `config.yaml` (`effort: medium` trades depth for headroom). |

For anything else, check [`skill/references/error-recovery.md`](skill/references/error-recovery.md) — it maps every Codex error variant to a recovery strategy.

---

## repo layout

```
codex-bridge/
├── .claude-plugin/plugin.json      manifest: declares ./skill for skills.sh + Claude plugin discovery
├── src/                            authored source (ESM, Node 22+)
│   ├── codex-bridge.mjs            CLI entry + per-subcommand handlers
│   ├── app-server-broker.mjs       standalone JSON-RPC multiplexer
│   ├── lib/                        app-server client, turn capture, session log, auto-pipeline, …
│   ├── prompts/                    adversarial-review prompt (copied into skill/)
│   ├── schemas/                    review-output.schema.json (copied into skill/)
│   └── templates/                  execute-instructions.md, plan-enforcement.md (copied into skill/)
│
├── skill/                          the shipped skill bundle (what `npx skills add` fetches)
│   ├── SKILL.md                    user-facing skill doc + front matter (hand-edited)
│   ├── config.yaml                 default config (hand-edited)
│   ├── references/                 hand-edited reference docs
│   ├── scripts/codex-bridge.mjs    ← committed build output (CI enforces freshness)
│   ├── app-server-broker.mjs       ← committed build output
│   └── prompts/ schemas/ templates/  ← committed build outputs
│
├── .github/workflows/              ci: build.yml (drift check on pr/push), release.yml (on tag)
├── gherkin-tests-v2/**/*.md        behavioral specs (contract docs — not runnable)
├── unexpected-bridge-observations/ session-anchored skill-quality notes
└── docs/superpowers/plans/         implementation plans
```

---

## ci / release

- Every push to `main` and every PR runs the bundle + a **drift check**: CI rebuilds from source and fails if `skill/scripts/*`, `skill/app-server-broker.mjs`, `skill/prompts/*`, `skill/schemas/*`, or `skill/templates/*` don't match. Contributors must `npm run build` and commit the diff. See [`.github/workflows/build.yml`](.github/workflows/build.yml).
- Pushing a `vX.Y.Z` tag stages the skill under a `codex-bridge/` directory (per [agentskills.io](https://agentskills.io/specification) — install-dir name must match the `name` frontmatter), packages `.tar.gz` + `.zip` + `SHA256SUMS`, and attaches everything to the GitHub release. See [`.github/workflows/release.yml`](.github/workflows/release.yml).

Users never need to run `npm run build` unless they're hacking on the source.

---

## spec conformance

Targets the [agentskills.io spec](https://agentskills.io/specification) and the [skills.sh / vercel-labs skills](https://skills.sh) CLI contract.

- `SKILL.md` front matter: `name`, `description`, `compatibility`, `license`, `allowed-tools`, `metadata` — all in spec; description imperative, under 1024 chars, trigger-keyword-dense per the optimizing-descriptions guide.
- Body: under 500 lines, reference files one level deep, cross-linked from `SKILL.md`.
- Script: shipped as a single `node` entry under `scripts/` inside the skill; non-interactive, `--help` on every subcommand, meaningful exit codes (0/1/2/3/4/5/6/7/8), stdout for data, stderr for progress.
- Discovery: installable at `~/.claude/skills/codex-bridge/` (Claude Code) or any of the 40+ other targets the `skills` CLI supports.
- Plugin manifest (`.claude-plugin/plugin.json`) declares `./skill` so skills.sh discovers the bundle from the repo root.
- No sidecar manifest beyond that. All skill metadata lives in `SKILL.md` front matter.

---

## contributing

Read [`AGENTS.md`](AGENTS.md) (symlinked as `CLAUDE.md`) before touching source. Per-folder `AGENTS.md` files scope the conventions: `src/lib/AGENTS.md` locks in protocol invariants against the Codex app-server spec; `skill/AGENTS.md` says which files under `skill/` are authored vs generated; `gherkin-tests-v2/AGENTS.md` is the contract for behavioral specs (including the canonical `bridge()` shell-function rule that all specs must follow).

**One rule worth repeating:** after any change under `src/`, run `npm run build` and commit the regenerated bundle (`skill/scripts/*`, `skill/app-server-broker.mjs`, `skill/prompts/*`, `skill/schemas/*`, `skill/templates/*`) in the same commit. CI's drift check will reject PRs with stale bundles.

---

## license

MIT © Yigit Konur
