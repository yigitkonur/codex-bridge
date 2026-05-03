# Technology Stack

**Project:** codex-bridge
**Researched:** 2026-04-30
**Evidence policy:** Current non-Markdown repository files only. Repository Markdown was not used as evidence.
**Overall confidence:** HIGH

## Executive Recommendation

Treat `codex-bridge` as a Node 22+ ESM command package whose shipped behavior is the committed bundle, not only `src/`. Future phases should preserve the dual output model until a deliberate migration removes the legacy skill layout: source changes in `src/`, `commands/`, `agents/`, `hooks/`, `src/prompts/`, `src/schemas/`, `src/templates/`, or `skill/config.yaml` must be followed by `npm run build` and a generated-output review.

Use the existing stack as-is: Node built-ins for process, fs, net, crypto, fetch, and `node:test`; `esbuild` for bundling; `js-yaml` for config. Do not add a framework, TypeScript build step, or runtime dependency unless a phase proves that plain ESM modules cannot support the feature. The current package is intentionally small and CLI-oriented.

## Active Stack

| Area | Recommendation | Confidence | Evidence |
|---|---|---:|---|
| Runtime | Keep Node.js `>=22.0.0` and ESM-only modules. | HIGH | `package.json:5`, `package.json:13-15` |
| Package version | Keep package, root plugin metadata, packaged plugin metadata, and skill metadata aligned unless intentionally version-stamping a migration. | HIGH | `package.json:2-4`, `.claude-plugin/plugin.json:3-7`, `plugin/.claude-plugin/plugin.json:3-7`, `src/codex-bridge.mjs:15`, `src/codex-bridge.mjs:1102-1116` |
| Build | Keep `npm run build` as the only bundle generator. | HIGH | `package.json:6-9`, `esbuild.config.mjs:77-125` |
| Tests | Keep `npm test` on Node's built-in runner; add focused `.test.mjs` files for observable contracts. | HIGH | `package.json:6-10`, `.github/workflows/build.yml:35-37`, `test/bridge-static.test.mjs:14-23` |
| Bundler | Keep `esbuild`; lockfile currently resolves it to `0.24.2`. | HIGH | `package.json:16-18`, `package-lock.json:451-452` |
| YAML parser | Keep `js-yaml`; lockfile currently resolves it to `4.1.1`. | HIGH | `package.json:16-18`, `package-lock.json:492-493`, `src/lib/config.mjs:1-5` |
| Runtime dependencies | Avoid adding production dependencies; current runtime uses Node built-ins plus bundled source. | HIGH | `package.json:16-19`, `src/adapters/codex/protocol.mjs:339-455`, `src/lib/process.mjs:19-31` |

## Package And Commands

The authoritative commands are the package scripts:

```bash
npm run build
npm test
npm run dev
node src/codex-bridge.mjs --help
node src/codex-bridge.mjs setup --json
```

`npm run dev` invokes source mode through `node src/codex-bridge.mjs`; published and plugin installs run bundled copies. `src/codex-bridge.mjs` reads version from `package.json`, then exposes command metadata and handlers for task, review, adversarial review, background job control, events, setup, version, update, config, and verdict flows. Evidence: `package.json:6-10`, `src/codex-bridge.mjs:244-253`, `src/codex-bridge.mjs:547-711`, `src/codex-bridge.mjs:1102-1167`.

## Generated Artifact Model

Source files are bundled into two layouts:

| Source | Generated outputs | Recommendation | Confidence |
|---|---|---|---:|
| `src/codex-bridge.mjs` | `skill/scripts/codex-bridge.mjs`, `plugin/scripts/codex-bridge.mjs` | Never edit generated CLI bundles by hand. | HIGH |
| `src/adapters/codex/broker.mjs` | `skill/app-server-broker.mjs`, `plugin/scripts/app-server-broker.mjs` | Preserve broker path probing across source, skill, and plugin layouts. | HIGH |
| `src/prompts`, `src/schemas`, `src/templates` | `skill/*` and `plugin/*` asset copies | Add new static assets to `esbuild.config.mjs`, then build. | HIGH |
| `commands`, `agents`, `hooks` | `plugin/commands`, `plugin/agents`, `plugin/hooks` | Author at root, generate plugin copies. Do not hand-patch plugin copies. | HIGH |
| `skill/config.yaml` | `plugin/config.yaml` | Treat `skill/config.yaml` as the copied source for plugin config. | HIGH |

Evidence: `esbuild.config.mjs:21-45`, `esbuild.config.mjs:77-123`, `.github/workflows/build.yml:39-51`, `.github/workflows/build.yml:53-88`.

CI enforces this model by running `npm ci`, `npm run build`, `npm test`, checking generated paths for drift, and probing both skill and plugin bundle entry points. Evidence: `.github/workflows/build.yml:24-37`, `.github/workflows/build.yml:39-88`, `.github/workflows/build.yml:96-151`.

## Runtime Architecture

Preserve these component boundaries:

| Component | Role | Evidence | Confidence |
|---|---|---|---:|
| CLI dispatcher | Parses subcommands, config, cwd/workspace roots, task/review orchestration, update/setup/status flows. | `src/codex-bridge.mjs:17-148`, `src/codex-bridge.mjs:547-711` | HIGH |
| Adapter registry | Selects backend; this build only loads `codex`. | `src/adapters/index.mjs:18-28`, `src/adapters/index.mjs:92-155` | HIGH |
| Codex protocol client | Talks to `codex app-server` over newline-delimited JSON messages and can use direct or broker transport. | `src/adapters/codex/protocol.mjs:19-30`, `src/adapters/codex/protocol.mjs:161-220`, `src/adapters/codex/protocol.mjs:339-455`, `src/adapters/codex/protocol.mjs:530-560` | HIGH |
| Broker lifecycle | Spawns and reuses a detached broker, writes broker session state, and tears down stale sessions. | `src/lib/broker-lifecycle.mjs:60-71`, `src/lib/broker-lifecycle.mjs:149-169`, `src/lib/broker-lifecycle.mjs:171-229` | HIGH |
| Job/state store | Stores workspace-scoped state under plugin data or temp fallback, locks writes, caps terminal history. | `src/lib/state.mjs:16-25`, `src/lib/state.mjs:41-56`, `src/lib/state.mjs:79-130`, `src/lib/state.mjs:234-280` | HIGH |
| Session logs | Writes `.events`, `.ndjson`, `.diff`, plan, and review artifacts synchronously and best-effort. | `src/lib/session-log.mjs:8-20`, `src/lib/session-log.mjs:32-83`, `src/lib/session-log.mjs:150-163` | HIGH |
| Git review context | Resolves repo roots, default branch, working tree state, review targets, and untracked-file handling through Git. | `src/lib/git.mjs:18-24`, `src/lib/git.mjs:84-104`, `src/lib/git.mjs:110-224` | HIGH |
| Claude hooks | Session hooks export bridge data and prune orphans; Stop hook can run a review-gate job when lock-enabled. | `hooks/hooks.json:1-37`, `hooks/session-lifecycle-hook.mjs:41-54`, `hooks/stop-gate.mjs:49-78`, `hooks/stop-gate.mjs:145-153` | HIGH |

## Config Format And Defaults

Use YAML files with a top-level `codex_bridge` object. The parser accepts either `codex_bridge` or a flat object, but new docs and examples should use `codex_bridge` to match the shipped config files. Evidence: `src/lib/config.mjs:17-26`, `skill/config.yaml:1-8`, `plugin/config.yaml:1-8`.

Config precedence is:

1. Built-in `DEFAULT_CONFIG`
2. install-root `config.yaml`
3. workspace-root `config.yaml`
4. cwd `config.yaml`

Evidence: `src/lib/config.mjs:28-39`, `src/lib/config.mjs:41-56`, `src/lib/config.mjs:74-97`, `src/codex-bridge.mjs:1170-1243`.

Shipped defaults to preserve unless a phase explicitly changes product behavior:

| Key | Active value | Evidence | Confidence |
|---|---|---|---:|
| `mode` | `plan` | `src/lib/runtime-options.mjs:1-3`, `skill/config.yaml:1-8` | HIGH |
| `model` | `gpt-5.4` built-in; shipped config leaves it commented so Codex config can inherit if desired. | `src/lib/runtime-options.mjs:1-3`, `skill/config.yaml:10-11` | HIGH |
| `effort` | `xhigh`; plan mode forces `xhigh`. | `src/lib/runtime-options.mjs:4-14`, `src/lib/runtime-options.mjs:101-116`, `skill/config.yaml:21-27` | HIGH |
| `auto_review` | `true` | `src/lib/runtime-options.mjs:14-16`, `skill/config.yaml:28-30` | HIGH |
| `allow_questions` | `true`; questions are routed through persisted request files and `.events` output. | `src/lib/runtime-options.mjs:23-24`, `src/codex-bridge.mjs:353-409` | HIGH |
| `skip_meta_skills` | `true` | `src/lib/runtime-options.mjs:31-40`, `skill/config.yaml:44-53` | HIGH |
| `sandbox_policy` | `danger-full-access` | `src/lib/runtime-options.mjs:25-30`, `src/lib/runtime-options.mjs:118-148`, `skill/config.yaml:62-77` | HIGH |
| `session_dir` | `~/.codex-bridge/sessions` | `src/lib/runtime-options.mjs:23-25`, `src/lib/session-log.mjs:8-11` | HIGH |
| timeout budgets | idle 300s, turn 30m, pipeline 15m total, pipeline stage 5m, question 5m | `src/lib/runtime-options.mjs:51-89`, `src/adapters/codex/pipeline.mjs:18-25` | HIGH |

## External Command Dependencies

| Command or service | Used for | Recommendation | Evidence | Confidence |
|---|---|---|---|---:|
| `node` | Running source, bundles, hooks, tests, broker worker processes. | Require Node 22 in CI and local setup. | `package.json:13-15`, `.github/workflows/build.yml:24-27`, `hooks/hooks.json:8-10` | HIGH |
| `npm` | `npm ci`, scripts, package install cache. | Keep npm scripts minimal and authoritative. | `.github/workflows/build.yml:24-36`, `package.json:6-10` | HIGH |
| `npx` | Manual and automatic skill update install path. | Treat installer calls as update behavior, not core runtime. | `src/codex-bridge.mjs:217-224`, `src/codex-bridge.mjs:1264-1344` | HIGH |
| `codex` | App-server runtime and health checks. | Runtime behavior requires an authenticated Codex CLI with `app-server`. | `src/adapters/codex/protocol.mjs:345-386`, `src/adapters/codex/codex.mjs:1053-1059`, `src/codex-bridge.mjs:1002-1045` | HIGH |
| `git` | Repo detection, review target selection, diff capture, state workspace scoping. | Do not weaken Git checks for review/merge flows; handle non-repo contexts only where code already does. | `src/lib/git.mjs:84-104`, `src/lib/git.mjs:150-224`, `src/lib/workspace.mjs:3-8` | HIGH |
| `claude` | Detection of the official OpenAI Codex plugin to avoid duplicate Stop review gates. | Keep detection best-effort and cached; do not make setup unusable if status is unknown. | `src/lib/official-plugin.mjs:91-129`, `src/codex-bridge.mjs:1008-1042`, `src/codex-bridge.mjs:1065-1081` | HIGH |
| GitHub releases API | Update checks through Node fetch, anonymous, cached. | Keep update checks non-fatal and cache-backed. | `src/lib/update-check.mjs:25-35`, `src/lib/update-check.mjs:228-253`, `src/codex-bridge.mjs:150-191` | HIGH |

## What Not To Change Casually

| Invariant | Why it matters | Evidence | Confidence |
|---|---|---|---:|
| App-server outbound requests are newline-delimited JSON objects sent via stdin/socket, with `id`, `method`, and `params`. | Protocol changes can break Codex CLI communication and broker routing. | `src/adapters/codex/protocol.mjs:161-220`, `src/adapters/codex/protocol.mjs:440-454`, `src/adapters/codex/protocol.mjs:513-527` | HIGH |
| `DEFAULT_CLIENT_INFO.name` is `codex_bridge`. | The app-server client identity is stable and tested by protocol behavior. | `src/adapters/codex/protocol.mjs:25-30` | HIGH |
| Plan mode forces `xhigh` reasoning. | Config `effort` does not control plan mode; changing this alters product behavior. | `src/lib/runtime-options.mjs:101-116` | HIGH |
| Adapter registry ships only the Codex backend. | Config may name future backends, but this build rejects unknown values. | `src/adapters/index.mjs:18-28`, `src/adapters/index.mjs:92-155` | HIGH |
| State root precedence is `CODEX_BRIDGE_PLUGIN_DATA`, then `CLAUDE_PLUGIN_DATA`, then temp fallback. | Changing this can strand job/session state across plugin sessions. | `src/lib/state.mjs:16-25`, `src/lib/state.mjs:41-56`, `test/state.test.mjs:163-189` | HIGH |
| Generated bundle freshness is a CI gate. | Any source change without regenerated artifacts fails CI. | `.github/workflows/build.yml:39-88` | HIGH |
| Stop review gate is lock-file controlled and suppressed when the official OpenAI Codex plugin is active or unknown. | Avoid duplicate review gates and stuck Stop hooks. | `src/codex-bridge.mjs:855-913`, `src/codex-bridge.mjs:1048-1099`, `hooks/stop-gate.mjs:145-153` | HIGH |
| Session log writes are best-effort synchronous appends. | Event consumers rely on simple tail-able files. | `src/lib/session-log.mjs:32-83` | HIGH |

## Phase Planning Guidance

1. **Runtime behavior phases:** Start from source files and add tests first. Include generated bundle diffs after `npm run build`. Run `npm test`; avoid claiming app-server behavior is proven unless a real Codex CLI round trip was executed.
2. **Plugin surface phases:** Edit root plugin metadata, root `commands`, root `agents`, or root `hooks`, then build. Validate plugin path rewrites and generated copies through CI-equivalent checks.
3. **Config phases:** Update `DEFAULT_CONFIG`, shipped YAML comments, merge/render behavior, and tests together. Preserve precedence unless the phase is explicitly about config semantics.
4. **Broker/protocol phases:** Treat broker lifecycle, JSON message framing, timeout behavior, and direct-vs-broker fallback as high-risk. Add tests around ordering, stale sessions, and transport cleanup.
5. **State/job phases:** Preserve workspace-root scoping, lock behavior, orphan pruning, terminal history caps, and background-worker persistence-before-spawn.
6. **Review pipeline phases:** Preserve the three-stage shape: diff capture, optional auto-review/fix, optional completion check. Stage and total timeouts must remain explicit.

## Verification Commands For Future Phases

```bash
npm run build
npm test
node src/codex-bridge.mjs setup --json
node src/codex-bridge.mjs version --json
```

For changes touching real app-server behavior, add a manual authenticated Codex CLI check because static tests only validate local contracts. Evidence: `src/codex-bridge.mjs:1002-1045`, `src/adapters/codex/protocol.mjs:345-386`, `.github/workflows/build.yml:96-151`.

## Research Gaps

- I did not use web research; dependency and tooling conclusions are from current package metadata, lockfile, workflows, source, hooks, and tests.
- I did not execute `npm run build` or `npm test` because this research task owns only `.planning/research/STACK.md`, and running the full suite can read repository Markdown test fixtures and/or touch generated paths.
- Plugin command Markdown content was intentionally not used as evidence. Command coverage was inferred from package/build metadata, manifests, source command metadata, workflows, and tests.
