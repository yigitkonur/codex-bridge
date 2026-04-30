---
last_mapped_commit: 16f4fd188f47160bdaddabb9813c6fe67e486d5d
mapped_date: 2026-04-30
evidence_policy: source-tests-package-ci-only
---

# Testing Patterns

**Analysis Date:** 2026-04-30

## Evidence Boundary

Use `package.json`, `.github/workflows/build.yml`, `.github/workflows/release.yml`, source files, and `test/*.test.mjs` as testing evidence. Repository Markdown files are not used as evidence for this mapping.

## Test Framework

**Runner:**
- Node built-in test runner through `node --test test/*.test.mjs`.
- Config: `package.json` script `test`.
- Runtime requirement: Node.js `>=22.0.0` from `package.json`.

**Assertion Library:**
- `node:assert/strict` is the standard assertion library across `test/*.test.mjs`.

**Run Commands:**
```bash
npm test                                      # Run all repository tests
npm run build                                # Rebuild bundled skill and plugin outputs
node --test test/cli-errors.test.mjs         # Run one focused suite
node src/codex-bridge.mjs help --json        # Probe local CLI JSON output
node src/codex-bridge.mjs setup --json       # Probe local runtime readiness
```

## Test File Organization

**Location:**
- Tests live under `test/` and use one `.test.mjs` file per behavior area.

**Naming:**
- Use behavior names in file names, such as `test/cli-errors.test.mjs`, `test/git-worktree.test.mjs`, `test/auto-pipeline-turn-watchdog.test.mjs`, and `test/plugin-surfaces.test.mjs`.

**Structure:**
```text
test/
├── adapter-*.test.mjs                 # Adapter registry, routing, and backend selection
├── app-server-*.test.mjs              # App-server protocol and abort behavior
├── codex-capture*.test.mjs            # Turn capture, timeout, and exit flushing
├── git*.test.mjs                      # Git context, worktree, merge, and prune behavior
├── state*.test.mjs                    # State locking, pruning, corruption, and cleanup
├── *hook*.test.mjs                    # Plugin hook behavior
└── plugin-surfaces.test.mjs           # Packaged plugin, commands, hooks, and generated surfaces
```

## Test Structure

**Suite Organization:**
```javascript
import test from 'node:test'
import assert from 'node:assert/strict'

test('behavior under test', async (t) => {
  // arrange temp state, fake clients, or subprocesses
  // act through exported helpers or CLI entry points
  assert.equal(actual, expected)
})
```

**Patterns:**
- Import `test` from `node:test` and assertions from `node:assert/strict`.
- Use async tests for subprocesses, fake protocol clients, and filesystem state.
- Use temporary directories from `node:os` and `node:fs` for state, registry, git, and hook tests.
- Restore mutated environment variables and process state in `t.after`, `try/finally`, or local cleanup helpers.
- Use `process.execPath` when spawning Node subprocesses from tests, as seen in CLI, hook, and plugin surface suites.

## Mocking

**Framework:** Node built-ins and local fakes. No external mocking framework is detected.

**Patterns:**
```javascript
class FakeClient {
  async startTurn(params) {
    return { threadId: params?.threadId ?? 'thread-id' }
  }
}
```

**What to Mock:**
- Mock Codex app-server clients for turn capture, timeouts, review output, and pipeline behavior in `test/codex-capture*.test.mjs` and `test/auto-pipeline-turn-watchdog.test.mjs`.
- Mock subprocess spawn behavior when testing process and broker lifecycle edges in `test/process.test.mjs` and `test/broker-lifecycle.test.mjs`.
- Mock environment variables for config, adapter routing, state root precedence, and hook behavior in `test/adapter-routing.test.mjs`, `test/state.test.mjs`, and hook suites.

**What NOT to Mock:**
- Do not mock git when validating repository and worktree behavior. Use real temporary repositories as in `test/git-worktree.test.mjs` and `test/git.test.mjs`.
- Do not replace JSON envelope parsing with static text assertions when command behavior can be executed through `node src/codex-bridge.mjs ...`.
- Do not rely only on static source checks for app-server round trips; use runtime probes against an authenticated Codex install for behavior that depends on the real Codex app-server.

## Fixtures And Factories

**Test Data:**
```javascript
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-test-'))
```

**Location:**
- Fixtures are mostly created inline in `test/*.test.mjs`.
- Temporary git repositories are created inside tests like `test/git-worktree.test.mjs`.
- Temporary config, registry, state, and hook files are created inside focused suites such as `test/registry.test.mjs`, `test/state.test.mjs`, and hook tests.

## Coverage

**Requirements:** No coverage threshold or coverage script is detected in `package.json`.

**View Coverage:**
```bash
# Not configured in package.json
```

## CI Gates

**Build Workflow:**
- `.github/workflows/build.yml` runs on push and pull requests to `main`.
- CI uses Node 22, `npm ci`, `npm run build`, and `npm test`.
- CI fails if generated outputs drift after a fresh build. The generated-path check covers `skill/scripts/codex-bridge.mjs`, `skill/app-server-broker.mjs`, `skill/prompts/`, `skill/schemas/`, `skill/templates/`, `plugin/scripts/`, `plugin/prompts/`, `plugin/schemas/`, `plugin/templates/`, `plugin/commands/`, `plugin/agents/`, `plugin/hooks/`, and `plugin/config.yaml`.
- CI probes bundled CLIs under both `skill/scripts/codex-bridge.mjs` and `plugin/scripts/codex-bridge.mjs`.
- CI sanity probes cover JSON help, JSON version, unknown subcommands, and invalid thread-id errors.

**Release Workflow:**
- `.github/workflows/release.yml` rebuilds from source with Node 22 before packaging.
- Release packaging stages the skill payload from `skill/` and generates archives and checksums.

## Test Types

**Unit Tests:**
- CLI error normalization and JSON envelopes: `test/cli-errors.test.mjs`, `test/events-json.test.mjs`.
- Argument parsing: `test/args.test.mjs`.
- Prompt/template/brief validation: `test/prompts-strict.test.mjs`, `test/adversarial-review-prompt.test.mjs`, `test/brief.test.mjs`.
- Structured review rendering and schema validation: `test/render-finding-validity.test.mjs`.
- Process wrapper behavior: `test/process.test.mjs`.

**Integration Tests:**
- Adapter routing and backend selection: `test/adapter-routing.test.mjs`, `test/adapter-selection.test.mjs`, `test/adapter-registry.test.mjs`.
- App-server protocol and capture behavior with fake transports: `test/app-server-client.test.mjs`, `test/app-server-abort.test.mjs`, `test/codex-capture.test.mjs`, `test/codex-capture-turn-timeout-fallback.test.mjs`, `test/codex-capture-on-exit-flush.test.mjs`.
- Auto-pipeline review/fix/check behavior: `test/auto-pipeline-turn-watchdog.test.mjs`.
- State, registry, and job control: `test/state.test.mjs`, `test/state-stale-lock-toctou.test.mjs`, `test/state-tmp-sweep-on-rename-failure.test.mjs`, `test/registry.test.mjs`, `test/job-control.test.mjs`.
- Git review context and worktree behavior: `test/git.test.mjs`, `test/git-worktree.test.mjs`.
- Plugin, hook, and generated bundle surfaces: `test/plugin-surfaces.test.mjs`, `test/pre-tool-bash-hook.test.mjs`, `test/pre-tool-agent-hook.test.mjs`, `test/official-plugin.test.mjs`, `test/cli-status-spawn-memoization.test.mjs`.
- Broker lifecycle and stream ordering: `test/broker-lifecycle.test.mjs`, `test/broker-stream-release-ordering.test.mjs`.

**E2E Tests:**
- No separate E2E framework is detected.
- Real runtime behavior that depends on Codex CLI authentication and app-server round trips must be probed manually with CLI commands after the static and Node test gates pass.

## Focused Test Commands

**CLI, Arguments, And Envelopes:**
```bash
node --test test/cli-errors.test.mjs test/events-json.test.mjs test/args.test.mjs
```

**Config, Adapter Routing, And Backend Selection:**
```bash
node --test test/adapter-routing.test.mjs test/adapter-selection.test.mjs test/adapter-registry.test.mjs
```

**App-Server Protocol And Turn Capture:**
```bash
node --test test/app-server-client.test.mjs test/app-server-abort.test.mjs test/codex-capture.test.mjs test/codex-capture-turn-timeout-fallback.test.mjs test/codex-capture-on-exit-flush.test.mjs
```

**Pipeline And Session Events:**
```bash
node --test test/auto-pipeline-turn-watchdog.test.mjs test/session-log.test.mjs
```

**State, Registry, And Jobs:**
```bash
node --test test/state.test.mjs test/state-stale-lock-toctou.test.mjs test/state-tmp-sweep-on-rename-failure.test.mjs test/registry.test.mjs test/job-control.test.mjs
```

**Git And Worktrees:**
```bash
node --test test/git.test.mjs test/git-worktree.test.mjs
```

**Plugin, Hooks, And Generated Surfaces:**
```bash
node --test test/plugin-surfaces.test.mjs test/pre-tool-bash-hook.test.mjs test/pre-tool-agent-hook.test.mjs test/official-plugin.test.mjs test/cli-status-spawn-memoization.test.mjs
```

**Prompts, Briefs, And Review Schema:**
```bash
node --test test/adversarial-review-prompt.test.mjs test/prompts-strict.test.mjs test/render-finding-validity.test.mjs test/brief.test.mjs
```

**Update Path:**
```bash
node --test test/update-check.test.mjs test/update-command.test.mjs test/auto-apply.test.mjs
```

## Build Drift Checks

**When Required:**
- Run `npm run build` after changes to `src/codex-bridge.mjs`, `src/adapters/**`, `src/lib/**`, `src/prompts/**`, `src/schemas/**`, `src/templates/**`, `hooks/**`, `commands/**`, `agents/**`, or `skill/config.yaml`.

**What It Proves:**
- `esbuild.config.mjs` creates the bundled CLI outputs.
- Static assets from prompts, schemas, templates, config, commands, agents, and hooks are copied into the appropriate installable layouts.
- Generated outputs under `skill/` and `plugin/` are synchronized with source.

**Recommended Local Gate:**
```bash
npm run build
npm test
```

## Runtime Probes

**Local CLI Probes:**
```bash
node src/codex-bridge.mjs help --json
node src/codex-bridge.mjs version --json
node src/codex-bridge.mjs does-not-exist --json
node src/codex-bridge.mjs send thr_abc hi --json
```

**Expected Coverage:**
- `help --json` and `version --json` prove JSON envelope paths.
- Unknown subcommands prove `UNKNOWN_SUBCOMMAND` handling and exit-code mapping.
- Invalid thread IDs prove send-command validation and `INVALID_THREAD_ID` handling.
- `setup --json` probes local Codex readiness, but full readiness depends on a usable Codex CLI and app-server.

## Common Patterns

**Async Testing:**
```javascript
test('waits for async behavior', async () => {
  const result = await runScenario()
  assert.equal(result.ok, true)
})
```

**Error Testing:**
```javascript
await assert.rejects(
  () => operationThatShouldFail(),
  /expected failure/
)
```

**Subprocess JSON Testing:**
```javascript
const result = spawnSync(process.execPath, ['src/codex-bridge.mjs', 'help', '--json'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
const envelope = JSON.parse(result.stdout)
assert.equal(envelope.ok, true)
```

**Temporary Git Testing:**
```javascript
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-git-'))
runGit(repo, ['init'])
```

## Behavioral Contracts To Preserve

**CLI Contracts:**
- Error envelopes, retryability, classes, and exit codes are asserted in `test/cli-errors.test.mjs`.
- JSON event output must stay a single structured envelope without raw event text, as asserted in `test/events-json.test.mjs`.

**State Contracts:**
- Concurrent state writers must preserve jobs in `test/state.test.mjs`.
- Corrupt state files are quarantined and defaults are returned in `test/state.test.mjs`.
- Lock races and temp cleanup are covered by `test/state-stale-lock-toctou.test.mjs` and `test/state-tmp-sweep-on-rename-failure.test.mjs`.

**Git Contracts:**
- Worktree branches must not clobber existing branches in `test/git-worktree.test.mjs`.
- Unsafe task IDs and ref injection attempts must be rejected in `test/git-worktree.test.mjs`.
- Fast-forward merge, stale expected SHA, and prune behavior are covered in `test/git-worktree.test.mjs`.

**Pipeline Contracts:**
- Review, fix, and completion-check stages must receive bounded watchdog timeouts in `test/auto-pipeline-turn-watchdog.test.mjs`.
- Unparsed needs-attention review text must not trigger a blind fix in `test/auto-pipeline-turn-watchdog.test.mjs`.
- Failed review, failed fix, and failed completion-check paths must produce the correct terminal status in `test/auto-pipeline-turn-watchdog.test.mjs`.

**Plugin Surface Contracts:**
- Packaged plugin commands, agents, hooks, generated scripts, and command JSON behavior are covered by `test/plugin-surfaces.test.mjs`.
- Hook safety and monitor behavior are covered by `test/pre-tool-bash-hook.test.mjs`, `test/pre-tool-agent-hook.test.mjs`, and `test/official-plugin.test.mjs`.

## Skipped Or Non-Static Areas

**Skipped Tests:**
- Some tests in `test/bridge-static.test.mjs` and `test/plugin-surfaces.test.mjs` are marked skipped for forward-looking behavior. Do not cite skipped tests as implemented behavior.

**Manual Validation Needed:**
- Static and fake-client tests do not prove real Codex app-server round trips.
- For runtime behavior changes, run the relevant CLI command against an authenticated Codex install after `npm run build` and `npm test`.

---

*Testing analysis: 2026-04-30*
