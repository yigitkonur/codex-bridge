---
last_mapped_commit: 6b3a78a98eb5396798d0ed2ee3d8f7451f204652
---

# Testing Patterns

**Analysis Date:** 2026-05-02

## Test Framework

**Runner:**
- Node built-in test runner through `node --test test/*.test.mjs`.
- Config: no separate test config file detected. The runner command lives in `package.json`.
- Test files: 39 files under `test/` with 303 `test(...)` declarations.

**Assertion Library:**
- `node:assert/strict` is used throughout the suite. Examples include `test/baseline-contracts.test.mjs`, `test/adapter-routing.test.mjs`, `test/plugin-surfaces.test.mjs`, and `test/cli-errors.test.mjs`.

**Run Commands:**
```bash
npm test                               # Run all Node test files
node --test test/*.test.mjs            # Direct runner equivalent
npm run verify:static                  # Build, test, and baseline contract check
npm run baseline:contracts -- --check  # Static generated-surface and CLI-contract check
```

Watch mode is not configured in `package.json`.

Coverage is not configured in `package.json`, `.github/workflows/build.yml`, or repository test config. Use `npm run verify:static` for the enforced static gate.

## Test File Organization

**Location:**
- Tests live in the top-level `test/` directory, separate from `src/`, `hooks/`, `plugin/`, and `scripts/`.
- Source modules are imported directly from `../src/...` and generated bundle surfaces are read from `skill/` and `plugin/`.

**Naming:**
- Use `<area>.test.mjs`: `test/args.test.mjs`, `test/state.test.mjs`, `test/git-worktree.test.mjs`, `test/codex-adapter-lifecycle.test.mjs`.
- Use domain-specific names for contract tests: `test/bridge-static.test.mjs`, `test/plugin-surfaces.test.mjs`, `test/baseline-contracts.test.mjs`, `test/skill-word-budget.test.mjs`.

**Structure:**
```text
test/
|-- *-static.test.mjs              # regex/source-shape contracts, e.g. test/bridge-static.test.mjs
|-- *-lifecycle.test.mjs           # adapter/broker lifecycle behavior
|-- *-hook.test.mjs                # hook subprocess tests
|-- *-worktree.test.mjs            # real git worktree tests
`-- <module>.test.mjs              # focused unit tests for src/lib and adapters
```

## Test Structure

**Suite Organization:**
```javascript
import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../src/lib/args.mjs";

test("inline long value options preserve additional equals signs", () => {
  assert.deepEqual(parseArgs(["req-1", "--answer=FOO=bar=baz"], {
    valueOptions: ["answer"]
  }), {
    options: { answer: "FOO=bar=baz" },
    positionals: ["req-1"]
  });
});
```

**Patterns:**
- Import `test` and `assert` at the top of every test file. Both `import test from "node:test"` and `import assert from "node:assert/strict"` orders exist; match the local file.
- Use one behavior per `test(...)` block with descriptive names. Examples: `test/cli-errors.test.mjs`, `test/process.test.mjs`, and `test/codex-capture.test.mjs`.
- Use `async (t)` when cleanup should be registered with `t.after`, as in `test/adapter-routing.test.mjs`, `test/broker-lifecycle.test.mjs`, `test/codex-adapter-lifecycle.test.mjs`, and `test/update-check.test.mjs`.
- Use `try`/`finally` cleanup for temp roots, env changes, process monkeypatches, and worktrees. Examples: `test/baseline-contracts.test.mjs`, `test/state.test.mjs`, `test/git-worktree.test.mjs`, and `test/plugin-surfaces.test.mjs`.
- Use direct assertions on public shapes rather than snapshots. Examples: JSON envelopes in `test/baseline-contracts.test.mjs`, generated surface lists in `test/plugin-surfaces.test.mjs`, and review result validation in `test/render-finding-validity.test.mjs`.
- Use static source contract tests only for high-value invariants that are hard to prove with runtime tests. `test/bridge-static.test.mjs` checks source snippets around terminal event ordering, adapter routing, background job persistence, and workspace-dirty recovery.

## Mocking

**Framework:** None. The suite uses manual fakes, dependency injection, temp files, env variables, subprocesses, and source inspection.

**Patterns:**
```javascript
class FakeTurnClient {
  constructor() {
    this.notificationHandler = null;
    this.listeners = new Map();
    this.requests = [];
  }
}
```

`test/codex-capture.test.mjs`, `test/codex-capture-on-exit-flush.test.mjs`, `test/codex-capture-turn-timeout-fallback.test.mjs`, `test/app-server-client.test.mjs`, and `test/broker-stream-release-ordering.test.mjs` use fake client classes to exercise app-server lifecycle logic without a real Codex process.

```javascript
_setCodexAdapterRuntimeForTest({
  async runTurn(callCwd, options) {
    calls.push({ cwd: callCwd, options });
    return { status: 0, threadId: "thread", turnId: "turn" };
  }
});
```

`test/codex-adapter-lifecycle.test.mjs` uses `_setCodexAdapterRuntimeForTest` and `_resetCodexAdapterRuntimeForTest` from `src/adapters/codex/index.mjs`.

```javascript
const result = runCommand("git", ["status"], {
  spawnSync(command, args, options) {
    captured = { command, args, options };
    return makeSpawnResult({ stdout: "ok\n" });
  }
});
```

`test/process.test.mjs` injects `spawnSync` through `src/lib/process.mjs`.

**What to Mock:**
- Mock app-server clients, adapter runtime methods, subprocess calls, timeouts, and hook bridge scripts when the test owns the behavior boundary. Use patterns in `test/app-server-client.test.mjs`, `test/codex-adapter-lifecycle.test.mjs`, `test/auto-pipeline-turn-watchdog.test.mjs`, and `test/plugin-surfaces.test.mjs`.
- Mock global time only inside a `try`/`finally` with restoration. `test/auto-pipeline-turn-watchdog.test.mjs` patches `Date.now`, `globalThis.setTimeout`, and `globalThis.clearTimeout`.
- Use temp CLI scripts for hook and plugin behavior. `test/pre-tool-agent-hook.test.mjs` creates a stub `plugin/scripts/codex-bridge.mjs`; `test/plugin-surfaces.test.mjs` creates stop-gate harness scripts.

**What NOT to Mock:**
- Do not mock generated bundle drift checks. `test/baseline-contracts.test.mjs`, `scripts/baseline-contracts.mjs`, and `.github/workflows/build.yml` compare generated outputs and expected surfaces directly.
- Do not mock plugin manifest paths or command coverage. `test/plugin-surfaces.test.mjs` reads `.claude-plugin/plugin.json`, `plugin/.claude-plugin/plugin.json`, `plugin/commands/`, `plugin/agents/`, `hooks/hooks.json`, and `plugin/hooks/hooks.json`.
- Do not mock git behavior for worktree/merge safety tests. `test/git-worktree.test.mjs` creates real temporary git repositories and runs real `git` commands.
- Do not require an authenticated live Codex runtime in static tests. Runtime smoke belongs outside `npm test`; `scripts/baseline-contracts.mjs` records live-smoke gaps for commands that need Codex app-server round trips.

## Fixtures and Factories

**Test Data:**
```javascript
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-state-test-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-workspace-"));
process.env.CODEX_BRIDGE_PLUGIN_DATA = root;
try {
  // seed state, job files, events, or config.yaml
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
}
```

**Location:**
- Fixtures are created inline in test files. There is no shared `fixtures/` directory.
- Common fixture helpers live near their tests:
  - `withCliFixture`, `runBridge`, and `makeContractFixture` in `test/baseline-contracts.test.mjs`.
  - `makeConfigFixture` in `test/adapter-routing.test.mjs`.
  - `makeStopGateHarness` and `runStopGateHarness` in `test/plugin-surfaces.test.mjs`.
  - `makeTempRepo` and `cleanup` in `test/git-worktree.test.mjs`.
  - `makeTempSession`, `makeReviewStub`, and `makeTurnStub` in `test/auto-pipeline-turn-watchdog.test.mjs`.
- Environment mutation must snapshot and restore previous values. Examples: `CODEX_BRIDGE_PLUGIN_DATA` and `CLAUDE_PLUGIN_DATA` handling in `test/state.test.mjs`, `test/baseline-contracts.test.mjs`, `test/events-json.test.mjs`, and `test/update-check.test.mjs`.

## Coverage

**Requirements:** No line, branch, or statement coverage target is enforced.

**View Coverage:**
```bash
# Not configured in package.json
```

The repository uses contract coverage instead of code coverage:
- `scripts/baseline-contracts.mjs` defines `COMMAND_COVERAGE`, `GENERATED_SURFACES`, and `JSON_ENVELOPE_PROBES`.
- `test/baseline-contracts.test.mjs` asserts that mutating dispatch commands have success/failure test references and that JSON envelope probes stay populated.
- `.github/workflows/build.yml` runs bundle drift checks and sanity probes against both `skill/scripts/codex-bridge.mjs` and `plugin/scripts/codex-bridge.mjs`.

## Test Types

**Unit Tests:**
- Scope: parser, config, error classification, rendering, registry, process helper, prompt interpolation, and adapter registry logic.
- Files: `test/args.test.mjs`, `test/cli-errors.test.mjs`, `test/render-finding-validity.test.mjs`, `test/registry.test.mjs`, `test/process.test.mjs`, `test/prompts-strict.test.mjs`, `test/adapter-registry.test.mjs`.
- Approach: import the owning module directly from `src/`, call one function or small cluster, assert exact return objects and errors.

**Integration Tests:**
- Scope: CLI envelopes, generated bundle outputs, plugin surfaces, hooks, state files, git worktrees, broker lifecycle, and adapter lifecycle.
- Files: `test/baseline-contracts.test.mjs`, `test/plugin-surfaces.test.mjs`, `test/events-json.test.mjs`, `test/pre-tool-bash-hook.test.mjs`, `test/pre-tool-agent-hook.test.mjs`, `test/git-worktree.test.mjs`, `test/broker-lifecycle.test.mjs`, `test/codex-adapter-lifecycle.test.mjs`.
- Approach: use `spawnSync`, temp repos, temp plugin data dirs, generated bundle paths, and actual hook scripts.

**E2E Tests:**
- Not used in `npm test`. There is no Playwright, browser, or authenticated live Codex app-server E2E suite in package scripts.
- For runtime behavior changes, run the relevant CLI command against an authenticated Codex install after `npm run verify:static`. Static tests do not prove live app-server round trips.

## Common Patterns

**Async Testing:**
```javascript
test("codex adapter dispatch delegates to the app-server turn runtime", async (t) => {
  _setCodexAdapterRuntimeForTest({ async runTurn() { return { status: 0 }; } });
  t.after(() => _resetCodexAdapterRuntimeForTest());
  const result = await codexAdapter.dispatch("hello", { cwd, sessionDir });
  assert.equal(result.rawResult.status, 0);
});
```

Use this style for adapter runtime injection in `test/codex-adapter-lifecycle.test.mjs`, broker lifecycle promises in `test/broker-lifecycle.test.mjs`, and capture-turn lifecycle checks in `test/codex-capture.test.mjs`.

**Error Testing:**
```javascript
await assert.rejects(
  selectAdapter({ backend: "unknown" }),
  (err) => err instanceof AdapterError && err.code === "BACKEND_INCAPABLE"
);
```

Use predicate assertions when checking typed errors, details, and mapped exit behavior. Examples: `test/adapter-routing.test.mjs`, `test/adapter-registry.test.mjs`, `test/cli-errors.test.mjs`, and `test/git-worktree.test.mjs`.

**Subprocess Testing:**
```javascript
const result = spawnSync(process.execPath, [bridgePath, "events", job.id, "--json"], {
  cwd: workspace,
  env,
  encoding: "utf8"
});
assert.equal(result.status, 0, result.stderr || result.stdout);
```

Use subprocess tests for real CLI/hook entrypoints in `test/baseline-contracts.test.mjs`, `test/events-json.test.mjs`, `test/plugin-surfaces.test.mjs`, `test/pre-tool-bash-hook.test.mjs`, and `test/pre-tool-agent-hook.test.mjs`.

**Static Contract Testing:**
```javascript
const bridge = fs.readFileSync(new URL("../src/codex-bridge.mjs", import.meta.url), "utf8");
assert.match(bridge, /adapter\.dispatch\(request\.prompt/);
assert.doesNotMatch(bridge, /runAppServerTurn\(cwd, turnOptions\)/);
```

Use static source assertions sparingly for cross-cutting invariants that are expensive to exercise end to end. `test/bridge-static.test.mjs`, `test/adversarial-review-prompt.test.mjs`, `test/prompts-strict.test.mjs`, and `test/skill-word-budget.test.mjs` follow this pattern.

---

*Testing analysis: 2026-05-02*
