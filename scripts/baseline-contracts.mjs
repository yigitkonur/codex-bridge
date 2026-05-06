import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const REQUIRED_JSON_PROBES = Object.freeze([
  "help",
  "config",
  "version",
  "status",
  "result",
  "wait",
  "events",
  "setup",
  "error"
]);

const GENERATED_SURFACES = Object.freeze([
  {
    source: "src/codex-bridge.mjs",
    outputs: ["skill/scripts/codex-bridge.mjs", "plugin/scripts/codex-bridge.mjs"],
    kind: "bundle",
    reason: "CLI entrypoint bundled by esbuild.config.mjs for both install layouts"
  },
  {
    source: "src/adapters/codex/broker.mjs",
    outputs: ["skill/app-server-broker.mjs", "plugin/scripts/app-server-broker.mjs"],
    kind: "bundle",
    reason: "Shared Codex app-server broker bundled by esbuild.config.mjs"
  },
  {
    source: "src/prompts/adversarial-review.md",
    outputs: ["skill/prompts/adversarial-review.md", "plugin/prompts/adversarial-review.md"],
    kind: "static-copy",
    reason: "Prompt asset listed in staticAssets"
  },
  {
    source: "src/schemas/review-output.schema.json",
    outputs: ["skill/schemas/review-output.schema.json", "plugin/schemas/review-output.schema.json"],
    kind: "static-copy",
    reason: "Review schema asset listed in staticAssets"
  },
  {
    source: "plugin/schemas/brief.schema.json",
    outputs: ["plugin/schemas/brief.schema.json"],
    kind: "packaged-static",
    reason: "Brief schema is a packaged plugin-only contract referenced by plugin skill guidance"
  },
  {
    source: "src/templates/execute-instructions.md",
    outputs: ["skill/templates/execute-instructions.md", "plugin/templates/execute-instructions.md"],
    kind: "static-copy",
    reason: "Developer-instruction template listed in staticAssets"
  },
  {
    source: "src/templates/plan-enforcement.md",
    outputs: ["skill/templates/plan-enforcement.md", "plugin/templates/plan-enforcement.md"],
    kind: "static-copy",
    reason: "Plan-mode enforcement template listed in staticAssets"
  },
  {
    source: "skill/config.yaml",
    outputs: ["plugin/config.yaml"],
    kind: "static-copy",
    reason: "Plugin default config is copied from the legacy skill config"
  },
  {
    source: "hooks",
    outputs: ["plugin/hooks"],
    kind: "directory-copy-with-plugin-path-transform",
    reason: "Root hook scripts/config are copied into the packaged plugin layout"
  },
  {
    source: "plugin/.claude-plugin/plugin.json",
    outputs: ["plugin/.claude-plugin/plugin.json"],
    kind: "packaged-static",
    reason: "Packaged plugin metadata is part of the installable plugin surface"
  },
  {
    source: "plugin/commands",
    outputs: ["plugin/commands"],
    kind: "packaged-directory",
    reason: "Packaged slash commands are part of the installable plugin surface"
  },
  {
    source: "plugin/agents",
    outputs: ["plugin/agents"],
    kind: "packaged-directory",
    reason: "Packaged subagent definitions are part of the installable plugin surface"
  },
  {
    source: "plugin/skills/codex-bridge/SKILL.md",
    outputs: ["plugin/skills/codex-bridge/SKILL.md"],
    kind: "packaged-static",
    reason: "Packaged plugin skill metadata is part of the installable plugin surface"
  }
]);

const JSON_ENVELOPE_PROBES = Object.freeze([
  {
    command: "help --json",
    expected: ["ok", "schema_version", "command", "result.commands", "meta.duration_ms"],
    test: "test/baseline-contracts.test.mjs"
  },
  {
    command: "config show --json",
    expected: ["result.sources", "result.effective_config", "result.precedence_order_low_to_high"],
    test: "test/baseline-contracts.test.mjs"
  },
  {
    command: "version --json",
    expected: ["result.version", "result.active_backend", "result.adapter_capabilities"],
    test: "test/baseline-contracts.test.mjs"
  },
  {
    command: "status --json",
    expected: ["result.workspaceRoot", "result.running", "result.latestFinished"],
    test: "test/baseline-contracts.test.mjs"
  },
  {
    command: "result <job-id> --json",
    expected: ["result.job", "result.storedJob"],
    test: "test/baseline-contracts.test.mjs"
  },
  {
    command: "wait <job-id> --json",
    expected: ["result.jobId", "result.threadId", "result.terminalTag", "result.eventsPath"],
    test: "test/baseline-contracts.test.mjs"
  },
  {
    command: "events <job-id> --json",
    expected: ["result.jobId", "result.threadId", "result.eventsPath"],
    test: "test/baseline-contracts.test.mjs"
  },
  {
    command: "setup --json",
    expected: ["result.ready", "result.reviewGateLockPath", "result.reviewGateEnabled", "result.monitorHookInstalled", "result.active_backend", "result.adapter_capabilities"],
    test: "test/baseline-contracts.test.mjs"
  },
  {
    command: "unknown-subcommand --json",
    expected: ["ok:false", "error.class", "error.code", "error.retryable"],
    test: "test/baseline-contracts.test.mjs"
  }
]);

const COMMAND_COVERAGE = Object.freeze({
  setup: {
    mutation: "project stop-review-gate lock and Claude user-settings Monitor hook mirror when setup flags are used",
    success_tests: ["test/official-plugin.test.mjs", "test/plugin-surfaces.test.mjs"],
    failure_tests: ["test/baseline-contracts.test.mjs"],
    baseline_gap: null
  },
  update: {
    mutation: "external skills installer only when --apply/--yes is requested",
    success_tests: ["test/update-command.test.mjs", "test/auto-apply.test.mjs"],
    failure_tests: ["test/update-command.test.mjs"],
    baseline_gap: null
  },
  review: {
    mutation: "review session artifacts, events, normalized review.json, and registry job state",
    success_tests: ["test/bridge-static.test.mjs", "test/adapter-routing.test.mjs", "test/review-result.test.mjs", "test/registry.test.mjs", "test/plugin-surfaces.test.mjs"],
    failure_tests: ["test/bridge-static.test.mjs", "test/plugin-surfaces.test.mjs"],
    baseline_gap: "No fully live review --json round-trip test without an authenticated Codex app-server; release smoke owns that proof."
  },
  "adversarial-review": {
    mutation: "adversarial review session artifacts, prompt output, and review JSON artifact",
    success_tests: ["test/adversarial-review-prompt.test.mjs", "test/render-finding-validity.test.mjs", "test/review-result.test.mjs", "test/registry.test.mjs", "test/plugin-surfaces.test.mjs"],
    failure_tests: ["test/adversarial-review-prompt.test.mjs", "test/plugin-surfaces.test.mjs"],
    baseline_gap: "No authenticated app-server review smoke in static tests; Phase 6 must cover live review behavior."
  },
  task: {
    mutation: "workspace jobs, session logs/events, optional worktree changes, registry artifacts, and auto-pipeline stage/budget/partial-completion proof",
    success_tests: ["test/bridge-static.test.mjs", "test/auto-pipeline-turn-watchdog.test.mjs", "test/job-control.test.mjs"],
    failure_tests: ["test/bridge-static.test.mjs", "test/auto-pipeline-turn-watchdog.test.mjs", "test/cli-errors.test.mjs"],
    baseline_gap: "Static tests use mocked/runtime slices; Phase 6 must cover real foreground/background Codex task smoke."
  },
  "task-worker": {
    mutation: "internal detached worker updates queued task records and session artifacts",
    success_tests: ["test/bridge-static.test.mjs"],
    failure_tests: ["test/bridge-static.test.mjs"],
    baseline_gap: "Internal command is exercised through launcher/worker static contracts rather than direct CLI invocation."
  },
  send: {
    mutation: "existing thread events and session logs through app-server turn continuation",
    success_tests: ["test/bridge-static.test.mjs", "test/adapter-routing.test.mjs"],
    failure_tests: ["test/cli-errors.test.mjs"],
    baseline_gap: "Live continuation is not static-testable without authenticated Codex app-server."
  },
  steer: {
    mutation: "active Codex turn steering state when supported by upstream runtime",
    success_tests: ["test/adapter-routing.test.mjs"],
    failure_tests: ["test/adapter-routing.test.mjs", "test/cli-errors.test.mjs"],
    baseline_gap: "No live steering smoke; capability is backend-dependent."
  },
  respond: {
    mutation: "pending request response state for requestUserInput prompts",
    success_tests: ["test/bridge-static.test.mjs", "test/adapter-routing.test.mjs"],
    failure_tests: ["test/cli-errors.test.mjs"],
    baseline_gap: "No end-to-end requestUserInput app-server prompt smoke in static tests."
  },
  status: {
    mutation: "state file only for --prune-orphans/--cleanup; default status is read-only",
    success_tests: ["test/state.test.mjs", "test/job-control.test.mjs", "test/baseline-contracts.test.mjs"],
    failure_tests: ["test/state.test.mjs"],
    baseline_gap: null
  },
  cancel: {
    mutation: "job state transitions to cancelled and process termination is attempted",
    success_tests: ["test/job-control.test.mjs"],
    failure_tests: ["test/job-control.test.mjs"],
    baseline_gap: "Cancel has state-level coverage; direct CLI cancellation of a live process remains runtime smoke territory."
  },
  verdict: {
    mutation: "registry verdict.json write/delete",
    success_tests: ["test/registry.test.mjs", "test/plugin-surfaces.test.mjs"],
    failure_tests: ["test/registry.test.mjs", "test/plugin-surfaces.test.mjs"],
    baseline_gap: null
  },
  merge: {
    mutation: "git worktree/base branch fast-forward plus registry verdict/meta updates",
    success_tests: ["test/git-worktree.test.mjs"],
    failure_tests: ["test/git-worktree.test.mjs"],
    baseline_gap: null
  },
  iterate: {
    mutation: "closed-loop task, adversarial review, verdict persistence, same-worktree follow-up, approval, and iteration-limit orchestration",
    success_tests: ["test/iterate-loop.test.mjs", "test/plugin-surfaces.test.mjs"],
    failure_tests: ["test/iterate-loop.test.mjs", "test/plugin-surfaces.test.mjs"],
    baseline_gap: null
  }
});

const READ_ONLY_COMMANDS = Object.freeze([
  "help",
  "version",
  "config",
  "auth-status",
  "summary",
  "result",
  "wait",
  "events",
  "task-resume-candidate",
  "await-artifact",
  "verdicts"
]);

function readText(rootDir, relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

function pathExists(rootDir, relativePath) {
  return fs.existsSync(path.join(rootDir, relativePath));
}

function extractDispatchCommands(source) {
  const match = /const SUBCOMMAND_DISPATCH = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(source);
  if (!match) {
    throw new Error("Unable to locate SUBCOMMAND_DISPATCH in src/codex-bridge.mjs");
  }
  const block = match[1];
  const commands = Array.from(
    block.matchAll(/^\s*(?:"([^"]+)"|([A-Za-z_$][\w$-]*))\s*:/gm),
    (match) => match[1] ?? match[2]
  ).sort();
  if (commands.length === 0) {
    throw new Error("SUBCOMMAND_DISPATCH parsed to zero commands");
  }
  return commands;
}

function withPluginPathTransform(content) {
  return content
    .replaceAll(
      "${CLAUDE_PLUGIN_ROOT}/skill/scripts/codex-bridge.mjs",
      "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs"
    )
    .replaceAll(
      'path.resolve(SCRIPT_DIR, "..", "skill", "scripts", "codex-bridge.mjs")',
      'path.resolve(SCRIPT_DIR, "..", "scripts", "codex-bridge.mjs")'
    );
}

function buildExpectedBundleRoot(rootDir) {
  const expectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-expected-bundles-"));
  const targets = [
    {
      cliOut: "skill/scripts/codex-bridge.mjs",
      brokerOut: "skill/app-server-broker.mjs",
    },
    {
      cliOut: "plugin/scripts/codex-bridge.mjs",
      brokerOut: "plugin/scripts/app-server-broker.mjs",
    },
  ];

  for (const target of targets) {
    buildSync({
      absWorkingDir: rootDir,
      entryPoints: ["src/codex-bridge.mjs"],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: path.join(expectedRoot, target.cliOut),
      external: [],
      minify: false,
      sourcemap: false,
      logLevel: "silent",
    });

    buildSync({
      absWorkingDir: rootDir,
      entryPoints: ["src/adapters/codex/broker.mjs"],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: path.join(expectedRoot, target.brokerOut),
      external: [],
      minify: false,
      sourcemap: false,
      logLevel: "silent",
    });
  }

  return expectedRoot;
}

function compareGeneratedSurface(rootDir, surface, expectedBundleRoot = null) {
  const failures = [];
  if (!pathExists(rootDir, surface.source)) {
    failures.push(`missing source: ${surface.source}`);
    return failures;
  }

  if (surface.kind === "packaged-static") {
    for (const output of surface.outputs) {
      if (!pathExists(rootDir, output)) failures.push(`missing packaged static surface: ${output}`);
    }
    return failures;
  }

  if (surface.kind === "packaged-directory") {
    for (const output of surface.outputs) {
      const absolute = path.join(rootDir, output);
      if (!fs.existsSync(absolute)) {
        failures.push(`missing packaged directory surface: ${output}`);
      } else if (!fs.statSync(absolute).isDirectory()) {
        failures.push(`packaged surface is not a directory: ${output}`);
      } else if (fs.readdirSync(absolute).length === 0) {
        failures.push(`packaged directory surface is empty: ${output}`);
      }
    }
    return failures;
  }

  for (const output of surface.outputs) {
    if (!pathExists(rootDir, output)) {
      failures.push(`missing generated output: ${output}`);
      continue;
    }
    if (surface.kind === "static-copy") {
      const source = readText(rootDir, surface.source);
      const generated = readText(rootDir, output);
      if (source !== generated) failures.push(`stale generated static copy: ${output}`);
    }
    if (surface.kind === "bundle") {
      if (!expectedBundleRoot) {
        failures.push(`missing expected bundle build root for ${output}`);
      } else {
        const expected = fs.readFileSync(path.join(expectedBundleRoot, output), "utf8");
        const generated = readText(rootDir, output);
        if (expected !== generated) failures.push(`stale generated bundle: ${output}`);
      }
    }
    if (surface.source === "skill/config.yaml") {
      const source = readText(rootDir, surface.source);
      const generated = readText(rootDir, output);
      if (source !== generated) failures.push(`stale generated config copy: ${output}`);
    }
  }

  if (surface.kind === "directory-copy-with-plugin-path-transform") {
    const sourceDir = path.join(rootDir, surface.source);
    const outputDir = path.join(rootDir, surface.outputs[0]);
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const sourceRelative = path.join(surface.source, entry.name);
      const outputRelative = path.join(surface.outputs[0], entry.name);
      if (!pathExists(rootDir, outputRelative)) {
        failures.push(`missing generated hook copy: ${outputRelative}`);
        continue;
      }
      const source = withPluginPathTransform(readText(rootDir, sourceRelative));
      const generated = readText(rootDir, outputRelative);
      if (source !== generated) failures.push(`stale generated hook copy: ${outputRelative}`);
    }
  }

  return failures;
}

function frontmatterVersion(text) {
  const match = text.match(/metadata:\s*[\s\S]*?\n\s+version:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function verifyPluginMetadata(rootDir, pkg) {
  const failures = [];
  const requiredFiles = [
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    "plugin/.claude-plugin/plugin.json",
    "skill/SKILL.md",
    "plugin/skills/codex-bridge/SKILL.md",
  ];
  for (const file of requiredFiles) {
    if (!pathExists(rootDir, file)) failures.push(`missing plugin metadata contract file: ${file}`);
  }
  if (failures.length > 0) return failures;

  const rootManifest = JSON.parse(readText(rootDir, ".claude-plugin/plugin.json"));
  const marketplace = JSON.parse(readText(rootDir, ".claude-plugin/marketplace.json"));
  const pluginManifest = JSON.parse(readText(rootDir, "plugin/.claude-plugin/plugin.json"));
  const legacySkillVersion = frontmatterVersion(readText(rootDir, "skill/SKILL.md"));
  const packagedSkillVersion = frontmatterVersion(readText(rootDir, "plugin/skills/codex-bridge/SKILL.md"));

  if (rootManifest.name !== pkg.name) failures.push(".claude-plugin/plugin.json name must match package.json name");
  if (rootManifest.version !== pkg.version) failures.push(".claude-plugin/plugin.json version must match package.json version");
  if (legacySkillVersion !== pkg.version) failures.push("skill/SKILL.md metadata.version must match package.json version");
  if (packagedSkillVersion !== pkg.version) failures.push("plugin skill metadata.version must match package.json version");
  if (marketplace.name !== pkg.name) failures.push(".claude-plugin/marketplace.json name must match package.json name");
  if (pluginManifest.name !== pkg.name) failures.push("packaged plugin manifest name must match package.json name");
  if (pluginManifest.version !== pkg.version) failures.push("packaged plugin manifest version must match package.json version");

  const canonicalEntry = marketplace.plugins?.find((entry) => entry.name === pkg.name);
  if (!canonicalEntry) failures.push("marketplace must publish canonical codex-bridge entry");
  if (canonicalEntry && canonicalEntry.source !== "./plugin") failures.push("marketplace canonical entry must point to ./plugin");
  if (/noncanonical|alpha|pre-release|scaffold/i.test(marketplace.description ?? "")) {
    failures.push("marketplace description must not describe the packaged plugin as alpha or noncanonical");
  }
  if (/noncanonical|alpha|pre-release|scaffold/i.test(canonicalEntry?.description ?? "")) {
    failures.push("marketplace canonical entry must not describe the packaged plugin as alpha or noncanonical");
  }
  if (/noncanonical|alpha|pre-release|scaffold/i.test(pluginManifest.description ?? "")) {
    failures.push("packaged plugin manifest must not describe itself as alpha or noncanonical");
  }

  return failures;
}

export function buildBaselineContracts(rootDir = process.cwd()) {
  const pkg = JSON.parse(readText(rootDir, "package.json"));
  const bridgeSource = readText(rootDir, "src/codex-bridge.mjs");
  const dispatchCommands = extractDispatchCommands(bridgeSource);
  const coveredCommands = new Set([...READ_ONLY_COMMANDS, ...Object.keys(COMMAND_COVERAGE)]);

  return {
    schema_version: "1.0",
    project: pkg.name,
    package_version: pkg.version,
    static_gate: {
      command: "npm run verify:static",
      steps: ["npm run build", "npm test", "npm run baseline:contracts -- --check"]
    },
    generated_surfaces: GENERATED_SURFACES,
    json_envelope_probes: JSON_ENVELOPE_PROBES,
    mutating_command_coverage: COMMAND_COVERAGE,
    read_only_commands: READ_ONLY_COMMANDS,
    dispatch_commands: dispatchCommands,
    baseline_gaps: Object.fromEntries(
      Object.entries(COMMAND_COVERAGE)
        .filter(([, value]) => value.baseline_gap)
        .map(([command, value]) => [command, value.baseline_gap])
    ),
    coverage_summary: {
      dispatch_commands: dispatchCommands.length,
      classified_commands: dispatchCommands.filter((command) => coveredCommands.has(command)).length,
      mutating_commands: Object.keys(COMMAND_COVERAGE).length,
      read_only_commands: READ_ONLY_COMMANDS.length,
      json_probe_targets: JSON_ENVELOPE_PROBES.length,
      generated_surface_sources: GENERATED_SURFACES.length
    }
  };
}

export function verifyBaselineContracts(rootDir = process.cwd(), report = buildBaselineContracts(rootDir)) {
  const failures = [];
  const pkg = JSON.parse(readText(rootDir, "package.json"));
  const expectedBundleRoot = report.generated_surfaces.some((surface) => surface.kind === "bundle")
    ? buildExpectedBundleRoot(rootDir)
    : null;

  try {
    if (!pkg.scripts?.["verify:static"]) failures.push("package.json missing scripts.verify:static");
    if (!pkg.scripts?.["baseline:contracts"]) failures.push("package.json missing scripts.baseline:contracts");
    if (pkg.scripts?.["verify:static"] && !pkg.scripts["verify:static"].includes("npm run build")) {
      failures.push("verify:static must run npm run build");
    }
    if (pkg.scripts?.["verify:static"] && !pkg.scripts["verify:static"].includes("npm test")) {
      failures.push("verify:static must run npm test");
    }
    if (pkg.scripts?.["verify:static"] && !pkg.scripts["verify:static"].includes("baseline:contracts")) {
      failures.push("verify:static must run baseline:contracts -- --check");
    }

    for (const surface of report.generated_surfaces) {
      failures.push(...compareGeneratedSurface(rootDir, surface, expectedBundleRoot));
    }

    failures.push(...verifyPluginMetadata(rootDir, pkg));

    const coveredCommands = new Set([...report.read_only_commands, ...Object.keys(report.mutating_command_coverage)]);
    for (const command of report.dispatch_commands) {
      if (!coveredCommands.has(command)) {
        failures.push(`dispatch command is not classified as read-only or mutating: ${command}`);
      }
    }

    for (const probe of REQUIRED_JSON_PROBES) {
      if (!report.json_envelope_probes.some((entry) => entry.command.split(" ")[0] === probe || probe === "error" && entry.command.includes("unknown-subcommand"))) {
        failures.push(`missing JSON envelope probe target: ${probe}`);
      }
    }

    for (const [command, coverage] of Object.entries(report.mutating_command_coverage)) {
      if (!Array.isArray(coverage.success_tests) || coverage.success_tests.length === 0) {
        failures.push(`${command} missing success_tests coverage entry`);
      }
      if (!Array.isArray(coverage.failure_tests) || coverage.failure_tests.length === 0) {
        failures.push(`${command} missing failure_tests coverage entry`);
      }
      if (coverage.baseline_gap != null && typeof coverage.baseline_gap !== "string") {
        failures.push(`${command} baseline_gap must be null or a string`);
      }
      for (const testFile of [...coverage.success_tests, ...coverage.failure_tests]) {
        if (!testFile.startsWith("test/") || !testFile.endsWith(".test.mjs")) {
          failures.push(`${command} references non-test coverage file: ${testFile}`);
        }
        if (!pathExists(rootDir, testFile)) failures.push(`${command} references missing test file: ${testFile}`);
      }
    }

    for (const probe of report.json_envelope_probes) {
      if (!Array.isArray(probe.expected) || probe.expected.length === 0) {
        failures.push(`JSON probe has no expected fields: ${probe.command}`);
      }
      if (!probe.test.startsWith("test/") || !probe.test.endsWith(".test.mjs")) {
        failures.push(`JSON probe references non-test file: ${probe.test}`);
      }
      if (!pathExists(rootDir, probe.test)) failures.push(`JSON probe references missing test file: ${probe.test}`);
    }
  } finally {
    if (expectedBundleRoot) {
      fs.rmSync(expectedBundleRoot, { recursive: true, force: true });
    }
  }

  return {
    ok: failures.length === 0,
    failures
  };
}

function printUsage() {
  process.stdout.write("Usage: node scripts/baseline-contracts.mjs [--json] [--check]\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    printUsage();
    process.exit(0);
  }

  const report = buildBaselineContracts(process.cwd());
  const check = verifyBaselineContracts(process.cwd(), report);
  if (args.has("--check")) {
    if (!check.ok) {
      process.stderr.write(`${check.failures.join("\n")}\n`);
      process.exit(1);
    }
    process.stdout.write("Baseline contracts: OK\n");
    process.exit(0);
  }

  process.stdout.write(`${JSON.stringify({ ...report, check }, null, 2)}\n`);
}
