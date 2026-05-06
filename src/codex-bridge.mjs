import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { guardCapability } from "./adapters/index.mjs";
import {
  CliError,
  emitError,
  emitSuccess,
  detectJsonFlag,
  detectHelpFlag,
  usageError,
  validationError,
  notFoundError,
  conflictError,
  invalidThreadIdError,
  classifyTurnErrorOrigin,
  classifyError,
  normalizeCodexErrorInfo,
  getUpstreamRetryPolicy,
  buildHandoffEnvelope,
  buildErrorEnvelope,
  extractUpstreamRequestId
} from "./lib/cli-errors.mjs";
import { isThreadId } from "./lib/thread-id.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./adapters/codex/codex.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, createSubagentWorktree, ensureGitRepository, getWorkingTreeState, mergeSubagentBranch, pruneWorktreeOnCancel, resolveReviewTarget } from "./lib/git.mjs";
import {
  existsTask,
  jobDir,
  listTasks,
  readMeta,
  readVerdict,
  writeMeta,
  writeVerdict,
  writeReview as writeRegistryReview,
  writeBriefArtifacts,
  writeDiffArtifact
} from "./lib/registry.mjs";
import { loadBrief, renderBriefAsMarkdown } from "./lib/brief.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "./lib/process.mjs";
import { buildAdversarialReviewPrompt } from "./lib/adversarial-review-prompt.mjs";
import {
  detectOfficialOpenAICodexPlugin,
  OFFICIAL_PLUGIN_STATUS
} from "./lib/official-plugin.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  resolveJobFile,
  setConfig,
  updateState,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  readLocalConfig,
  writeLocalConfig,
  resolveLocalConfigPath,
  serializeLocalConfig,
  getDefaultLocalConfigBody,
} from "./lib/local-config.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";
import {
  buildCollaborationMode,
  buildSandboxPolicy,
  COMPLETION_CHECK_SCHEMA,
  CONFIG_SCHEMA,
  CONFIG_KEY_DOCS,
  parseConfigValue,
  DEFAULT_CONFIG,
  resolveConfigLayers,
  resolveConfigSources,
  validateConfigLayers
} from "./lib/config.mjs";
import {
  resolveSessionDir,
  initSession,
  findSession,
  writeSessionAliases,
  logNdjson,
  logEvent,
  captureGitDiff,
  captureGitSnapshot,
  diffGitSnapshot,
  writePlan,
  formatDoneEvent,
  formatErrorEvent,
  formatIncompleteEvent,
  formatQuestionEvent,
  formatPlanEvent,
  formatConfirmedEvent,
  formatPipelineEvent,
  formatHeartbeatEvent,
  formatCheckpointEvent,
  formatPhaseEvent,
  formatReviewEvent,
  formatWarningEvent,
  formatDirectivesEvent,
  formatPartialEvent,
  formatRetryingEvent,
  formatHandoffEvent,
  formatStallWarningEvent,
  formatNeedsAttentionEvent,
  formatArtifactEvent,
  formatDriftWarnEvent,
  TERMINAL_TAGS,
  TERMINAL_TAG_REGEX,
  writeReview as writeSessionReview
} from "./lib/session-log.mjs";
import {
  readPendingRequestById,
  writePendingRequest,
  waitForResponse,
  clearPendingRequest,
} from "./lib/pending-requests.mjs";
import { runAutoPipeline } from "./adapters/codex/pipeline.mjs";
import { checkForUpdate, formatUpdateNotice, maybeTriggerAutoApply } from "./lib/update-check.mjs";
import {
  mapReviewVerdictToTaskVerdict,
  normalizeAdversarialReviewResult,
  normalizeNativeReviewResult
} from "./lib/review-result.mjs";
import { runIterateLoop } from "./lib/iterate-loop.mjs";
import { getSandboxEnforcementStatus, installSandboxEnforcement, uninstallSandboxEnforcement } from "./lib/sandbox-enforcement.mjs";
import { runDoctorChecks, applyDoctorAction } from "./lib/doctor-checks.mjs";
import {
  BRIDGE_CAPABILITIES,
  BRIDGE_SCHEMA_VERSION,
  BRIDGE_VERSION,
  DEFAULT_STATUS_POLL_INTERVAL_MS,
  DEFAULT_STATUS_WAIT_TIMEOUT_MS,
  EXECUTE_INSTRUCTIONS_PATH,
  MODEL_ALIASES,
  PLAN_ENFORCEMENT_PATH,
  REVIEW_SCHEMA,
  ROOT_DIR,
  SCRIPT_DIR,
  SCRIPT_PATH,
  STOP_REVIEW_GATE_LOCK_FILE,
  STOP_REVIEW_TASK_MARKER,
  VALID_REASONING_EFFORTS,
} from "./lib/runtime-paths.mjs";
import {
  ensureCodexRuntimeAdapter,
  getBridgeConfig,
  loadDeveloperInstructions,
  resolveCommandAdapter,
} from "./lib/bridge-config.mjs";
import {
  appendRenderedBriefToPrompt,
  bridgeCommand,
  buildMonitorHint,
  buildRecovery,
  extractItemText,
} from "./lib/envelope-helpers.mjs";
import { COMMANDS, EXIT_CODE_DOC, GLOBAL_FLAGS_DOC } from "./commands-meta.mjs";
import {
  buildReviewJobMetadata,
  buildTaskJob,
  buildTaskRequest,
  buildTaskRunMetadata,
  createBridgeServerRequestHandler,
  createCompanionJob,
  enqueueBackgroundTask,
  ensureCodexAvailable,
  executeReviewRun,
  extractPlanSteps,
  filterJobsForCurrentClaudeSession,
  findLatestResumableTaskJob,
  getCurrentClaudeSessionId,
  parseDurationOption,
  parsePositiveMsOption,
  persistFailureErrorInPayload,
  readTaskPrompt,
  renderQueuedTaskLaunch,
  requireTaskRequest,
  requireTaskReviewContext,
  runBridgeTask,
  runForegroundCommand,
  validateNativeReviewRequest,
  waitForSingleJobSnapshot,
} from "./lib/task-runtime.mjs";
function installSandboxEnforcementForSetup() {
  try {
    return installSandboxEnforcement();
  } catch (err) {
    throw validationError(
      err instanceof Error ? err.message : String(err),
      "SANDBOX_ENFORCEMENT_INSTALL_FAILED",
      "Fix ~/.claude/settings.json so permissions.deny is a JSON array, then rerun setup --enforce-sandbox.",
    );
  }
}

function uninstallSandboxEnforcementForSetup() {
  try {
    return uninstallSandboxEnforcement();
  } catch (err) {
    throw validationError(
      err instanceof Error ? err.message : String(err),
      "SANDBOX_ENFORCEMENT_UNINSTALL_FAILED",
      "Fix ~/.claude/settings.json so permissions.deny is a JSON array, then rerun setup --disable-sandbox-enforcement.",
    );
  }
}

function printUsage() {
  const lines = ["Usage:"];
  for (const name of Object.keys(COMMANDS)) {
    lines.push(`  codex-bridge ${COMMANDS[name].synopsis}`);
  }
  lines.push("", GLOBAL_FLAGS_DOC, "", EXIT_CODE_DOC, "", "Run `codex-bridge <subcommand> --help` for per-command details.");
  console.log(lines.join("\n"));
}

function printSubcommandUsage(name) {
  const entry = COMMANDS[name];
  if (!entry) {
    printUsage();
    return;
  }
  const lines = [
    `codex-bridge ${entry.synopsis}`,
    "",
    entry.summary
  ];
  if (entry.examples?.length) {
    lines.push("", "Examples:");
    for (const example of entry.examples) {
      lines.push(`  ${example}`);
    }
  }
  lines.push("", GLOBAL_FLAGS_DOC, "", EXIT_CODE_DOC);
  console.log(lines.join("\n"));
}

// Success output is funneled through `emitSuccess` from ./lib/cli-errors.mjs.
// Every handler captures `startedAt = Date.now()` at entry and passes it so the
// envelope can carry `meta.duration_ms`. Raw stdout writes are only for the
// human banners of send/steer/respond/version/auth-status.

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw validationError(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`,
      "INVALID_EFFORT"
    );
  }
  return normalized;
}

// Re-split argv elements that the shell didn't tokenize for us. Two shapes
// fall through here:
//
//   1. Slash-command wrappers (commands/*.md) that expand `$ARGUMENTS`
//      INTO ONE quoted argv element — the legacy single-element form.
//   2. Round-6 mixed-up form: a wrapper hard-codes some flags AND quotes
//      `$ARGUMENTS`, e.g. `setup --json "$ARGUMENTS"`. With user input
//      `--enable-review-gate --json`, the shell yields two argv elements
//      `["--json", "--enable-review-gate --json"]` — the second is a
//      collapsed flag bag that strict parseArgs would reject as an unknown
//      single flag named `"--enable-review-gate --json"`.
//
// We must NOT re-split task/adversarial-review prompt content, where a
// quoted prompt like `"write the plan"` arrives as one whitespace-bearing
// element by design. Heuristic: only re-split when the element clearly
// looks like a flag bag — its first non-whitespace character is `-`.
// Prompts almost never start with `-`; if a user really wants a leading-
// hyphen prompt they pass it after `--`. This keeps prompt fidelity for
// `task`/`adversarial-review`/`send` while fixing the flag-collapse case.
function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  const out = [];
  for (const element of argv) {
    if (typeof element === "string" && /\s/.test(element) && element.trimStart().startsWith("-")) {
      const tokens = splitRawArgumentString(element);
      if (tokens.length > 1) {
        out.push(...tokens);
        continue;
      }
    }
    out.push(element);
  }
  return out;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function resolveStopReviewGateLockPath(workspaceRoot) {
  return path.join(workspaceRoot, STOP_REVIEW_GATE_LOCK_FILE);
}

function readStopReviewGate(workspaceRoot, officialPlugin = detectOfficialOpenAICodexPlugin({ cwd: workspaceRoot })) {
  const lockPath = resolveStopReviewGateLockPath(workspaceRoot);
  let lockExists = fs.existsSync(lockPath);
  // Legacy migration: workspaces that enabled the gate before the lock-file
  // change only have `config.stopReviewGate: true` persisted in state.json.
  // Honor that intent and write the lock once so subsequent reads are
  // canonical without forcing the user to rerun setup --enable-review-gate.
  let migratedFromLegacyConfig = false;
  if (!lockExists) {
    let legacyEnabled = false;
    try {
      legacyEnabled = getConfig(workspaceRoot)?.stopReviewGate === true;
    } catch {
      legacyEnabled = false;
    }
    if (legacyEnabled) {
      try {
        fs.writeFileSync(
          lockPath,
          [
            "# Codex Bridge stop-time review gate",
            "# Presence of this file enables the Claude Code Stop hook for this project.",
            "# Migrated from legacy state.json config.stopReviewGate=true.",
            ""
          ].join("\n"),
          "utf8"
        );
        lockExists = true;
        migratedFromLegacyConfig = true;
      } catch {
        // Best-effort migration; even if the lock cannot be written we still
        // honor the user's recorded intent for this read.
        lockExists = true;
        migratedFromLegacyConfig = true;
      }
    }
  }
  const reviewGateSuppressionReason =
    officialPlugin.status === OFFICIAL_PLUGIN_STATUS.ACTIVE
      ? "official-openai-codex-plugin-active"
      : officialPlugin.status === OFFICIAL_PLUGIN_STATUS.UNKNOWN
        ? "official-openai-codex-plugin-status-unknown"
        : null;
  return {
    enabled: lockExists && reviewGateSuppressionReason == null,
    lockPath,
    lockExists,
    migratedFromLegacyConfig,
    officialOpenAICodexPluginStatus: officialPlugin.status,
    officialOpenAICodexPlugin: officialPlugin.plugin ?? null,
    officialOpenAICodexPluginDetail: officialPlugin.detail ?? null,
    reviewGateSuppressedByOfficialPlugin: officialPlugin.status === OFFICIAL_PLUGIN_STATUS.ACTIVE,
    reviewGateLockIgnored: lockExists && reviewGateSuppressionReason != null,
    reviewGateSuppressionReason
  };
}

function setStopReviewGate(workspaceRoot, enabled, officialPlugin = detectOfficialOpenAICodexPlugin({ cwd: workspaceRoot })) {
  const lockPath = resolveStopReviewGateLockPath(workspaceRoot);
  if (enabled) {
    try {
      fs.writeFileSync(
        lockPath,
        [
          "# Codex Bridge stop-time review gate",
          "# Presence of this file enables the Claude Code Stop hook for this project.",
          ""
        ].join("\n"),
        "utf8"
      );
    } catch {
      // Setup reports the lock absence; a failed gate write must not crash the
      // otherwise-useful setup health check.
    }
  } else {
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // Setup reports if the lock remains present after the removal attempt.
    }
    // Clear any legacy `config.stopReviewGate: true` persisted before the
    // lock-file rollout. Without this, readStopReviewGate's migration path
    // (lines 763-792) sees the stale flag, recreates the lock, and turns
    // disable into a no-op for users on migrated state.
    try {
      setConfig(workspaceRoot, "stopReviewGate", false);
    } catch {
      // Best-effort: if state can't be written, the lock is already gone
      // and the next read will still report the gate as disabled — only
      // workspaces that re-trigger the migration would see the flag flip
      // back. Don't fail the disable command.
    }
  }
  return readStopReviewGate(workspaceRoot, officialPlugin);
}

function applyStopReviewGateSnapshot(snapshot) {
  const gate = readStopReviewGate(snapshot.workspaceRoot);
  return {
    ...snapshot,
    officialOpenAICodexPluginStatus: gate.officialOpenAICodexPluginStatus,
    officialOpenAICodexPlugin: gate.officialOpenAICodexPlugin,
    officialOpenAICodexPluginDetail: gate.officialOpenAICodexPluginDetail,
    reviewGateSuppressedByOfficialPlugin: gate.reviewGateSuppressedByOfficialPlugin,
    reviewGateLockIgnored: gate.reviewGateLockIgnored,
    reviewGateSuppressionReason: gate.reviewGateSuppressionReason,
    config: {
      ...snapshot.config,
      stopReviewGate: gate.enabled,
      stopReviewGateLockPath: gate.lockPath,
      stopReviewGateLockExists: gate.lockExists,
      officialOpenAICodexPluginStatus: gate.officialOpenAICodexPluginStatus,
      reviewGateSuppressedByOfficialPlugin: gate.reviewGateSuppressedByOfficialPlugin,
      reviewGateLockIgnored: gate.reviewGateLockIgnored,
      reviewGateSuppressionReason: gate.reviewGateSuppressionReason
    },
    needsReview: gate.enabled
  };
}
async function buildSetupReport(cwd, actionsTaken = [], options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const officialPlugin = options.officialPlugin ?? detectOfficialOpenAICodexPlugin({ cwd });
  const reviewGate = readStopReviewGate(workspaceRoot, officialPlugin);
  const adapter = await resolveCommandAdapter({ cwd, workspaceRoot });
  const sandboxEnforcement = getSandboxEnforcementStatus();

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (reviewGate.reviewGateSuppressedByOfficialPlugin) {
    nextSteps.push("Use the official OpenAI Codex plugin for stop-time review; Codex Bridge review gate is disabled while it is enabled.");
  } else if (reviewGate.reviewGateSuppressionReason === "official-openai-codex-plugin-status-unknown") {
    nextSteps.push("Codex Bridge could not verify whether the official OpenAI Codex plugin is active, so it will not enable a duplicate stop-time review gate.");
  } else if (!reviewGate.enabled) {
    nextSteps.push("Optional: run `codex-bridge setup --enable-review-gate` to create a project lock file for stop-time review.");
  }
  if (sandboxEnforcement.settingsParseError) {
    nextSteps.push(`Sandbox enforcement status could not read ${sandboxEnforcement.settingsPath}: ${sandboxEnforcement.settingsParseError}.`);
  } else if (!sandboxEnforcement.installed) {
    nextSteps.push("Optional: run `codex-bridge setup --enforce-sandbox` to deny sandbox downgrades at the Claude permission layer.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    active_backend: adapter.name,
    adapter_capabilities: adapter.capabilities(),
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: reviewGate.enabled,
    reviewGateLockPath: reviewGate.lockPath,
    reviewGateLockExists: reviewGate.lockExists,
    officialOpenAICodexPluginStatus: reviewGate.officialOpenAICodexPluginStatus,
    officialOpenAICodexPlugin: reviewGate.officialOpenAICodexPlugin,
    officialOpenAICodexPluginDetail: reviewGate.officialOpenAICodexPluginDetail,
    reviewGateSuppressedByOfficialPlugin: reviewGate.reviewGateSuppressedByOfficialPlugin,
    reviewGateLockIgnored: reviewGate.reviewGateLockIgnored,
    reviewGateSuppressionReason: reviewGate.reviewGateSuppressionReason,
    sandboxEnforcementInstalled: sandboxEnforcement.installed,
    sandboxEnforcementSettingsPath: sandboxEnforcement.settingsPath,
    sandboxEnforcementSettingsExists: sandboxEnforcement.settingsExists,
    sandboxEnforcementSettingsParseError: sandboxEnforcement.settingsParseError,
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate", "enforce-sandbox", "disable-sandbox-enforcement"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw conflictError(
      "Choose either --enable-review-gate or --disable-review-gate.",
      "REVIEW_GATE_CONFLICT"
    );
  }
  if (options["enforce-sandbox"] && options["disable-sandbox-enforcement"]) {
    throw conflictError(
      "Choose either --enforce-sandbox or --disable-sandbox-enforcement.",
      "SANDBOX_ENFORCEMENT_CONFLICT"
    );
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];
  const officialPlugin = detectOfficialOpenAICodexPlugin({ cwd, maxAgeMs: 0 });

  if (options["enable-review-gate"]) {
    if (officialPlugin.status === OFFICIAL_PLUGIN_STATUS.ABSENT) {
      const reviewGate = setStopReviewGate(workspaceRoot, true, officialPlugin);
      if (reviewGate.enabled && reviewGate.lockExists) {
        actionsTaken.push(`Enabled the project stop-time review gate via ${reviewGate.lockPath}.`);
      } else {
        actionsTaken.push(
          `Failed to create the stop-time review gate lock at ${reviewGate.lockPath}; the gate is NOT enabled. Check write permissions on the git project root, then rerun \`codex-bridge setup --enable-review-gate\`.`
        );
      }
    } else if (officialPlugin.status === OFFICIAL_PLUGIN_STATUS.ACTIVE) {
      actionsTaken.push("Skipped enabling the Codex Bridge stop-time review gate because the official OpenAI Codex plugin is enabled.");
    } else {
      actionsTaken.push("Skipped enabling the Codex Bridge stop-time review gate because the official OpenAI Codex plugin status could not be verified.");
    }
  } else if (options["disable-review-gate"]) {
    const reviewGate = setStopReviewGate(workspaceRoot, false, officialPlugin);
    if (reviewGate.lockExists) {
      actionsTaken.push(
        `Failed to remove the stop-time review gate lock at ${reviewGate.lockPath}; the gate is still active. Please remove the lock file manually.`
      );
    } else {
      actionsTaken.push(
        `Disabled the project stop-time review gate by removing ${reviewGate.lockPath}.`
      );
    }
  }

  if (options["enforce-sandbox"]) {
    const result = installSandboxEnforcementForSetup();
    actionsTaken.push(
      result.alreadyInstalled
        ? `Sandbox enforcement deny rules already present in ${result.status.settingsPath}.`
        : `Installed sandbox enforcement deny rules in ${result.status.settingsPath}.`
    );
  } else if (options["disable-sandbox-enforcement"]) {
    const result = uninstallSandboxEnforcementForSetup();
    actionsTaken.push(
      result.removed > 0
        ? `Removed ${result.removed} sandbox enforcement deny rule${result.removed === 1 ? "" : "s"} from ${result.status.settingsPath}.`
        : `Sandbox enforcement deny rules were not present in ${result.status.settingsPath}.`
    );
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken, { officialPlugin });
  emitSuccess("setup", finalReport, renderSetupReport(finalReport), {
    json: options.json,
    startedAt
  });
}

async function handleVersion(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "backend"],
    booleanOptions: ["json", "check-update"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const adapter = await resolveCommandAdapter({ cwd, workspaceRoot, backend: options.backend });
  const codex = getCodexAvailability(cwd);

  // `version --check-update` forces a fresh GitHub round-trip; the bare
  // `version` call reads the cached result so it stays cheap (no network).
  const update = await checkForUpdate({
    currentVersion: BRIDGE_VERSION,
    force: Boolean(options["check-update"]),
  });

  const payload = {
    version: BRIDGE_VERSION,
    schema_version: BRIDGE_SCHEMA_VERSION,
    node_version: process.version,
    codex: {
      available: codex.available,
      detail: codex.detail ?? null
    },
    capabilities: [...BRIDGE_CAPABILITIES],
    active_backend: adapter.name,
    adapter_capabilities: adapter.capabilities(),
    update: {
      latest_version: update.latestVersion ?? null,
      has_update: Boolean(update.hasUpdate),
      checked_at_age_ms: update.cacheAgeMs ?? null,
      check_skipped: Boolean(update.skipped),
      check_skip_reason: update.reason ?? null,
    }
  };

  const updateLine = formatUpdateNotice(update);
  const rendered = [
    `codex-bridge ${payload.version} (schema ${payload.schema_version})`,
    `  node:  ${payload.node_version}`,
    `  codex: ${codex.available ? (codex.detail ?? "available") : "not installed"}`,
    `  backend: ${payload.active_backend}`,
    `  caps:  ${payload.capabilities.join(", ")}`,
    updateLine ? `  update: ${updateLine}` : `  update: up to date${update.latestVersion ? ` (latest ${update.latestVersion})` : ""}`
  ].join("\n") + "\n";

  emitSuccess("version", payload, rendered, { json: options.json, startedAt });
}

// `bridge config show` — surfaces the effective merged config and every
// source it was built from. Invaluable for debugging "I set X in my
// config.yaml, why isn't it taking effect?" situations. The layered
// resolution (DEFAULT_CONFIG < skill-dir < workspaceRoot < cwd) is
// otherwise opaque.
//
// Actions: show [<key-glob>] | set <key>=<value> | reset [<key>] |
//          explain <key> | path | validate | template
async function handleConfig(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "lenient"]
  });
  const action = positionals[0] ?? "show";
  const SUPPORTED_ACTIONS = ["show", "set", "reset", "explain", "path", "validate", "template"];
  if (!SUPPORTED_ACTIONS.includes(action)) {
    throw usageError(
      `config: unknown action '${action}'. Supported: ${SUPPORTED_ACTIONS.join(", ")}.`
    );
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);

  // ── show ─────────────────────────────────────────────────────────────────
  if (action === "show") {
    const sources = resolveConfigSources(ROOT_DIR, cwd, workspaceRoot);
    const effective = getBridgeConfig(cwd, workspaceRoot);
    const diagnostics = validateConfigLayers(ROOT_DIR, cwd, workspaceRoot);
    const layers = resolveConfigLayers(ROOT_DIR, cwd, workspaceRoot);

    // Build per-key provenance: highest-priority layer that set the key wins.
    const provenance = {};
    for (const k of Object.keys(effective)) {
      if (Object.prototype.hasOwnProperty.call(layers.cwdConfig, k)) {
        provenance[k] = "cwd config.yaml";
      } else if (Object.prototype.hasOwnProperty.call(layers.workspaceConfig, k)) {
        provenance[k] = "workspace-root config.yaml";
      } else if (Object.prototype.hasOwnProperty.call(layers.skillConfig, k)) {
        provenance[k] = "skill-dir config.yaml";
      } else {
        provenance[k] = "plugin defaults";
      }
    }

    // Diff against defaults so the caller can see which keys were overridden.
    const overrides = {};
    for (const [k, v] of Object.entries(effective)) {
      if (JSON.stringify(DEFAULT_CONFIG[k]) !== JSON.stringify(v)) {
        overrides[k] = v;
      }
    }

    const payload = {
      sources: {
        defaults: "(built into src/lib/config.mjs::DEFAULT_CONFIG)",
        skill_config_path: sources.skillConfigPath,
        skill_config_exists: sources.skillConfigExists,
        workspace_config_path: sources.workspaceConfigPath,
        workspace_config_exists: sources.workspaceConfigExists,
        override_config_path: sources.overrideConfigPath,
        override_config_exists: sources.overrideConfigExists,
      },
      effective_config: effective,
      overrides_vs_defaults: overrides,
      provenance,
      diagnostics,
      warnings: diagnostics.filter((d) => d.severity === "warning"),
      errors: diagnostics.filter((d) => d.severity === "error"),
      precedence_order_low_to_high: [
        "DEFAULT_CONFIG",
        "skill-dir config.yaml",
        "workspace-root config.yaml",
        "cwd config.yaml",
      ],
    };

    const linePresence = (p, ok) =>
      p ? `${p} (${ok ? "present" : "not found"})` : "(n/a — cwd == workspace root)";
    const lines = [
      "Config resolution (lowest → highest precedence):",
      `  1. built-in defaults — src/lib/config.mjs::DEFAULT_CONFIG`,
      `  2. skill-dir         — ${linePresence(sources.skillConfigPath, sources.skillConfigExists)}`,
      `  3. workspace-root    — ${linePresence(sources.workspaceConfigPath, sources.workspaceConfigExists)}`,
      `  4. cwd               — ${linePresence(sources.overrideConfigPath, sources.overrideConfigExists)}`,
      "",
      "Effective config:",
    ];
    const globPattern = positionals[1];
    for (const [k, v] of Object.entries(effective)) {
      if (globPattern && !k.includes(globPattern.replace(/\*/g, ""))) continue;
      const marker = Object.prototype.hasOwnProperty.call(overrides, k) ? "*" : " ";
      const preview = typeof v === "string" && v.length > 70 ? `${v.slice(0, 67)}...` : JSON.stringify(v);
      const src = provenance[k] ? `  # ← ${provenance[k]}` : "";
      lines.push(`  ${marker} ${k}: ${preview}${src}`);
    }
    if (Object.keys(overrides).length > 0) {
      lines.push("", "* = differs from DEFAULT_CONFIG");
    }
    if (diagnostics.length > 0) {
      lines.push("", "Diagnostics:");
      for (const diagnostic of diagnostics) {
        lines.push(`  ${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.source}:${diagnostic.key ?? "(file)"} — ${diagnostic.message}`);
      }
    }
    const rendered = `${lines.join("\n")}\n`;
    emitSuccess("config", payload, rendered, { json: options.json, startedAt });
    return;
  }

  // ── path ──────────────────────────────────────────────────────────────────
  if (action === "path") {
    const filePath = resolveLocalConfigPath(workspaceRoot);
    const exists = fs.existsSync(filePath);
    const payload = { path: filePath, exists };
    const rendered = `${filePath}${exists ? "" : " (does not exist yet)"}\n`;
    emitSuccess("config", payload, rendered, { json: options.json, startedAt });
    return;
  }

  // ── template ──────────────────────────────────────────────────────────────
  if (action === "template") {
    const template = serializeLocalConfig({}, getDefaultLocalConfigBody());
    const payload = { template };
    emitSuccess("config", payload, template, { json: options.json, startedAt });
    return;
  }

  // ── explain ───────────────────────────────────────────────────────────────
  if (action === "explain") {
    const key = positionals[1];
    if (!key) {
      throw usageError("config explain: missing key. Usage: config explain <key>");
    }
    const doc = CONFIG_KEY_DOCS[key];
    if (!doc) {
      throw usageError(
        `config explain: unknown key '${key}'. Known keys: ${Object.keys(CONFIG_SCHEMA).join(", ")}.`
      );
    }
    const payload = { key, doc, valid_values: CONFIG_SCHEMA[key] };
    const rendered = `${key}:\n  ${doc}\n`;
    emitSuccess("config", payload, rendered, { json: options.json, startedAt });
    return;
  }

  // ── validate ──────────────────────────────────────────────────────────────
  if (action === "validate") {
    const local = readLocalConfig(workspaceRoot);
    if (!local.exists) {
      const payload = { valid: true, path: local.filePath, exists: false, diagnostics: [] };
      const rendered = `No local config found at ${local.filePath} — nothing to validate.\n`;
      emitSuccess("config", payload, rendered, { json: options.json, startedAt });
      return;
    }
    if (local.parseError) {
      const payload = {
        valid: false,
        path: local.filePath,
        exists: true,
        diagnostics: [{ severity: "error", code: "CONFIG_PARSE_ERROR", message: local.parseError }],
      };
      const rendered = `ERROR: Could not parse ${local.filePath}: ${local.parseError}\n`;
      emitSuccess("config", payload, rendered, { json: options.json, startedAt });
      return;
    }
    const diagnostics = [];
    for (const [k, v] of Object.entries(local.frontmatter)) {
      const schema = CONFIG_SCHEMA[k];
      if (!schema) {
        diagnostics.push({
          severity: "warning",
          code: "CONFIG_UNKNOWN_KEY",
          key: k,
          message: `Unknown config key '${k}' — will be ignored by the bridge runtime.`,
        });
        continue;
      }
      // Validate the stored JS value per schema type.
      const valid = (
        schema.type === "boolean" ? typeof v === "boolean" :
        schema.type === "positive-number" ? (typeof v === "number" && v > 0) :
        schema.type === "enum" ? (typeof v === "string" && schema.values.includes(v)) :
        schema.type === "string" ? typeof v === "string" :
        schema.type === "object" ? (v && typeof v === "object" && !Array.isArray(v)) :
        true
      );
      if (!valid) {
        const hint = schema.type === "enum"
          ? `expected one of: ${schema.values.join(", ")}`
          : `expected ${schema.type}`;
        diagnostics.push({
          severity: "error",
          code: "CONFIG_INVALID_VALUE",
          key: k,
          message: `Invalid value for '${k}' (${JSON.stringify(v)}); ${hint}.`,
        });
      }
    }
    const valid = !diagnostics.some((d) => d.severity === "error");
    const payload = { valid, path: local.filePath, exists: true, diagnostics };
    let rendered;
    if (diagnostics.length === 0) {
      rendered = `OK — ${local.filePath} is valid.\n`;
    } else {
      const lines = [`${valid ? "WARNINGS" : "ERRORS"} in ${local.filePath}:`];
      for (const d of diagnostics) {
        lines.push(`  ${d.severity.toUpperCase()} ${d.code} ${d.key ?? ""} — ${d.message}`);
      }
      rendered = `${lines.join("\n")}\n`;
    }
    emitSuccess("config", payload, rendered, { json: options.json, startedAt });
    return;
  }

  // ── set ───────────────────────────────────────────────────────────────────
  if (action === "set") {
    const assignment = positionals[1];
    if (!assignment || !assignment.includes("=")) {
      throw usageError(
        "config set: expected <key>=<value>. Example: config set mode=default"
      );
    }
    const eqIdx = assignment.indexOf("=");
    const key = assignment.slice(0, eqIdx);
    const rawValue = assignment.slice(eqIdx + 1);

    if (!CONFIG_SCHEMA[key]) {
      throw usageError(
        `config set: unknown key '${key}'. Known keys: ${Object.keys(CONFIG_SCHEMA).join(", ")}.`
      );
    }

    const parsed = parseConfigValue(key, rawValue);
    if (!parsed.ok && !options.lenient) {
      throw usageError(`config set: ${parsed.error}`);
    }
    const value = parsed.ok ? parsed.value : rawValue;

    const local = readLocalConfig(workspaceRoot);
    if (local.parseError) {
      throw usageError(
        `config set: cannot write — ${local.filePath} has a YAML parse error: ${local.parseError}`
      );
    }
    const previousValue = local.frontmatter[key];
    local.frontmatter[key] = value;
    const writtenPath = writeLocalConfig(workspaceRoot, local.frontmatter, local.body);

    const payload = {
      key,
      value,
      previous_value: previousValue ?? null,
      path: writtenPath,
      requires_restart: true,
    };
    const prevStr = previousValue !== undefined ? JSON.stringify(previousValue) : "(unset)";
    const rendered = [
      `Set ${key} = ${JSON.stringify(value)} (was ${prevStr}).`,
      `Wrote to: ${writtenPath}`,
      `NOTE: Hooks load at session start — restart Claude Code to apply this change.`,
    ].join("\n") + "\n";
    emitSuccess("config", payload, rendered, { json: options.json, startedAt });
    return;
  }

  // ── reset ─────────────────────────────────────────────────────────────────
  if (action === "reset") {
    const key = positionals[1];
    const local = readLocalConfig(workspaceRoot);
    if (local.parseError) {
      throw usageError(
        `config reset: cannot write — ${local.filePath} has a YAML parse error: ${local.parseError}`
      );
    }
    let removed;
    if (key) {
      if (!Object.prototype.hasOwnProperty.call(local.frontmatter, key)) {
        const payload = { key, removed: false, path: local.filePath };
        const rendered = `Key '${key}' was not set in ${local.filePath} — nothing to reset.\n`;
        emitSuccess("config", payload, rendered, { json: options.json, startedAt });
        return;
      }
      removed = { [key]: local.frontmatter[key] };
      delete local.frontmatter[key];
    } else {
      removed = { ...local.frontmatter };
      local.frontmatter = {};
    }
    const writtenPath = writeLocalConfig(workspaceRoot, local.frontmatter, local.body);
    const payload = {
      key: key ?? null,
      removed,
      path: writtenPath,
      requires_restart: true,
    };
    const what = key ? `key '${key}'` : "all keys";
    const rendered = [
      `Reset ${what} in ${writtenPath}.`,
      `NOTE: Hooks load at session start — restart Claude Code to apply this change.`,
    ].join("\n") + "\n";
    emitSuccess("config", payload, rendered, { json: options.json, startedAt });
    return;
  }
}

// Check for updates and print a human-readable verdict plus the one-command
// install recipe. Pass --force to bypass the cache. Never mutates the
// installed skill itself —
// updates land via `npx skills …` from the user's shell, not from inside
// the bridge. This keeps the bridge's blast radius tight (no self-modify)
// and means a failed update check is always recoverable: try again later.
async function handleUpdate(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "force", "apply", "yes"]
  });

  const update = await checkForUpdate({
    currentVersion: BRIDGE_VERSION,
    force: Boolean(options.force),
  });

  const installCommand = "npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y";
  const wantApply = Boolean(options.apply || options.yes);

  // --apply path: detect newer → actually install via npx skills-add.
  // Default behavior (no flag) remains detect-only, so callers that
  // depend on the envelope shape don't see install side-effects they
  // didn't ask for.
  if (wantApply && update.hasUpdate && update.latestVersion) {
    const applyResult = runSkillsAddForApply(options.json);
    const payload = {
      current_version: BRIDGE_VERSION,
      latest_version: update.latestVersion ?? null,
      has_update: true,
      update_check: {
        cached: Boolean(update.cached),
        skipped: Boolean(update.skipped),
        reason: update.reason ?? null,
        fetch_reason: update.fetchReason ?? null,
        fetch_status: update.fetchStatus ?? null,
        cache_age_ms: update.cacheAgeMs ?? null,
      },
      apply: {
        requested: true,
        command: applyResult.command,
        ok: applyResult.ok,
        exit_code: applyResult.exitCode,
        error: applyResult.error,
        timed_out: Boolean(applyResult.timedOut),
      },
      applied: applyResult.ok,
      apply_exit_code: applyResult.exitCode,
      apply_error: applyResult.error,
      install_command: installCommand,
    };
    const rendered = applyResult.ok
      ? `Installed codex-bridge ${update.latestVersion} (was ${BRIDGE_VERSION}). Re-invoke the skill to pick up the new files.\n`
      : `Attempted to install ${update.latestVersion} (from ${BRIDGE_VERSION}) but the installer exited ${applyResult.exitCode}.\n` +
        (applyResult.error ? `  ${applyResult.error}\n` : "") +
        `Re-run manually: ${installCommand}\n`;
    if (applyResult.ok) {
      emitSuccess("update", payload, rendered, { json: options.json, startedAt });
    } else {
      // Non-zero install exit surfaces as a dependency_failed error so
      // callers can branch on $? without parsing stdout.
      const err = new CliError(
        applyResult.timedOut ? "skills installer timed out" : `skills installer exited ${applyResult.exitCode}`,
        {
          class: "dependency_failed",
          code: "UPDATE_APPLY_FAILED",
          retryable: true,
          suggestion: `Re-run manually: ${installCommand}`,
          details: {
            command: applyResult.command,
            exitCode: applyResult.exitCode,
            error: applyResult.error,
            timedOut: Boolean(applyResult.timedOut),
          },
          nextAction: {
            kind: "manual-update",
            command: installCommand,
            description: "Run the installer manually after checking npm/network availability.",
          },
        }
      );
      emitError(err, { json: options.json, command: "update" });
    }
    return;
  }

  const payload = {
    current_version: BRIDGE_VERSION,
    latest_version: update.latestVersion ?? null,
    has_update: Boolean(update.hasUpdate),
    update_check: {
      cached: Boolean(update.cached),
      skipped: Boolean(update.skipped),
      reason: update.reason ?? null,
      fetch_reason: update.fetchReason ?? null,
      fetch_status: update.fetchStatus ?? null,
      cache_age_ms: update.cacheAgeMs ?? null,
    },
    apply: {
      requested: wantApply,
      skipped: wantApply ? (update.hasUpdate ? null : "no-update") : "not-requested",
      command: installCommand,
    },
    check_skipped: Boolean(update.skipped),
    check_skip_reason: update.reason ?? null,
    fetch_reason: update.fetchReason ?? null,
    fetch_status: update.fetchStatus ?? null,
    install_command: installCommand,
    // --apply was requested but nothing to install: echo back the intent
    // so scripted callers can tell "no action taken" from "skipped".
    applied: wantApply && !update.hasUpdate ? false : null,
  };

  let rendered;
  if (update.skipped && !update.latestVersion) {
    rendered = renderUpdateFailureHint(update, BRIDGE_VERSION);
  } else if (update.hasUpdate) {
    rendered =
      `codex-bridge ${update.latestVersion} available (you have ${BRIDGE_VERSION}).\n` +
      `To update, run:\n  ${installCommand}\n` +
      `Or rerun with --apply to install automatically.\n`;
  } else {
    rendered = `codex-bridge is up to date (${BRIDGE_VERSION}${update.latestVersion ? `, latest ${update.latestVersion}` : ""}).\n`;
  }

  emitSuccess("update", payload, rendered, { json: options.json, startedAt });
}

// Spawns `npx -y skills@latest add yigitkonur/codex-bridge -a claude-code
// -g -y` to install the latest release. Blocks until exit. stdout/stderr
// inherit the current terminal unless --json was requested, in which case
// they're captured and any progress is discarded (installer chatter would
// corrupt the JSON envelope). Returns the exit-code shape the caller
// branches on.
function runSkillsAddForApply(jsonMode) {
  const command = "npx -y skills@latest add yigitkonur/codex-bridge -a claude-code -g -y";
  const timeoutMs = 600_000;
  try {
    const result = spawnSync(
      "npx",
      ["-y", "skills@latest", "add", "yigitkonur/codex-bridge", "-a", "claude-code", "-g", "-y"],
      {
        stdio: jsonMode ? ["ignore", "pipe", "pipe"] : "inherit",
        encoding: "utf8",
        timeout: timeoutMs,
      }
    );
    if (result.error) {
      return {
        ok: false,
        exitCode: null,
        error: result.error.code === "ENOENT"
          ? "npx not found on PATH; install Node.js to get npx"
          : result.error.code === "ETIMEDOUT"
            ? `skills installer timed out after ${Math.round(timeoutMs / 1000)}s`
            : result.error.message,
        command,
        timedOut: result.error.code === "ETIMEDOUT",
      };
    }
    if (result.status !== 0) {
      const stderrTail = typeof result.stderr === "string" ? result.stderr.trim().split("\n").slice(-3).join("\n") : null;
      return { ok: false, exitCode: result.status, error: stderrTail || null, command, timedOut: false };
    }
    return { ok: true, exitCode: 0, error: null, command, timedOut: false };
  } catch (err) {
    return { ok: false, exitCode: null, error: err?.message ?? String(err), command, timedOut: false };
  }
}

// Renders a diagnostic hint for "couldn't reach upstream" failures. With
// a public repo and anonymous-only fetch, the remaining failure modes
// are network hiccups and GitHub rate-limit blips — both transient.
function renderUpdateFailureHint(update, currentVersion) {
  const reason = update.fetchReason ?? update.reason ?? "unknown";
  const lines = [`Update check failed (current: ${currentVersion}, reason: ${reason}).`];
  if (reason === "timeout" || reason === "network") {
    lines.push("Network error reaching api.github.com. Retry in a moment.");
  } else if (update.fetchStatus === 403) {
    lines.push("GitHub returned 403 — likely the anonymous 60/hr rate limit. Wait an hour or re-run from a different IP.");
  } else if (update.fetchStatus === 404) {
    lines.push("GitHub returned 404. Re-run with --force; if it persists, the release endpoint may be temporarily unreachable.");
  } else {
    lines.push("Retry with --force; if it persists, check network connectivity to api.github.com.");
  }
  return lines.join("\n") + "\n";
}

async function handleAuthStatus(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const auth = await getCodexAuthStatus(cwd);

  const status = auth.loggedIn ? "logged in" : "not logged in";
  const provider = auth.provider ? ` via ${auth.provider}` : "";
  const lines = [`Auth: ${status}${provider}.`];
  if (auth.detail) lines.push(`  ${auth.detail}`);
  if (!auth.loggedIn && auth.requiresOpenaiAuth) {
    lines.push("  → Run `codex login` (or `codex login --device-auth`).");
  }
  emitSuccess("auth-status", auth, `${lines.join("\n")}\n`, {
    json: options.json,
    startedAt
  });
}

function buildMachineReadableHelp() {
  return {
    version: BRIDGE_VERSION,
    schema_version: BRIDGE_SCHEMA_VERSION,
    commands: Object.entries(COMMANDS).map(([name, entry]) => ({
      name,
      synopsis: `codex-bridge ${entry.synopsis}`,
      summary: entry.summary,
      examples: entry.examples ?? []
    })),
    global_flags: [
      { flag: "--json", alias: "-j", description: "Machine-readable output (error envelope on failure)." },
      { flag: "--cwd <dir>", alias: "-C", description: "Override the working directory." },
      { flag: "--help", alias: "-h", description: "Show per-subcommand help and exit." }
    ],
    exit_codes: {
      0: "success",
      1: "crash / unhandled internal error",
      2: "usage (unknown subcommand, unknown flag, missing argument)",
      3: "not_found (job, thread, resource)",
      4: "auth (run `codex login`)",
      5: "conflict (already running, state mismatch)",
      6: "validation (bad input)",
      7: "transient (timeout, network, rate-limit) — retry with backoff",
      8: "partial_success (check result details)"
    }
  };
}
async function handleReviewCommand(argv, config) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd", "backend", "brief", "task"],
    repeatableValueOptions: ["concern"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const taskReview = options.task ? requireTaskReviewContext(options.task, options) : null;
  const cwd = taskReview?.cwd ?? resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const adapter = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    backend: options.backend ?? null,
  });
  ensureCodexRuntimeAdapter(adapter);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: taskReview?.base ?? options.base,
    scope: taskReview?.scope ?? options.scope
  });

  // --brief and --concern populate the {{OPUS_CONCERNS}} channel in the
  // adversarial-review prompt (T26). Native `review` ignores them — its
  // prompt is built by the Codex app-server. validateRequest will reject
  // the flags for native review below if the orchestrator passes them.
  let brief = null;
  if (options.brief) {
    const result = loadBrief(options.brief, { baseDir: cwd });
    if (!result.ok) {
      throw new CliError(result.message, {
        code: result.code,
        class: result.code === "BRIEF_FILE_NOT_FOUND" ? "not_found" : "validation",
        details: result.details,
        suggestion: result.code === "BRIEF_SCHEMA_VIOLATION"
          ? "Fix the brief JSON to match the schema. Common valid top-level keys are goal, worker_assignment, specific_concerns, acceptance_criteria, behavior_digest_seed, parent_task_id, backend_hint, iteration_max, and trust_budget_override."
          : undefined,
      });
    }
    brief = result.brief;
  }
  const opusConcerns = Array.isArray(options.concern)
    ? options.concern
    : options.concern
      ? [options.concern]
      : [];

  config.validateRequest?.(target, focusText, { brief, opusConcerns });
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: taskReview?.base ?? options.base,
        scope: taskReview?.scope ?? options.scope,
        model: options.model,
        backend: options.backend ?? null,
        focusText,
        brief,
        opusConcerns,
        reviewName: config.reviewName,
        taskId: taskReview?.taskId ?? null,
        reviewedBranchHeadSha: taskReview?.reviewedBranchHeadSha ?? null,
        onProgress: progress
      }),
    {
      json: options.json,
      startedAt,
      command: config.reviewName === "Adversarial Review" ? "adversarial-review" : "review"
    }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

// ── BRIDGE ORCHESTRATION ──────────────────────────────────────────────────
// This is the integration layer that connects all building blocks.
// It wraps executeTaskRun with: config, session logging, question handling,
// timeout, and auto-pipeline.
async function handleTask(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [
      "model", "effort", "cwd", "prompt-file", "mode", "backend",
      "group",
      "idle-timeout-ms",
      "turn-plan-ms", "turn-default-ms",
      "pipeline-stage-timeout-ms", "pipeline-total-timeout-ms",
      "question-timeout-ms",
      "brief", "intercepted-from", "group"
    ],
    booleanOptions: ["json", "write", "read-only", "resume-last", "resume", "fresh", "background", "no-pipeline", "quiet", "worktree-auto", "rewake-on-terminal", "legacy-envelope"],
    aliasMap: {
      m: "model"
    }
  });

  const VALID_MODES = new Set(["plan", "default"]);
  if (options.mode != null && !VALID_MODES.has(options.mode)) {
    throw usageError(`mode must be plan or default, got ${JSON.stringify(options.mode)}`);
  }

  // Resolve every timeout-flag up front so callers see usage errors for
  // malformed values instead of silent fallback. Every unset flag is null,
  // letting runBridgeTask / runAutoPipeline fall through to config.yaml →
  // built-in default.
  const idleTimeoutOverride = parsePositiveMsOption("--idle-timeout-ms", options["idle-timeout-ms"]);
  const turnPlanOverride = parsePositiveMsOption("--turn-plan-ms", options["turn-plan-ms"]);
  const turnDefaultOverride = parsePositiveMsOption("--turn-default-ms", options["turn-default-ms"]);
  const pipelineStageOverride = parsePositiveMsOption("--pipeline-stage-timeout-ms", options["pipeline-stage-timeout-ms"]);
  const pipelineTotalOverride = parsePositiveMsOption("--pipeline-total-timeout-ms", options["pipeline-total-timeout-ms"]);
  const questionTimeoutOverride = parsePositiveMsOption("--question-timeout-ms", options["question-timeout-ms"]);
  const noPipeline = Boolean(options["no-pipeline"]);
  const group = options.group != null ? String(options.group).trim() : null;
  if (options.group != null && !group) {
    throw usageError("--group requires a non-empty name.");
  }
  // `--json` implies `--quiet` unless the caller explicitly passes `--quiet=false`.
  // Rationale: `--json` signals machine consumption; the stderr `[codex] Thread
  // ready (<uuid>)` progress line is a UUID-trap that agents regex-match out
  // and then target with `send/respond`, confusing the returned threadId.
  // Explicit `--quiet=false` preserves a human-watching-json flow if anyone
  // actually wants it.
  const quietMode = Boolean(options.quiet) || (Boolean(options.json) && options.quiet !== false);

  let cwd = resolveCommandCwd(options);
  const stateCwd = cwd;
  const workspaceRoot = resolveCommandWorkspace(options);

  // --brief @path.json | <inline-json> loads + validates the structured
  // brief (T16) and persists it verbatim (brief.json + brief.md) into
  // the per-task registry directory alongside meta.json. Persisting the
  // brief is the v2 mechanism by which the original intent is recovered
  // by review / iterate even if the prompt template later changes.
  //
  // Both --brief and --intercepted-from currently require --worktree-auto
  // because the registry directory is only created when a worktree is
  // dispatched (T15 wiring). Passing them without --worktree-auto would
  // silently discard the value, so we fail loudly instead. The validated
  // brief is also appended to the worker prompt before dispatch, so Codex
  // sees the structured assignment instead of only an on-disk artifact.
  let brief = null;
  let briefHash = null;
  let briefSource = null;
  if (options.brief || options["intercepted-from"]) {
    if (!options["worktree-auto"]) {
      throw conflictError(
        "--brief and --intercepted-from require --worktree-auto (the registry slot that stores brief.json / intercepted_from is created by the worktree path).",
        "BRIEF_REQUIRES_WORKTREE_AUTO",
      );
    }
  }
  if (options.brief) {
    const result = loadBrief(options.brief, { baseDir: cwd });
    if (!result.ok) {
      throw new CliError(result.message, {
        code: result.code,
        class: result.code === "BRIEF_FILE_NOT_FOUND" ? "not_found" : "validation",
        details: result.details,
        suggestion: result.code === "BRIEF_SCHEMA_VIOLATION"
          ? "Fix the brief JSON to match the schema. Common valid top-level keys are goal, worker_assignment, specific_concerns, acceptance_criteria, behavior_digest_seed, parent_task_id, backend_hint, iteration_max, and trust_budget_override."
          : undefined,
      });
    }
    brief = result.brief;
    briefHash = result.briefHash;
    briefSource = result.source ?? options.brief;
  }

  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw conflictError(
      "Choose either --resume/--resume-last or --fresh.",
      "RESUME_FRESH_CONFLICT"
    );
  }
  if (resumeLast && options["worktree-auto"]) {
    throw conflictError(
      "--resume/--resume-last resumes a Codex thread only and cannot safely create a fresh worktree. Use `iterate <task_id>` to continue task worktree state, or start a fresh `task --write --worktree-auto` from the current branch.",
      "RESUME_WORKTREE_CONFLICT",
      "Use `codex-bridge iterate <task_id>` for follow-up fixes, or drop --resume-last and dispatch a fresh worktree task."
    );
  }
  // Fail fast before `runBridgeTask` can append `prompt_footer` to an empty prompt
  // and spend a billed Codex turn. Mirrors the check the --background path already does.
  requireTaskRequest(prompt, resumeLast);
  const write = Boolean(options.write);
  // `--read-only` forces sandboxPolicy: { type: "readOnly" } regardless of
  // `config.sandbox_policy` (including `danger-full-access`). Mutually
  // exclusive with `--write` — that combination is incoherent. Used by the
  // stop-time review-gate hook to ensure stop-hook reviews never mutate the
  // repo even when the user has opted into a wide-open default policy.
  const readOnly = Boolean(options["read-only"]);
  if (write && readOnly) {
    throw conflictError(
      "Choose either --write or --read-only, not both.",
      "WRITE_READ_ONLY_CONFLICT"
    );
  }
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });
  const adapter = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    backend: options.backend ?? null,
    taskMetadata,
  });
  ensureCodexRuntimeAdapter(adapter);

  const job = buildTaskJob(workspaceRoot, taskMetadata, write, {
    backend: adapter.name,
    adapterCapabilities: adapter.capabilities(),
    group,
  });

  // --worktree-auto isolates write-mode tasks inside a per-task worktree
  // at <repoRoot>/../.codex-bridge-worktrees/<job_id> on a branch named
  // subagent/codex/<job_id>. Validate the full task request before creating
  // git state; after this point, cwd is execution-only and state stays anchored
  // to stateCwd/workspaceRoot so result/status/events keep finding the job.
  let worktreeInfo = null;
  if (options["worktree-auto"]) {
    if (!write) {
      throw conflictError(
        "--worktree-auto requires --write.",
        "WORKTREE_WRITE_REQUIRED",
      );
    }
    ensureCodexAvailable(cwd);
    try {
      worktreeInfo = createSubagentWorktree({
        cwd,
        taskId: job.id,
        backend: adapter.name,
        allowBranchFallback: false,
      });
      if (worktreeInfo.isolation_mode !== "worktree") {
        throw new Error(`expected isolated worktree, got ${worktreeInfo.isolation_mode}`);
      }
      job.registryTaskId = job.id;
      job.worktree = worktreeInfo;
      job.isolation_mode = worktreeInfo.isolation_mode;
      try {
        writeMeta(job.id, {
          backend: adapter.name,
          capabilities: adapter.capabilities(),
          worktree: worktreeInfo,
          isolation_mode: worktreeInfo.isolation_mode,
          base_ref: worktreeInfo.base_ref,
          base_sha: worktreeInfo.base_sha,
          phase: "queued",
          brief_hash: briefHash,
          brief_source: briefSource,
        });
        if (brief) {
          writeBriefArtifacts(job.id, {
            brief,
            rendered: renderBriefAsMarkdown(brief),
            hash: briefHash,
            source: briefSource,
          });
        }
      } catch {
        // Registry writes are best-effort — never block dispatch.
      }
      cwd = worktreeInfo.path;
    } catch (err) {
      if (err instanceof CliError) {
        throw err;
      }
      throw new CliError(
        `failed to create subagent worktree for ${job.id}: ${err.message ?? err}`,
        {
          code: "WORKTREE_CREATE_FAILED",
          class: "internal",
          suggestion: "Check that cwd is a Git repository with at least one commit, the base ref exists, and the worktree branch/path are available."
        },
      );
    }
  }

  if (options.background) {
    ensureCodexAvailable(cwd);

    const request = buildTaskRequest({
      cwd,
      stateCwd,
      model,
      effort,
      prompt,
      brief,
      write,
      readOnly,
      resumeLast,
      jobId: job.id,
      mode: options.mode ?? null,
      idleTimeoutMs: idleTimeoutOverride,
      turnPlanMs: turnPlanOverride,
      turnDefaultMs: turnDefaultOverride,
      pipelineStageMs: pipelineStageOverride,
      pipelineTotalMs: pipelineTotalOverride,
      questionAnswerMs: questionTimeoutOverride,
      noPipeline,
      backend: adapter.name,
      group
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    emitSuccess("task", payload, renderQueuedTaskLaunch(payload), {
      json: options.json,
      startedAt
    });
    return;
  }

  await runForegroundCommand(
    job,
    (progress) =>
      runBridgeTask({
        cwd,
        stateCwd,
        model,
        effort,
        prompt,
        brief,
        write,
        readOnly,
        resumeLast,
        jobId: job.id,
        mode: options.mode ?? null,
        idleTimeoutMs: idleTimeoutOverride,
        turnPlanMs: turnPlanOverride,
        turnDefaultMs: turnDefaultOverride,
        pipelineStageMs: pipelineStageOverride,
        pipelineTotalMs: pipelineTotalOverride,
        questionAnswerMs: questionTimeoutOverride,
        noPipeline,
        backend: adapter.name,
        group,
        // `--quiet` suppresses the stderr `[codex] …` progress stream so
        // agents don't pattern-match a thread UUID out of it. Monitor /
        // `events --follow` remain the canonical in-run observation surface.
        onProgress: quietMode ? null : progress
      }),
    { json: options.json, startedAt, command: "task" }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "workspace-root", "job-id"]
  });

  if (!options["job-id"]) {
    throw usageError("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = options["workspace-root"]
    ? path.resolve(process.cwd(), options["workspace-root"])
    : resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw notFoundError(
      `No stored job found for ${options["job-id"]}.`,
      "JOB_NOT_FOUND"
    );
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new CliError(
      `Stored job ${options["job-id"]} is missing its task request payload.`,
      { class: "internal", code: "JOB_CORRUPT", retryable: false }
    );
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    async () =>
      // Go through `runBridgeTask` (not `executeTaskRun` directly) so the
      // detached worker builds the same session-logging hooks, prompt
      // decorations (`skip_meta_skills`, `prompt_footer`), sandbox-policy
      // resolution, `[QUESTION]` handler, and auto-pipeline that the
      // foreground path uses. Pre-v1.2.1 this line called `executeTaskRun`
      // directly, so `task --background` ran the turn but produced ZERO
      // session artifacts (`.events`, `.ndjson`, `.diff`) — breaking every
      // `wait` / `events --follow` caller. See `gherkin-tests-v2/
      // 07-orchestration/08-background-path-produces-session-files.md`.
      persistFailureErrorInPayload(
        await runBridgeTask({
          ...request,
          onProgress: progress
        }),
        "task"
      ),
    { logFile }
  );
}

async function handleStatus(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "group", "timeout-ms", "poll-interval-ms", "interval", "watch-timeout-ms", "retention-days", "retention-jobs"],
    booleanOptions: ["json", "all", "wait", "prune-orphans", "cleanup", "watch", "dry-run"]
  });

  const cwd = resolveCommandCwd(options);
  const group = options.group != null ? String(options.group).trim() : null;
  if (options.group != null && !group) {
    throw usageError("--group requires a non-empty name.");
  }

  // `--watch`: repeatedly render the multi-job status table until every
  // tracked job reaches a terminal state (or the overall timeout expires, or
  // Ctrl-C). The primitive the critique author had to hand-roll as `poll.sh`
  // — ships it in-bridge so N-job orchestration doesn't require shell glue.
  // JSON mode emits one NDJSON snapshot per tick (forward-compatible: new
  // keys in a future bridge version pass through unchanged).
  if (options.watch) {
    if (positionals[0]) {
      throw usageError("`status --watch` does not take a job-id argument; it watches ALL tracked jobs.");
    }
    if (options["prune-orphans"] || options.cleanup || options.wait) {
      throw usageError("`--watch` is mutually exclusive with `--prune-orphans`/`--cleanup`/`--wait`.");
    }
    const intervalMs = parseDurationOption("--interval", options.interval, { defaultMs: 10_000 });
    const overallTimeoutMs = parseDurationOption("--watch-timeout-ms", options["watch-timeout-ms"], { defaultMs: null });
    await runStatusWatch(cwd, {
      intervalMs,
      overallTimeoutMs,
      all: options.all,
      group,
      json: options.json,
      startedAt,
    });
    return;
  }

  // --prune-orphans / --cleanup: reap state-file ghosts (status:"running" or
  // "queued" with a dead PID). Rescue rings accumulated in the stop-gate era
  // required manual SQL-style edits; this subcommand drains them idempotently.
  // See unexpected-bridge-observations/06-stop-gate-review-accumulates-orphaned-running-tasks.md
  // for the original observation. Uses `process.kill(pid, 0)` as the liveness
  // probe — throws ESRCH when the pid no longer resolves, EPERM when it
  // does but we can't signal. Either outcome means "pid exists (or did)";
  // only ESRCH is a clear reap signal.
  if (options["prune-orphans"] || options.cleanup) {
    const report = options.cleanup
      ? cleanupTerminalJobs(cwd, {
          dryRun: Boolean(options["dry-run"]),
          retentionDays: Number(options["retention-days"]) > 0 ? Number(options["retention-days"]) : null,
          retentionJobs: Number(options["retention-jobs"]) > 0 ? Number(options["retention-jobs"]) : null,
        })
      : pruneOrphanedJobs(cwd);
    emitSuccess("status", report, options.cleanup ? renderCleanupReport(report) : renderPruneOrphansReport(report), {
      json: options.json,
      startedAt
    });
    return;
  }

  const reference = positionals[0] ?? "";
  if (group && reference) {
    throw usageError("`status --group` does not take a job id.");
  }
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    emitSuccess("status", snapshot, renderJobStatusReport(snapshot.job), {
      json: options.json,
      startedAt
    });
    return;
  }

  if (options.wait) {
    throw usageError("`status --wait` requires a job id.");
  }

  const report = applyStopReviewGateSnapshot(buildStatusSnapshot(cwd, { all: options.all, group }));
  emitSuccess("status", report, renderStatusReport(report), {
    json: options.json,
    startedAt
  });
}

// v1.4.1 — live multi-job status view. The sync fan-in primitive for N>1
// orchestration. Exits when every tracked job is terminal
// (status !== "queued" && !== "running"), on overall timeout, or on
// Ctrl-C. Returns a summary envelope via emitSuccess once stable.
async function runStatusWatch(cwd, { intervalMs, overallTimeoutMs, all, group, json, startedAt }) {
  const deadline = overallTimeoutMs ? Date.now() + overallTimeoutMs : null;
  let ticks = 0;
  let interrupted = false;
  const onSigint = () => { interrupted = true; };
  process.on("SIGINT", onSigint);

  try {
    while (true) {
      ticks += 1;
      const snapshot = applyStopReviewGateSnapshot(buildStatusSnapshot(cwd, { all, group }));
      const activeCount = snapshot.running?.length ?? 0;
      const tickEntry = {
        schema_version: "1.0",
        tick: ticks,
        ts: new Date().toISOString(),
        activeCount,
        running: (snapshot.running ?? []).map((j) => ({
          id: j.id,
          status: j.status,
          phase: j.phase ?? null,
          threadId: j.threadId ?? null,
          kind: j.kindLabel ?? j.kind ?? null,
          group: j.group ?? null,
        })),
      };
      if (json) {
        process.stdout.write(`${JSON.stringify(tickEntry)}\n`);
      } else {
        process.stdout.write(`\x1b[2J\x1b[H`); // clear + home
        process.stdout.write(`watch tick #${ticks} · ${tickEntry.ts} · active=${activeCount}\n\n`);
        process.stdout.write(renderStatusReport(snapshot));
      }

      if (activeCount === 0) {
        const summary = {
          terminated: true,
          reason: "all-terminal",
          ticks,
          final: snapshot,
        };
        // On the final tick the rendered view is already on screen; emit the
        // structured envelope only in --json mode (else it would clobber the
        // table).
        if (json) {
          emitSuccess("status", summary, null, { json: true, startedAt });
        }
        return;
      }
      if (interrupted) {
        const summary = { terminated: false, reason: "sigint", ticks, final: snapshot };
        if (json) emitSuccess("status", summary, null, { json: true, startedAt });
        return;
      }
      if (deadline && Date.now() >= deadline) {
        const summary = { terminated: false, reason: "watch-timeout", ticks, final: snapshot };
        if (json) emitSuccess("status", summary, null, { json: true, startedAt });
        else process.stdout.write(`\nwatch timed out after ${ticks} ticks with ${activeCount} active job(s).\n`);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

// v1.4.1 — block on a file produced by a Codex job. The success-gate primitive
// for the most common multi-job pattern ("success = an artifact at <path>").
// Three terminal conditions:
//   1. The file exists and its size is stable across one poll interval.
//   2. The job itself reaches a terminal state (completed/failed/cancelled/
//      orphaned). Returns `{exists:false, terminated:true, reason:"<status>"}`.
//   3. The overall timeout expires. Returns `{exists:false, terminated:false,
//      reason:"timeout"}`.
async function handleAwaitArtifact(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json"],
  });

  const jobRef = positionals[0];
  const artifactPath = positionals[1];
  if (!jobRef || !artifactPath) {
    throw usageError("`await-artifact <job-id> <path>` requires both a job reference and a file path.");
  }

  const cwd = resolveCommandCwd(options);
  const timeoutMs = parseDurationOption("--timeout-ms", options["timeout-ms"], { defaultMs: 900_000 });
  const pollIntervalMs = parseDurationOption("--poll-interval-ms", options["poll-interval-ms"], { defaultMs: 2_000 });

  const resolvedPath = path.isAbsolute(artifactPath)
    ? artifactPath
    : path.resolve(cwd, artifactPath);

  const deadline = Date.now() + timeoutMs;
  let prevSize = null;

  while (true) {
    // Job-terminal check first — if the job died without producing the
    // artifact, fail-fast rather than waiting the full timeout.
    let jobSnapshot;
    try {
      jobSnapshot = buildSingleJobSnapshot(cwd, jobRef);
    } catch (e) {
      if (e && e.code === "JOB_NOT_FOUND") {
        throw e;
      }
      throw e;
    }
    const jobStatus = jobSnapshot.job?.status ?? "unknown";
    const jobTerminal = jobStatus !== "queued" && jobStatus !== "running";

    let statInfo = null;
    try {
      statInfo = fs.statSync(resolvedPath);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }

    if (statInfo) {
      if (prevSize != null && prevSize === statInfo.size) {
        const payload = {
          exists: true,
          path: resolvedPath,
          size: statInfo.size,
          terminated: jobTerminal,
          jobStatus,
          elapsedMs: Date.now() - startedAt,
          recovery: buildRecovery({
            reason: "artifact-ready",
            retryable: false,
            artifacts: { artifactPath: resolvedPath },
          }),
        };
        emitSuccess("await-artifact", payload, `artifact ready: ${resolvedPath} (${statInfo.size} bytes)\n`, {
          json: options.json,
          startedAt,
        });
        return;
      }
      prevSize = statInfo.size;
    }

    if (jobTerminal) {
      // Job finished but artifact never appeared — one last chance on the
      // next loop iteration is redundant (job can't write after terminal),
      // so exit with `exists:false`.
      const payload = {
        exists: Boolean(statInfo),
        path: resolvedPath,
        size: statInfo?.size ?? null,
        terminated: true,
        reason: `job-${jobStatus}`,
        jobStatus,
        elapsedMs: Date.now() - startedAt,
        recovery: buildRecovery({
          reason: `job-${jobStatus}`,
          retryable: true,
          nextActions: [
            `Run result ${jobSnapshot.job?.id ?? jobRef} to inspect the terminal job output.`,
            "Verify the producer writes the expected artifact path, then rerun or resume the task.",
          ],
          artifacts: {
            expectedArtifactPath: resolvedPath,
            logFile: jobSnapshot.job?.logFile ?? null,
          },
          details: { jobId: jobSnapshot.job?.id ?? null, jobStatus },
        }),
      };
      // Exit 7 (transient) when artifact missing after job ended — matches
      // `wait` semantics for WAIT_TIMEOUT.
      if (!statInfo) {
        process.exitCode = 7;
        emitSuccess("await-artifact", payload, `job reached ${jobStatus} without producing ${resolvedPath}\n`, {
          json: options.json,
          startedAt,
        });
        return;
      }
      emitSuccess("await-artifact", payload, `artifact present: ${resolvedPath} (${statInfo.size} bytes, job ${jobStatus})\n`, {
        json: options.json,
        startedAt,
      });
      return;
    }

    if (Date.now() >= deadline) {
      const payload = {
        exists: false,
        path: resolvedPath,
        terminated: false,
        reason: "timeout",
        jobStatus,
        elapsedMs: Date.now() - startedAt,
        recovery: buildRecovery({
          reason: "timeout",
          retryable: true,
          nextActions: [
            `Run status ${jobSnapshot.job?.id ?? jobRef} to confirm whether the producer is still active.`,
            "Retry await-artifact with a larger --timeout-ms or inspect events for stalled output.",
          ],
          artifacts: {
            expectedArtifactPath: resolvedPath,
            logFile: jobSnapshot.job?.logFile ?? null,
          },
          details: { jobId: jobSnapshot.job?.id ?? null, jobStatus },
        }),
      };
      process.exitCode = 7;
      emitSuccess("await-artifact", payload, `timeout waiting for ${resolvedPath} (job ${jobStatus})\n`, {
        json: options.json,
        startedAt,
      });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

// Reaps state-file ghost jobs (status:"running" or "queued" with a pid that
// no longer resolves). Marks each with status:"orphaned" and an explanatory
// errorMessage. Idempotent; safe to call repeatedly. Returns a summary
// suitable for both JSON and rendered output.
function pruneOrphanedJobs(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // The default `listJobs` view reaps stale-PID `running`/`queued` jobs to
  // `orphaned` in-memory so read-only consumers see crashes promptly. The
  // prune-orphans writer is the one that must actually persist that
  // transition, so it asks for the raw on-disk view; otherwise the entries
  // it's meant to reap arrive already labelled `orphaned` and slip past
  // the active-status filter below.
  const jobs = listJobs(workspaceRoot, { raw: true });
  const reaped = [];
  const skipped = [];
  const ts = new Date().toISOString();
  for (const job of jobs) {
    const isActive = job.status === "running" || job.status === "queued";
    if (!isActive) continue;
    const pid = Number(job.pid);
    if (!Number.isFinite(pid) || pid <= 0) {
      // Active status with no recorded PID — almost certainly a ghost.
      reaped.push(finalizeOrphan(workspaceRoot, job, ts, "no-pid"));
      continue;
    }
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (err) {
      if (err && err.code === "EPERM") {
        // PID exists, signal denied — treat as alive. Conservative: don't
        // reap something we merely can't signal.
        alive = true;
      }
    }
    if (alive) {
      skipped.push({ id: job.id, pid, reason: "pid-alive" });
    } else {
      reaped.push(finalizeOrphan(workspaceRoot, job, ts, "dead-pid"));
    }
  }
  return {
    workspaceRoot,
    reaped,
    skipped,
    reapedCount: reaped.length,
    skippedCount: skipped.length,
    ts,
    recovery: buildRecovery({
      reason: reaped.length > 0 ? "orphans-reaped" : "state-clean",
      retryable: reaped.length > 0,
      nextActions: reaped.length > 0
        ? [
            "Inspect result/events for reaped jobs before retrying any interrupted work.",
            "Rerun the original task only after confirming no generated artifacts were left half-written.",
          ]
        : [],
      details: { reapedCount: reaped.length, skippedCount: skipped.length },
    }),
  };
}

function finalizeOrphan(workspaceRoot, job, ts, reason) {
  const record = {
    ...job,
    status: "orphaned",
    phase: "orphaned",
    pid: null,
    completedAt: ts,
    errorMessage: `Reaped by status --prune-orphans at ${ts} (${reason}).`
  };
  writeJobFile(workspaceRoot, job.id, record);
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "orphaned",
    phase: "orphaned",
    pid: null,
    completedAt: ts,
    errorMessage: record.errorMessage
  });
  return { id: job.id, previousStatus: job.status, reason, pid: job.pid ?? null };
}

function renderPruneOrphansReport(report) {
  if (report.reapedCount === 0 && report.skippedCount === 0) {
    return "No active jobs to inspect — state is clean.\n";
  }
  const lines = [];
  if (report.reapedCount === 0) {
    lines.push(`No orphans: ${report.skippedCount} active job(s), all backed by live PIDs.`);
  } else {
    lines.push(`Reaped ${report.reapedCount} orphan(s) (status:"running"/"queued" with dead PIDs):`);
    for (const entry of report.reaped) {
      lines.push(`  - ${entry.id} (was ${entry.previousStatus}, ${entry.reason}, pid=${entry.pid ?? "null"})`);
    }
    if (report.skippedCount > 0) {
      lines.push(`Kept ${report.skippedCount} active job(s) backed by live PIDs.`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function cleanupTerminalJobs(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getBridgeConfig(cwd, workspaceRoot);
  const retentionDays = options.retentionDays ?? (Number(config.artifact_retention_days) || 30);
  const retentionJobs = options.retentionJobs ?? (Number(config.artifact_retention_jobs) || 50);
  const dryRun = Boolean(options.dryRun);
  const jobs = listJobs(workspaceRoot, { raw: true });
  const terminal = sortJobsNewestFirst(jobs.filter((job) => !isActiveStatus(job.status)));
  const cutoffMs = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
  const removable = terminal.filter((job, index) => {
    const ts = Date.parse(job.completedAt ?? job.updatedAt ?? job.createdAt ?? "");
    return index >= retentionJobs || (Number.isFinite(ts) && ts < cutoffMs);
  });
  const removed = [];
  if (!dryRun && removable.length > 0) {
    const removeIds = new Set(removable.map((job) => job.id));
    updateState(workspaceRoot, (state) => {
      state.jobs = (state.jobs ?? []).filter((job) => !removeIds.has(job.id));
    });
    for (const job of removable) {
      for (const filePath of [resolveJobFile(workspaceRoot, job.id), job.logFile, `${job.logFile}.worker.err`]) {
        if (!filePath) continue;
        try { fs.rmSync(filePath, { force: true }); } catch { /* best effort */ }
      }
      removed.push({ id: job.id, status: job.status, completedAt: job.completedAt ?? null });
    }
  }
  return {
    workspaceRoot,
    dryRun,
    retentionDays,
    retentionJobs,
    candidates: removable.map((job) => ({ id: job.id, status: job.status, completedAt: job.completedAt ?? null })),
    removed,
    removedCount: removed.length,
    candidateCount: removable.length,
  };
}

function isActiveStatus(status) {
  return status === "queued" || status === "running";
}

function renderCleanupReport(report) {
  if (report.candidateCount === 0) {
    return `No terminal jobs exceed retention (${report.retentionJobs} jobs / ${report.retentionDays} days).\n`;
  }
  const verb = report.dryRun ? "Would remove" : "Removed";
  const lines = [`${verb} ${report.dryRun ? report.candidateCount : report.removedCount} terminal job(s):`];
  const entries = report.dryRun ? report.candidates : report.removed;
  for (const entry of entries) {
    lines.push(`  - ${entry.id} (${entry.status}, completed=${entry.completedAt ?? "unknown"})`);
  }
  return `${lines.join("\n")}\n`;
}

async function handleResult(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const adapter = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    metaBackend: storedJob?.backend ?? job.backend ?? null,
  });
  ensureCodexRuntimeAdapter(adapter);
  const adapterResult = await adapter.getResult(job.id, { cwd });
  const payload = {
    job,
    storedJob,
    adapterResult
  };

  emitSuccess("result", payload, renderStoredJobResult(job, storedJob), {
    json: options.json,
    startedAt
  });
}

function waitForTerminalEvent(eventsPath, pattern, timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;
    let offset = 0;
    let watcher = null;
    let pollTimer = null;
    let timer = null;

    const finish = (payload) => {
      if (resolved) return;
      resolved = true;
      if (watcher) {
        try { watcher.close(); } catch { /* noop */ }
      }
      if (pollTimer) clearInterval(pollTimer);
      if (timer) clearTimeout(timer);
      resolve(payload);
    };

    const scan = () => {
      try {
        const data = fs.readFileSync(eventsPath, "utf8");
        if (data.length < offset) offset = 0; // truncated / rotated
        const tail = data.slice(offset);
        offset = data.length;
        for (const line of tail.split("\n")) {
          const m = pattern.exec(line);
          if (m) {
            finish({ timedOut: false, tag: m[1], line });
            return;
          }
        }
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    };

    const attachWatcher = () => {
      try {
        watcher = fs.watch(eventsPath, { persistent: false }, scan);
        // Catch the case where lines landed between existence check and watch attach.
        scan();
      } catch (e) {
        if (e.code === "ENOENT") {
          if (!pollTimer) {
            pollTimer = setInterval(() => {
              if (fs.existsSync(eventsPath)) {
                clearInterval(pollTimer);
                pollTimer = null;
                attachWatcher();
              }
            }, 500);
          }
        } else {
          throw e;
        }
      }
    };

    if (fs.existsSync(eventsPath)) {
      scan();
      if (!resolved) attachWatcher();
    } else {
      pollTimer = setInterval(() => {
        if (fs.existsSync(eventsPath)) {
          clearInterval(pollTimer);
          pollTimer = null;
          attachWatcher();
        }
      }, 500);
    }

    timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
  });
}

async function handleWait(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "group", "timeout-ms"],
    booleanOptions: ["json", "any", "all"]
  });

  const cwd = resolveCommandCwd(options);
  const group = options.group != null ? String(options.group).trim() : null;
  if (options.group != null && !group) {
    throw usageError("--group requires a non-empty name.");
  }
  if (group) {
    if (options.any || positionals.length > 0) {
      throw usageError("`wait --group` cannot be combined with --any or job ids.");
    }
    if (!options.all) {
      throw usageError("`wait --group <name>` requires --all.");
    }
    await handleWaitGroupAll(cwd, group, options, startedAt);
    return;
  }
  if (options.any) {
    await handleWaitAny(cwd, positionals, options, startedAt);
    return;
  }
  const reference = positionals[0] ?? "";
  if (!reference) {
    throw usageError("wait requires <job-id-or-thread-id>");
  }

  let job;
  try {
    job = resolveResultJob(cwd, reference).job;
  } catch (err) {
    if (err?.code === "JOB_NOT_FINISHED") {
      job = buildSingleJobSnapshot(cwd, reference).job;
    } else {
      throw err;
    }
  }
  if (!job?.threadId) {
    throw notFoundError(
      `Job ${job?.id ?? reference} has no thread id yet.`,
      "JOB_HAS_NO_THREAD"
    );
  }

  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const eventsPath = path.join(sessionDir, `${job.threadId}.events`);
  const timeoutMs = Math.max(1000, Number(options["timeout-ms"]) || 600_000);
  const TERMINAL = TERMINAL_TAG_REGEX;

  const result = await waitForTerminalEvent(eventsPath, TERMINAL, timeoutMs);
  if (result.timedOut) {
    throw new CliError(
      `No terminal event in ${eventsPath} within ${Math.round(timeoutMs / 1000)}s.`,
      {
        class: "timeout",
        code: "WAIT_TIMEOUT",
        retryable: true,
        suggestion: "Run `status <job-id>` to inspect live state."
      }
    );
  }

  const elapsedMs = Date.now() - startedAt;
  emitSuccess(
    "wait",
    {
      jobId: job.id,
      threadId: job.threadId,
      terminalTag: result.tag,
      lastEventLine: result.line,
      eventsPath,
      elapsedMs
    },
    `${result.tag} ${job.threadId} after ${Math.round(elapsedMs / 1000)}s\n`,
    { json: options.json, startedAt }
  );
}

async function handleWaitGroupAll(cwd, group, options, startedAt) {
  const timeoutMs = Math.max(1000, Number(options["timeout-ms"]) || 600_000);
  const deadline = Date.now() + timeoutMs;
  let jobs = [];

  while (Date.now() <= deadline) {
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    jobs = sortJobsNewestFirst(listJobs(workspaceRoot).filter((job) => job.group === group));
    if (jobs.length === 0) {
      throw notFoundError(`No jobs found in group "${group}".`, "GROUP_NOT_FOUND");
    }
    const active = jobs.filter((job) => job.status === "queued" || job.status === "running");
    if (active.length === 0) {
      const elapsedMs = Date.now() - startedAt;
      const payload = {
        mode: "group-all",
        group,
        total: jobs.length,
        terminal: jobs.length,
        jobs: jobs.map((job) => ({
          jobId: job.id,
          threadId: job.threadId ?? null,
          status: job.status,
          phase: job.phase ?? null,
        })),
        elapsedMs,
      };
      emitSuccess(
        "wait",
        payload,
        `Group ${group} reached terminal state for ${jobs.length} job(s) after ${Math.round(elapsedMs / 1000)}s\n`,
        { json: options.json, startedAt }
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new CliError(`Group ${group} still has active jobs after ${Math.round(timeoutMs / 1000)}s.`, {
    class: "timeout",
    code: "WAIT_TIMEOUT",
    retryable: true,
    suggestion: `Run \`status --group ${group}\` to inspect live group state.`,
    details: {
      group,
      active: jobs
        .filter((job) => job.status === "queued" || job.status === "running")
        .map((job) => ({ jobId: job.id, status: job.status, phase: job.phase ?? null })),
    },
  });
}

async function handleWaitAny(cwd, references, options, startedAt) {
  const refs = references.filter(Boolean);
  if (refs.length < 2) {
    throw usageError("wait --any requires at least two job ids or thread ids.");
  }
  const timeoutMs = Math.max(1000, Number(options["timeout-ms"]) || 600_000);
  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const TERMINAL = TERMINAL_TAG_REGEX;

  const targets = refs.map((reference) => {
    let job;
    try {
      job = resolveResultJob(cwd, reference).job;
    } catch (err) {
      if (err?.code === "JOB_NOT_FINISHED") {
        job = buildSingleJobSnapshot(cwd, reference).job;
      } else {
        throw err;
      }
    }
    if (!job?.threadId) {
      throw notFoundError(`Job ${job?.id ?? reference} has no thread id yet.`, "JOB_HAS_NO_THREAD");
    }
    return {
      reference,
      job,
      eventsPath: path.join(sessionDir, `${job.threadId}.events`),
    };
  });

  const deadline = Date.now() + timeoutMs;
  let winner = null;
  while (!winner && Date.now() < deadline) {
    for (const target of targets) {
      const result = scanTerminalEvent(target.eventsPath, TERMINAL);
      if (result) {
        winner = { target, result };
        break;
      }
    }
    if (!winner) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!winner) {
    throw new CliError(`No terminal event for any target within ${Math.round(timeoutMs / 1000)}s.`, {
      class: "timeout",
      code: "WAIT_TIMEOUT",
      retryable: true,
      suggestion: "Run `status --watch --all` to inspect live multi-job state.",
    });
  }

  const elapsedMs = Date.now() - startedAt;
  emitSuccess(
    "wait",
    {
      mode: "any",
      winner: {
        reference: winner.target.reference,
        jobId: winner.target.job.id,
        threadId: winner.target.job.threadId,
        terminalTag: winner.result.tag,
        lastEventLine: winner.result.line,
        eventsPath: winner.target.eventsPath,
      },
      targets: targets.map((target) => ({
        reference: target.reference,
        jobId: target.job.id,
        threadId: target.job.threadId,
        eventsPath: target.eventsPath,
      })),
      elapsedMs,
    },
    `${winner.result.tag} ${winner.target.job.id} after ${Math.round(elapsedMs / 1000)}s\n`,
    { json: options.json, startedAt }
  );
}

function scanTerminalEvent(eventsPath, pattern) {
  try {
    const data = fs.readFileSync(eventsPath, "utf8");
    for (const line of data.split("\n")) {
      const m = pattern.exec(line);
      if (m) return { timedOut: false, tag: m[1], line };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return null;
}

async function handleEvents(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "filter", "exclude"],
    booleanOptions: ["json", "follow"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (!reference) {
    throw usageError("events requires <job-id-or-thread-id>");
  }
  // --filter (inclusion-list) and --exclude (exclusion-list) are mutually
  // exclusive. Forward-compatible callers should prefer --exclude so new
  // tags emitted by future bridge versions pass through by default instead
  // of being silently dropped at an out-of-date inclusion list. See
  // v1.4.0 plan "Change 1 — Exclusion-based filter semantics".
  if (options.filter != null && options.exclude != null) {
    throw usageError(
      "Pass either --filter OR --exclude, not both. --filter shows only listed tags (inclusion); --exclude shows everything except listed tags (forward-compatible)."
    );
  }

  let job;
  try {
    job = resolveResultJob(cwd, reference).job;
  } catch (err) {
    if (err?.code === "JOB_NOT_FINISHED") {
      job = buildSingleJobSnapshot(cwd, reference).job;
    } else {
      throw err;
    }
  }
  if (!job?.threadId) {
    throw notFoundError(
      `Job ${job?.id ?? reference} has no thread id yet.`,
      "JOB_HAS_NO_THREAD"
    );
  }

  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const eventsPath = path.join(sessionDir, `${job.threadId}.events`);

  // Build filter sets. `filter` drops everything NOT in the set; `exclude`
  // drops everything IN the set. Empty strings collapse to null (show-all).
  const parseTagList = (raw) => {
    if (raw == null || raw === "") return null;
    const tags = raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    return tags.length > 0 ? new Set(tags) : null;
  };
  const filter = parseTagList(options.filter);
  const exclude = parseTagList(options.exclude);
  const writeEventLine = (line) => {
    if (!options.json) process.stdout.write(line + "\n");
  };
  const tagOf = (line) => {
    // Match any leading bracketed tag. Character class is deliberately broad
    // (anything but a closing bracket) so future tag names — including
    // ones with digits (`FUTURE_TAG_V15`), underscores, or hyphens
    // (`NETWORK-STALL`) — are recognized and routed through the filter.
    // Pre-1.4.0 this was `[A-Za-z:]+` and silently dropped unknown-shape
    // tags; forward-compat depends on tagOf recognizing them as tags
    // rather than treating them as continuation lines. Head-only scoping
    // unchanged: we split on ":" so `[PIPELINE:review]` maps to PIPELINE.
    const m = /^\[([^\]]+)\]/.exec(line);
    return m ? m[1].split(":")[0].toUpperCase() : null;
  };
  // Predicate order: --filter (inclusion) wins if set; else --exclude drops
  // listed tags; else show-all. Multi-line blocks (HEARTBEAT, CHECKPOINT,
  // PLAN, DONE, ERROR, INCOMPLETE, WARNING, QUESTION) have a header line
  // with a bracketed tag followed by indented continuation lines with no
  // tag. Continuation lines *inherit* the header's inclusion decision —
  // otherwise an included `[CHECKPOINT]` header would show without its
  // `assistant:`, `tools:`, `diff-since-last-checkpoint:` body. This is a
  // real pre-1.4.0 bug: per-line filter dropped every continuation line
  // because `tagOf` returned null.
  let lastBlockIncluded = true;
  const passes = (line) => {
    const tag = tagOf(line);
    if (tag == null) {
      // Continuation or blank line — inherit whatever decision the most
      // recent header got. If no header has been seen yet (preamble), show.
      return lastBlockIncluded;
    }
    // Header line — compute fresh decision and remember it for subsequent
    // continuation lines in this block.
    let included;
    if (filter) included = filter.has(tag);
    else if (exclude) included = !exclude.has(tag);
    else included = true;
    lastBlockIncluded = included;
    return included;
  };

  const TERMINAL = TERMINAL_TAG_REGEX;

  // Dump existing content (filtered). Track whether a terminal tag is already
  // present so --follow can short-circuit on already-completed events files.
  let initial = "";
  let alreadyTerminal = false;
  if (fs.existsSync(eventsPath)) {
    initial = fs.readFileSync(eventsPath, "utf8");
    for (const line of initial.split("\n")) {
      if (!line) continue;
      if (passes(line)) writeEventLine(line);
      if (TERMINAL.test(line)) alreadyTerminal = true;
    }
  }

  const timeoutMs = Math.max(1000, Number(options["timeout-ms"]) || 600_000);

  if (!options.follow || alreadyTerminal) {
    emitSuccess(
      "events",
      {
        jobId: job.id,
        threadId: job.threadId,
        eventsPath,
        followed: Boolean(options.follow),
        filter: options.filter ?? null,
        exclude: options.exclude ?? null
      },
      "",
      { json: options.json, startedAt }
    );
    return;
  }

  // Tail mode — follow appends until a terminal tag or the timeout.
  let timedOut = false;
  // Capture the terminal tag line so the end-of-stream envelope can report
  // which event actually closed the stream (DONE / ERROR / INCOMPLETE / PLAN).
  // Pre-1.2.5 the envelope only said `timedOut: true/false`, which
  // under-determined Monitor's "stream ended" signal — callers couldn't
  // tell happy-path [DONE] from an error-closure without re-reading the
  // file. The terminalTag field closes that gap.
  let terminalTag = null;
  let terminalLine = null;
  const followStartMs = Date.now();

  await new Promise((resolve) => {
    let offset = initial.length;
    let watcher = null;
    let pollTimer = null;
    let timer = null;
    let done = false;

    const finish = (reason) => {
      if (done) return;
      done = true;
      if (reason === "timeout") timedOut = true;
      if (watcher) watcher.close();
      if (pollTimer) clearInterval(pollTimer);
      if (timer) clearTimeout(timer);
      resolve();
    };

    const scanAppended = () => {
      let data;
      try {
        data = fs.readFileSync(eventsPath, "utf8");
      } catch (e) {
        if (e.code === "ENOENT") return;
        throw e;
      }
      if (data.length < offset) offset = 0;
      const tail = data.slice(offset);
      offset = data.length;
      const lines = tail.split("\n");
      // The last element is either "" (trailing newline) or a partial line.
      // Including partial lines would duplicate on the next scan; skip the
      // final element to defer partials until a newline arrives.
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (!line) continue;
        if (passes(line)) writeEventLine(line);
        if (TERMINAL.test(line)) {
          terminalTag = TERMINAL.exec(line)[1];
          terminalLine = line;
          return finish("terminal");
        }
      }
    };

    const attachWatcher = () => {
      try {
        watcher = fs.watch(eventsPath, { persistent: false }, scanAppended);
        scanAppended();
      } catch (e) {
        if (e.code === "ENOENT") {
          if (!pollTimer)
            pollTimer = setInterval(() => {
              if (fs.existsSync(eventsPath)) {
                clearInterval(pollTimer);
                pollTimer = null;
                attachWatcher();
              }
            }, 500);
        } else {
          throw e;
        }
      }
    };

    if (fs.existsSync(eventsPath)) {
      attachWatcher();
    } else {
      pollTimer = setInterval(() => {
        if (fs.existsSync(eventsPath)) {
          clearInterval(pollTimer);
          pollTimer = null;
          attachWatcher();
        }
      }, 500);
    }

    timer = setTimeout(() => finish("timeout"), timeoutMs);
  });

  if (timedOut && !options.json) {
    throw new CliError(
      `No terminal event in ${eventsPath} within ${Math.round(timeoutMs / 1000)}s.`,
      {
        class: "timeout",
        code: "WAIT_TIMEOUT",
        retryable: true,
        suggestion: "Run `status <job-id>` to inspect live state."
      }
    );
  }

  emitSuccess(
    "events",
    {
      jobId: job.id,
      threadId: job.threadId,
      eventsPath,
      followed: true,
      filter: options.filter ?? null,
      exclude: options.exclude ?? null,
      timedOut,
      // Final-envelope fields added in 1.2.5 so Monitor / orchestrators can
      // distinguish happy-path closure from timeout without re-reading the
      // file. terminalTag is one of DONE / ERROR / INCOMPLETE / PLAN on success,
      // or null when the stream ended via timeout. elapsedMs measures
      // follow duration only (not total job elapsed time).
      terminalTag,
      terminalLine,
      elapsedMs: Date.now() - followStartMs
    },
    "",
    { json: options.json, startedAt }
  );
}

function handleTaskResumeCandidate(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  emitSuccess("task-resume-candidate", payload, rendered, {
    json: options.json,
    startedAt
  });
}

function readCancelMeta(taskId) {
  if (!taskId) return { meta: null, warning: null };
  try {
    return { meta: readMeta(taskId), warning: null };
  } catch (error) {
    return {
      meta: null,
      warning: `could not read task registry metadata: ${error?.message ?? error}`,
    };
  }
}

function resolveCancelWorktree(job, existing, meta) {
  const rawWorktree = [meta?.worktree, existing?.worktree, job?.worktree]
    .find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)) ?? {};
  const value = (...candidates) => {
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
    return null;
  };
  return {
    isolation_mode: value(rawWorktree.isolation_mode, meta?.isolation_mode, existing?.isolation_mode, job?.isolation_mode),
    path: value(rawWorktree.path, meta?.worktree_path, existing?.worktree?.path, job?.worktree?.path),
    branch: value(rawWorktree.branch, meta?.branch, meta?.worktree_branch, existing?.worktree?.branch, job?.worktree?.branch),
    previous_ref: value(rawWorktree.previous_ref, meta?.previous_ref, existing?.worktree?.previous_ref, job?.worktree?.previous_ref),
  };
}

function cleanupCancelledWorktree({ workspaceRoot, job, existing, meta, keepWorktree, keepBranch }) {
  const registryTaskId = existing?.registryTaskId ?? job?.registryTaskId ?? meta?.task_id ?? job?.id;
  const worktree = resolveCancelWorktree(job, existing, meta);
  const cleanup = {
    attempted: false,
    succeeded: false,
    reason: "no-worktree",
    worktreePath: worktree.path ?? null,
    branchName: worktree.branch ?? null,
    worktreeRemoved: false,
    branchDeleted: false,
    preservedWorktree: false,
    preservedBranch: false,
    failures: [],
  };

  const branchLooksOwned = typeof worktree.branch === "string" && worktree.branch.startsWith("subagent/");
  const pathLooksOwned = typeof worktree.path === "string" && worktree.path.includes(".codex-bridge-worktrees/");
  const modeLooksOwned = worktree.isolation_mode === "worktree";
  if (!modeLooksOwned && !branchLooksOwned && !pathLooksOwned) {
    return cleanup;
  }

  if (keepWorktree) {
    cleanup.reason = "preserved-by-user";
    cleanup.preservedWorktree = Boolean(worktree.path);
    cleanup.preservedBranch = Boolean(worktree.branch);
    return cleanup;
  }

  cleanup.attempted = true;
  const branchForCleanup = branchLooksOwned ? worktree.branch : null;
  const effectiveKeepBranch = Boolean(keepBranch);
  cleanup.preservedBranch = Boolean(worktree.branch && (effectiveKeepBranch || !branchForCleanup));

  try {
    const pruned = pruneWorktreeOnCancel({
      cwd: workspaceRoot,
      taskId: registryTaskId,
      branch: branchForCleanup,
      previousRef: worktree.previous_ref,
      path: worktree.path,
      keepBranch: effectiveKeepBranch,
    });
    cleanup.worktreeRemoved = Boolean(pruned.pruned);
    cleanup.branchDeleted = Boolean(pruned.branchDeleted);
    cleanup.succeeded = Boolean(pruned.pruned) && (effectiveKeepBranch || !branchForCleanup || Boolean(pruned.branchDeleted));
    cleanup.reason = cleanup.succeeded ? "cleaned" : "cleanup-incomplete";
  } catch (error) {
    cleanup.reason = "cleanup-failed";
    cleanup.failures.push(error instanceof Error ? error.message : String(error));
  }
  return cleanup;
}

function writeCancelledMeta(taskId, meta, completedAt, cleanup) {
  if (!taskId || !meta) return null;
  const {
    schema_version: _schemaVersion,
    task_id: _taskId,
    written_at: _writtenAt,
    ...metaBody
  } = meta;
  writeMeta(taskId, {
    ...metaBody,
    phase: "cancelled",
    cancelled_at: completedAt,
    cleanup,
  });
  return taskId;
}

async function handleCancel(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "keep-worktree", "keep-branch", "keep-all"]
  });

  const cwd = resolveCommandCwd(options);
  const keepAll = Boolean(options["keep-all"]);
  const keepWorktree = keepAll || Boolean(options["keep-worktree"]);
  const keepBranch = keepAll || keepWorktree || Boolean(options["keep-branch"]);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const registryTaskId = existing.registryTaskId ?? job.registryTaskId ?? job.id;
  const { meta: registryMeta, warning: registryWarning } = readCancelMeta(registryTaskId);
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;
  const adapter = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    metaBackend: existing.backend ?? job.backend ?? null,
  });
  ensureCodexRuntimeAdapter(adapter);

  const interrupt = await adapter.cancel(job.id, { cwd, threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.reason ? `: ${interrupt.reason}` : "."}`
    );
  }

  // Capture the terminate result so the envelope can report whether the
  // backing process was actually reaped vs. already gone vs. never had a
  // pid. Field-report P1-10: cancel envelopes were ambiguous about which
  // sub-step succeeded; normalize to explicit booleans plus a warnings list.
  const terminate = terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const warnings = [];
  if (interrupt.attempted && !interrupt.interrupted) {
    warnings.push(
      interrupt.reason
        ? `turn interrupt failed: ${interrupt.reason}`
        : "turn interrupt failed (no reason returned)"
    );
  }
  if (terminate.attempted && !terminate.delivered) {
    warnings.push(`process ${job.pid} was already gone (method=${terminate.method ?? "unknown"})`);
  }
  // No `!terminate.attempted && Number.isFinite(job.pid)` branch: terminateProcessTree
  // returns attempted=false only for a non-finite pid, so finite pids always
  // attempt. Earlier draft included that branch — review-bot Devin and codex
  // exec review both flagged it as dead code; removed for clarity.

  if (registryWarning) {
    warnings.push(registryWarning);
  }
  if (keepWorktree && !options["keep-branch"] && !options["keep-all"]) {
    warnings.push("preserving worktree also preserves its checked-out branch");
  }

  const cleanup = cleanupCancelledWorktree({
    workspaceRoot,
    job,
    existing,
    meta: registryMeta,
    keepWorktree,
    keepBranch,
  });
  if (cleanup.attempted && cleanup.succeeded) {
    appendLogLine(job.logFile, `Removed cancelled worktree artifacts for ${job.id}.`);
  } else if (cleanup.reason === "preserved-by-user") {
    appendLogLine(job.logFile, `Preserved cancelled worktree artifacts for ${job.id}.`);
  } else if (cleanup.failures.length > 0) {
    appendLogLine(job.logFile, `Worktree cleanup failed for ${job.id}: ${cleanup.failures.join("; ")}`);
  }
  for (const failure of cleanup.failures) {
    warnings.push(`worktree cleanup failed: ${failure}`);
  }
  if (cleanup.preservedBranch && cleanup.branchName && !keepBranch) {
    warnings.push(`skipped branch deletion for non-bridge branch: ${cleanup.branchName}`);
  }

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user.",
    cleanup,
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt,
    cleanup,
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt,
    cleanup,
  });
  if (registryMeta) {
    try {
      writeCancelledMeta(registryTaskId, registryMeta, completedAt, cleanup);
    } catch (error) {
      warnings.push(`could not update task registry metadata: ${error?.message ?? error}`);
    }
  }

  // Resolve a stable display title from the registry kind, not the job's
  // dispatch-time "Codex Resume" / "Codex Task" label which mismatched
  // `kindLabel` and confused agents during forensics. `job.title` is kept
  // under `dispatchTitle` for backward compat.
  // Known kindLabel values come from `getJobTypeLabel` in src/lib/job-control.mjs:
  //   "task" | "review" | "adversarial-review" | "rescue-review"
  // Default falls back to a generic "Codex Job" so a future kindLabel that
  // hasn't reached this map yet doesn't get silently labelled "Codex Task".
  const kindLabel = existing.kindLabel ?? job.kindLabel ?? job.jobClass ?? "task";
  const KIND_TITLE = {
    "task": "Codex Task",
    "review": "Codex Review",
    "adversarial-review": "Codex Adversarial Review",
    "rescue-review": "Codex Stop Gate Review",
  };
  const normalizedTitle = KIND_TITLE[kindLabel] ?? "Codex Job";

  const payload = {
    jobId: job.id,
    status: "cancelled",
    cancelled: true,
    processTerminated: Boolean(terminate.delivered),
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted,
    cleanup,
    reason: "cancelled-by-user",
    warnings,
    title: normalizedTitle,
    dispatchTitle: job.title ?? null,
    kindLabel,
    recovery: buildRecovery({
      reason: "cancelled-by-user",
      retryable: false,
      nextActions: [
        `Run result ${job.id} to inspect any partial output.`,
        "Start a fresh task if the cancelled work is still required.",
      ],
      artifacts: {
        logFile: job.logFile ?? null,
        threadId,
        turnId,
      },
      details: {
        interruptAttempted: interrupt.attempted,
        interrupted: interrupt.interrupted,
        interruptReason: interrupt.reason ?? null,
        terminateAttempted: terminate.attempted,
        terminateDelivered: Boolean(terminate.delivered),
        terminateMethod: terminate.method ?? null,
        cleanup,
      },
    }),
  };

  // Pass the normalized title into the human-readable render so JSON and
  // text consumers see the same "Title:" line. Without this, --json reports
  // "Codex Task" while the rendered report would still print the raw
  // dispatch label ("Codex Resume", etc.) from the spread `nextJob`.
  emitSuccess("cancel", payload, renderCancelReport({ ...nextJob, title: normalizedTitle }), {
    json: options.json,
    startedAt
  });
}

// ── NEW COMMANDS ──────────────────────────────────────────────────────────

// ── DOCTOR ────────────────────────────────────────────────────────────────

function formatDoctorBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatDoctorAge(ageMs) {
  if (ageMs == null) return "age unknown";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function renderDoctorReport(report, cleaned = [], options = {}) {
  const lines = ["Codex Bridge Doctor - health report", ""];
  const stale = report.findings.filter((entry) => entry.type === "stale_job");
  const worktrees = report.findings.filter((entry) => entry.type === "orphan_worktree");
  const branches = report.findings.filter((entry) => entry.type === "orphan_branch");
  const oldSessions = report.findings.filter((entry) => entry.type === "old_session_files");
  const disk = report.findings.filter((entry) => entry.type === "disk_usage");
  const codex = report.findings.filter((entry) => entry.type === "codex_cli");

  appendDoctorSection(lines, "Stale jobs", stale, (entry) =>
    `${entry.jobId} (${entry.message}; stale for ${formatDoctorAge(entry.age_ms)})`);
  appendDoctorSection(lines, "Orphan worktrees", worktrees, (entry) =>
    `${entry.path} (${entry.message}${entry.age_ms == null ? "" : `; age ${formatDoctorAge(entry.age_ms)}`})`);
  appendDoctorSection(lines, "Orphan branches", branches, (entry) =>
    `${entry.branch} (${entry.message})`);
  appendDoctorSection(lines, "Old session files", oldSessions, (entry) =>
    `${entry.path} (${entry.message}; oldest ${formatDoctorAge(entry.age_ms)})`);

  lines.push("[Disk usage]");
  for (const entry of disk) {
    lines.push(`  - ${entry.label}: ${entry.exists ? formatDoctorBytes(entry.bytes) : "not found"}${entry.error ? ` (${entry.error})` : ""}`);
  }
  lines.push("");

  lines.push("[Codex CLI]");
  for (const entry of codex) {
    const marker = entry.available && entry.auth?.loggedIn ? "+" : "!";
    lines.push(`  ${marker} ${entry.message}`);
    if (entry.version) lines.push(`    ${entry.version}`);
    if (entry.auth?.detail) lines.push(`    ${entry.auth.detail}`);
  }
  lines.push("");

  const cleanableCount = report.findings.filter((entry) => entry.cleanable).length;
  if (cleanableCount === 0) {
    lines.push("All clear: no stale jobs, orphan worktrees, or orphan branches.");
  } else if (!options.clean) {
    lines.push("To clean up: codex-bridge doctor --clean");
  } else {
    const removed = cleaned.filter((entry) => entry.cleaned).length;
    lines.push(`Cleaned ${removed} of ${cleanableCount} cleanable finding(s).`);
  }
  return `${lines.join("\n")}\n`;
}

function appendDoctorSection(lines, title, entries, formatEntry) {
  lines.push(`[${title}]`);
  if (entries.length === 0) {
    lines.push("  + none");
  } else {
    for (const entry of entries) {
      lines.push(`  ! ${formatEntry(entry)}`);
    }
  }
  lines.push("");
}

function cleanPromptForFinding(finding) {
  if (finding.type === "stale_job") return `Mark stale job ${finding.jobId} orphaned`;
  if (finding.type === "orphan_worktree") return `Remove orphan worktree ${finding.path}`;
  if (finding.type === "orphan_branch") return `Delete orphan branch ${finding.branch}`;
  return `Apply cleanup for ${finding.type}`;
}

function promptDoctorAction(finding) {
  if (!process.stdin.isTTY) {
    return Promise.resolve("no");
  }
  const question = `${cleanPromptForFinding(finding)}? (y/N/all/quit) `;
  process.stdout.write(question);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  return new Promise((resolve) => {
    const onData = (chunk) => {
      process.stdin.pause();
      process.stdin.off("data", onData);
      const answer = String(chunk).trim().toLowerCase();
      if (answer === "y" || answer === "yes") resolve("yes");
      else if (answer === "all" || answer === "a") resolve("all");
      else if (answer === "quit" || answer === "q") resolve("quit");
      else resolve("no");
    };
    process.stdin.on("data", onData);
  });
}

async function cleanDoctorFindings(report, options = {}) {
  const results = [];
  let applyAll = Boolean(options.yes);
  for (const finding of report.findings.filter((entry) => entry.cleanable)) {
    if (!applyAll) {
      const answer = await promptDoctorAction(finding);
      if (answer === "quit") break;
      if (answer === "all") applyAll = true;
      if (answer === "no") {
        results.push({ finding, action: finding.action, cleaned: false, skipped: true, reason: "declined" });
        continue;
      }
    }
    const result = applyDoctorAction(finding, report, { force: options.force });
    results.push(result);
    if (!options.json) {
      process.stdout.write(result.cleaned ? "Removed.\n" : `Skipped: ${result.reason ?? result.detail ?? "not cleaned"}\n`);
    }
  }
  return results;
}

async function handleDoctor(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "clean", "yes", "force"],
  });
  if (positionals.length > 0) {
    throw usageError("`doctor` does not take positional arguments.");
  }
  if (options.yes && !options.clean) {
    throw usageError("`doctor --yes` requires `--clean`.");
  }

  const cwd = resolveCommandCwd(options);
  const report = await runDoctorChecks(cwd);
  let cleaned = [];
  if (options.clean) {
    cleaned = await cleanDoctorFindings(report, {
      yes: Boolean(options.yes),
      force: Boolean(options.force),
      json: Boolean(options.json),
    });
  }

  emitSuccess("doctor", {
    ...report,
    clean: Boolean(options.clean),
    cleaned,
    cleanedCount: cleaned.filter((entry) => entry.cleaned).length,
  }, renderDoctorReport(report, cleaned, { clean: Boolean(options.clean) }), {
    json: options.json,
    startedAt,
  });
}

function resolvePromptInput(options, positionals, cwd) {
  if (options["prompt-file"]) {
    return readPromptFileOrThrow(path.resolve(cwd, options["prompt-file"]));
  }
  if (positionals.length === 1) {
    const candidate = path.resolve(cwd, positionals[0]);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return fs.readFileSync(candidate, "utf8");
      }
    } catch {
      // Not a file — treat as inline text
    }
  }
  const text = positionals.join(" ");
  if (text) return text;
  return readStdinIfPiped();
}

function readReviewedBranchHeadSha(verdict) {
  const candidates = [
    verdict?.branch_head_sha,
    verdict?.reviewed_branch_head_sha,
    verdict?.branchHeadSha,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim().toLowerCase();
    if (/^[a-f0-9]{40}$/.test(normalized)) {
      return normalized;
    }
  }
  return null;
}

function readCurrentTaskBranchHeadSha(meta, cwd) {
  const branch = meta?.worktree?.branch;
  if (!branch) return null;
  const candidates = [
    meta?.worktree?.path,
    cwd,
  ].filter((candidate, index, all) =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    fs.existsSync(candidate) &&
    all.indexOf(candidate) === index
  );
  for (const candidateCwd of candidates) {
    const result = runCommand("git", ["rev-parse", "--verify", branch], {
      cwd: candidateCwd,
      timeout: 10_000,
    });
    if (result.status !== 0 || result.error) continue;
    const sha = result.stdout.trim().toLowerCase();
    if (/^[a-f0-9]{40}$/.test(sha)) return sha;
  }
  return null;
}

function describeMergeBlocker(blocker) {
  if (blocker === "missing_approval") return "verdict is not approved";
  if (blocker === "missing_branch_sha") return "approved verdict is missing branch_head_sha";
  if (blocker === "missing_branch") return "task metadata is missing worktree.branch";
  if (blocker === "branch_head_unavailable") return "current branch head could not be resolved";
  if (blocker === "head_drift") return "current branch head differs from the approved reviewed head";
  return "merge readiness could not be determined";
}

function nextActionForMergeReadiness(taskId, blocker) {
  if (!blocker) {
    return {
      kind: "merge",
      argv: ["merge", taskId],
      description: "Merge the approved unchanged reviewed branch head.",
    };
  }
  if (blocker === "missing_approval") {
    return {
      kind: "review-or-iterate",
      argv: ["iterate", taskId],
      description: "Continue review or iterate until the task has an approved verdict.",
    };
  }
  if (blocker === "missing_branch_sha" || blocker === "head_drift" || blocker === "branch_head_unavailable") {
    return {
      kind: "rerun-review",
      argv: ["adversarial-review", "--task", taskId, "--json"],
      description: "Rerun task-bound review and record a fresh verdict for the current branch head.",
    };
  }
  return {
    kind: "inspect-task-metadata",
    argv: ["verdict", taskId, "--json"],
    description: "Inspect task metadata before attempting merge.",
  };
}

function buildVerdictMergeReadiness(taskId, verdict, meta, cwd) {
  const reviewedBranchHeadSha = readReviewedBranchHeadSha(verdict);
  const currentBranchHeadSha = readCurrentTaskBranchHeadSha(meta, cwd);
  const blockers = [];
  if (verdict?.verdict !== "approved") {
    blockers.push("missing_approval");
  } else if (!reviewedBranchHeadSha) {
    blockers.push("missing_branch_sha");
  } else if (!meta?.worktree?.branch) {
    blockers.push("missing_branch");
  } else if (!currentBranchHeadSha) {
    blockers.push("branch_head_unavailable");
  } else if (currentBranchHeadSha !== reviewedBranchHeadSha) {
    blockers.push("head_drift");
  }
  const primaryBlocker = blockers[0] ?? null;
  return {
    merge_ready: blockers.length === 0,
    merge_blocked_by: primaryBlocker,
    merge_blockers: blockers,
    merge_block_reason: primaryBlocker ? describeMergeBlocker(primaryBlocker) : null,
    branch: meta?.worktree?.branch ?? null,
    branch_head_sha: reviewedBranchHeadSha,
    reviewed_branch_head_sha: reviewedBranchHeadSha,
    current_branch_head_sha: currentBranchHeadSha,
    next_action: nextActionForMergeReadiness(taskId, primaryBlocker),
  };
}

function buildIterateArtifacts(taskId, execution = null, logFile = null) {
  const dir = jobDir(taskId);
  return {
    registry_dir: dir,
    meta_path: path.join(dir, "meta.json"),
    review_path: path.join(dir, "review.json"),
    verdict_path: path.join(dir, "verdict.json"),
    events_path: execution?.payload?.eventsPath ?? null,
    events_dir: execution?.payload?.eventsDir ?? null,
    log_file: logFile,
  };
}

function isSafeTaskId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    return false;
  }
  return true;
}

function resolveIterateInput(options, positionals, cwd) {
  if (positionals.length === 1) {
    const taskId = positionals[0];
    if (isSafeTaskId(taskId) && existsTask(taskId)) {
      let meta;
      try {
        meta = readMeta(taskId);
      } catch (err) {
        throw validationError(
          `task ${taskId} metadata is unreadable: ${err.message ?? err}`,
          "TASK_META_UNREADABLE",
        );
      }
      if (!meta) {
        throw validationError(
          `task ${taskId} exists but is missing meta.json; restore the task metadata or discard the task before iterating`,
          "TASK_META_MISSING",
        );
      }
      return { taskId, prompt: null, meta };
    }
  }
  return {
    taskId: null,
    prompt: resolvePromptInput(options, positionals, cwd),
    meta: null,
  };
}

function loadIterateBrief(options, cwd) {
  if (!options.brief) return { brief: null, briefHash: null, source: null };
  const result = loadBrief(options.brief, { baseDir: cwd });
  if (!result.ok) {
    throw new CliError(result.message, {
      code: result.code,
      class: result.code === "BRIEF_FILE_NOT_FOUND" ? "not_found" : "validation",
    });
  }
  return {
    brief: result.brief,
    briefHash: result.briefHash,
    source: result.source ?? options.brief,
  };
}

function buildIteratePrompt(prompt, brief) {
  const text = String(prompt ?? "").trim();
  if (!brief?.brief) return text;
  const renderedBrief = renderBriefAsMarkdown(brief.brief);
  return [renderedBrief, text].filter(Boolean).join("\n\n");
}

async function runIterateTaskJob({
  prompt,
  cwd,
  stateCwd,
  workspaceRoot,
  model,
  effort,
  adapter,
  parentTaskId = null,
  iteration = 1,
  worktree = null,
  brief = null,
}) {
  const taskMetadata = buildTaskRunMetadata({ prompt });
  const job = buildTaskJob(workspaceRoot, taskMetadata, true, {
    backend: adapter.name,
    adapterCapabilities: adapter.capabilities(),
  });
  let worktreeInfo = worktree;
  if (!worktreeInfo) {
    worktreeInfo = createSubagentWorktree({
      cwd,
      taskId: job.id,
      backend: adapter.name,
      allowBranchFallback: false,
    });
  }
  if (worktreeInfo.isolation_mode !== "worktree") {
    throw new Error(`iterate requires an isolated worktree, got ${worktreeInfo.isolation_mode}`);
  }
  job.registryTaskId = job.id;
  job.worktree = worktreeInfo;
  job.isolation_mode = worktreeInfo.isolation_mode;
  writeMeta(job.id, {
    backend: adapter.name,
    capabilities: adapter.capabilities(),
    worktree: worktreeInfo,
    isolation_mode: worktreeInfo.isolation_mode,
    base_ref: worktreeInfo.base_ref,
    base_sha: worktreeInfo.base_sha,
    phase: "iterate-running",
    parent_task_id: parentTaskId,
    iteration_index: iteration,
    brief_hash: brief?.briefHash ?? null,
    brief_source: brief?.source ?? null,
  });
  if (brief?.brief) {
    writeBriefArtifacts(job.id, {
      brief: brief.brief,
      rendered: renderBriefAsMarkdown(brief.brief),
      hash: brief.briefHash,
      source: brief.source,
    });
  }

  const taskCwd = worktreeInfo.path;
  const request = buildTaskRequest({
    cwd: taskCwd,
    stateCwd,
    model,
    effort,
    prompt,
    brief: brief?.brief ?? null,
    write: true,
    readOnly: false,
    resumeLast: false,
    jobId: job.id,
    mode: "default",
    noPipeline: true,
    backend: adapter.name,
  });
  const { logFile } = createTrackedProgress(job, { stderr: false });
  const execution = await runTrackedJob(
    job,
    async () =>
      persistFailureErrorInPayload(
        await runBridgeTask({
          ...request,
          onProgress: null,
        }),
        "task",
      ),
    { logFile },
  );

  return {
    task_id: job.id,
    execution,
    worktree: worktreeInfo,
    artifacts: buildIterateArtifacts(job.id, execution, logFile),
  };
}

function createIterateDependencies({ cwd, workspaceRoot, model, effort, adapter, brief }) {
  const stateCwd = cwd;
  const readTaskCompletion = async ({ taskId, startedTask }) => {
    if (startedTask?.execution?.exitStatus && startedTask.execution.exitStatus !== 0) {
      const err = new Error(startedTask.execution.error?.message ?? `task ${taskId} failed`);
      err.code = "ITERATE_TASK_FAILED";
      throw err;
    }
    const storedJob = readStoredJob(workspaceRoot, taskId);
    if (storedJob?.status === "queued" || storedJob?.status === "running") {
      const err = new Error(`task ${taskId} is still ${storedJob.status}; wait for task completion before reviewing`);
      err.code = "ITERATE_TASK_STILL_RUNNING";
      throw err;
    }
    if (storedJob?.status === "failed") {
      const err = new Error(storedJob.errorMessage ?? `task ${taskId} failed`);
      err.code = "ITERATE_TASK_FAILED";
      throw err;
    }
    const meta = readMeta(taskId);
    if (!meta) {
      const err = new Error(`no meta.json found for ${taskId}`);
      err.code = "ITERATE_TASK_META_MISSING";
      throw err;
    }
    return {
      task_id: taskId,
      meta,
      artifacts: buildIterateArtifacts(taskId, startedTask?.execution ?? null, startedTask?.artifacts?.log_file ?? null),
    };
  };

  const runReview = async ({ taskId }) => {
    const taskReview = requireTaskReviewContext(taskId, {});
    const reviewRun = await executeReviewRun({
      cwd: taskReview.cwd,
      base: taskReview.base,
      scope: taskReview.scope,
      model,
      backend: adapter.name,
      reviewName: "Adversarial Review",
      taskId,
      reviewedBranchHeadSha: taskReview.reviewedBranchHeadSha,
    });
    const reviewResult = reviewRun.payload?.review_result ?? null;
    if (reviewRun.exitStatus !== 0 || !reviewResult) {
      const err = new Error(reviewRun.error?.message ?? reviewRun.payload?.parseError ?? `review failed for ${taskId}`);
      err.code = "ITERATE_REVIEW_FAILED";
      throw err;
    }
    return {
      review_result: reviewResult,
      thread_id: reviewRun.threadId ?? null,
      artifacts: buildIterateArtifacts(taskId),
    };
  };

  const writeIterateVerdict = async ({ taskId, reviewResult }) => {
    const verdict = mapReviewVerdictToTaskVerdict(reviewResult);
    const reviewedHead = reviewResult?.reviewed_branch_head_sha ?? reviewResult?.branch_head_sha ?? null;
    writeVerdict(taskId, {
      ...reviewResult,
      verdict,
      reviewer: "codex-bridge-iterate",
      ...(reviewedHead ? { branch_head_sha: reviewedHead, reviewed_branch_head_sha: reviewedHead } : {}),
    });
    return {
      verdict: readVerdict(taskId),
      artifacts: buildIterateArtifacts(taskId),
    };
  };

  const startFollowup = async ({ previousTaskId, iteration, prompt }) => {
    const meta = readMeta(previousTaskId);
    if (!meta?.worktree?.path || !meta?.worktree?.branch) {
      const err = new Error(`task ${previousTaskId} is missing worktree metadata for follow-up`);
      err.code = "ITERATE_FOLLOWUP_META_MISSING";
      throw err;
    }
    return runIterateTaskJob({
      prompt,
      cwd: meta.worktree.path,
      stateCwd,
      workspaceRoot,
      model,
      effort,
      adapter,
      parentTaskId: previousTaskId,
      iteration,
      worktree: meta.worktree,
      brief,
    });
  };

  const markSuperseded = async ({ taskId, nextTaskId, iteration, verdict }) => {
    const supersededAt = nowIso();
    const reason = "iterate-followup";
    const existingVerdict = readVerdict(taskId);
    if (existingVerdict) {
      writeVerdict(taskId, {
        ...existingVerdict,
        superseded_by: nextTaskId,
        superseded_at: supersededAt,
        superseded_reason: reason,
        superseded_iteration: iteration + 1,
      });
    }
    const meta = readMeta(taskId);
    if (meta) {
      writeMeta(taskId, {
        ...meta,
        phase: "superseded",
        superseded_by: nextTaskId,
        superseded_at: supersededAt,
        superseded_reason: reason,
        superseded_verdict: verdict,
      });
    }
    return {
      superseded_by: nextTaskId,
      artifacts: buildIterateArtifacts(taskId),
    };
  };

  return {
    startTask: ({ prompt, iteration }) =>
      runIterateTaskJob({
        prompt,
        cwd,
        stateCwd,
        workspaceRoot,
        model,
        effort,
        adapter,
        iteration,
        brief,
      }),
    readTaskCompletion,
    runReview,
    writeVerdict: writeIterateVerdict,
    startFollowup,
    markSuperseded,
  };
}

// iterate <prompt|task_id> — closed-loop dispatcher that runs task →
// review → verdict and re-dispatches on needs-attention/must-fix until either
// approved or iteration_max is hit.
async function handleIterate(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["max", "brief", "backend", "cwd", "prompt-file", "model", "effort"],
    booleanOptions: ["json", "write"],
    aliasMap: { m: "model" },
  });
  const max = options.max ? Number.parseInt(options.max, 10) : 3;
  if (!Number.isInteger(max) || max < 1 || max > 10) {
    throw usageError(`--max must be an integer between 1 and 10 (got ${JSON.stringify(options.max)})`);
  }
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const input = resolveIterateInput(options, positionals, cwd);
  const brief = loadIterateBrief(options, cwd);
  const prompt = input.taskId ? null : buildIteratePrompt(input.prompt, brief);
  if (!input.taskId && !prompt) {
    throw validationError("iterate requires a task_id, prompt, prompt file, or piped stdin", "MISSING_PROMPT");
  }
  const adapter = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    backend: options.backend ?? null,
  });
  ensureCodexRuntimeAdapter(adapter);
  guardCapability(adapter, "supports_worktree");
  guardCapability(adapter, "supports_artifact_registry");
  guardCapability(adapter, "supports_adversarial_review");
  ensureCodexAvailable(cwd);
  if (!input.taskId) ensureGitRepository(cwd);
  const config = getBridgeConfig(cwd, workspaceRoot);
  const model = normalizeRequestedModel(options.model ?? config.model);
  const effort = normalizeReasoningEffort(options.effort ?? config.effort);
  const payload = await runIterateLoop({
    max,
    taskId: input.taskId,
    prompt,
    deps: createIterateDependencies({
      cwd,
      workspaceRoot,
      model,
      effort,
      adapter,
      brief,
    }),
  });
  emitSuccess(
    "iterate",
    payload,
    `iterate ${payload.status} after ${payload.iterations?.length ?? 0}/${max} iteration(s).\n`,
    { json: options.json, startedAt },
  );
}

const VERDICT_VALUES = new Set(["approved", "needs-attention", "must-fix"]);

function validateVerdictValue(verdict, optionName = "--set") {
  if (!VERDICT_VALUES.has(verdict)) {
    throw usageError(
      `${optionName} must be one of approved | needs-attention | must-fix (got ${JSON.stringify(verdict)})`,
    );
  }
}

function readVerdictPayloadFromStdin() {
  const raw = readStdinIfPiped().trim();
  if (!raw) {
    throw usageError("--payload-stdin requires a JSON object on stdin");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw usageError(`--payload-stdin must be valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError("--payload-stdin must be a JSON object");
  }
  validateVerdictValue(parsed.verdict, "payload.verdict");
  if (parsed.findings != null && !Array.isArray(parsed.findings)) {
    throw usageError("payload.findings must be an array when provided");
  }
  const reviewedBranchHeadSha =
    parsed.branch_head_sha ??
    parsed.reviewed_branch_head_sha ??
    parsed.branchHeadSha ??
    null;
  if (
    reviewedBranchHeadSha != null &&
    (typeof reviewedBranchHeadSha !== "string" || !/^[0-9a-f]{40}$/i.test(reviewedBranchHeadSha.trim()))
  ) {
    throw usageError("payload.reviewed_branch_head_sha must be a 40-character hex SHA when provided");
  }
  const normalizedBranchHeadSha =
    typeof reviewedBranchHeadSha === "string" ? reviewedBranchHeadSha.trim().toLowerCase() : null;
  return {
    ...parsed,
    verdict: parsed.verdict,
    summary: typeof parsed.summary === "string" ? parsed.summary : null,
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    reviewer: typeof parsed.reviewer === "string" ? parsed.reviewer : null,
    ...(normalizedBranchHeadSha
      ? {
          branch_head_sha: normalizedBranchHeadSha,
          reviewed_branch_head_sha: normalizedBranchHeadSha,
        }
      : {}),
  };
}

// verdict <task_id> — read or write the post-review verdict.
//   read mode  (no flags):           prints current verdict.json
//   write mode (--set <verdict>):    persists { verdict, summary?, finding?, reviewer? }
//   stdin mode (--payload-stdin):     persists a JSON payload without shell-arg interpolation
//   --discard:                       removes the registry directory
async function handleVerdict(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["set", "summary", "reviewer", "cwd"],
    repeatableValueOptions: ["finding"],
    booleanOptions: ["json", "discard", "payload-stdin"],
  });
  const taskId = positionals[0];
  if (!taskId) {
    throw usageError("verdict requires a task_id positional argument");
  }
  const modeCount = [Boolean(options.discard), Boolean(options.set), Boolean(options["payload-stdin"])]
    .filter(Boolean).length;
  if (modeCount > 1) {
    throw usageError("verdict modes are mutually exclusive: choose one of --set, --payload-stdin, or --discard");
  }

  // discard mode: remove only verdict.json so the rest of the registry
  // entry (meta.json, session-log.jsonl, etc.) is preserved for audit.
  if (options.discard) {
    const target = path.join(jobDir(taskId), "verdict.json");
    let removed = false;
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      removed = true;
    }
    emitSuccess(
      "verdict",
      { task_id: taskId, action: "discarded", removed },
      `Discarded verdict for ${taskId}\n`,
      { json: options.json, startedAt },
    );
    return;
  }

  if (options["payload-stdin"]) {
    if (options.summary || options.reviewer || options.finding) {
      throw usageError("--payload-stdin cannot be combined with --summary, --reviewer, or --finding");
    }
    const payload = readVerdictPayloadFromStdin();
    writeVerdict(taskId, payload);
    const stored = readVerdict(taskId);
    emitSuccess(
      "verdict",
      { task_id: taskId, action: "set", verdict: stored },
      `Verdict for ${taskId}: ${payload.verdict}\n`,
      { json: options.json, startedAt },
    );
    return;
  }

  // write mode: persist a new verdict
  if (options.set) {
    const verdict = options.set;
    validateVerdictValue(verdict);
    const payload = {
      verdict,
      summary: options.summary ?? null,
      findings: Array.isArray(options.finding)
        ? options.finding
        : options.finding
          ? [options.finding]
          : [],
      reviewer: options.reviewer ?? null,
    };
    writeVerdict(taskId, payload);
    const stored = readVerdict(taskId);
    emitSuccess(
      "verdict",
      { task_id: taskId, action: "set", verdict: stored },
      `Verdict for ${taskId}: ${verdict}\n`,
      { json: options.json, startedAt },
    );
    return;
  }

  // read mode
  const stored = readVerdict(taskId);
  if (!stored) {
    throw notFoundError(
      `no verdict found for ${taskId}; use --set to create one`,
    );
  }
  const cwd = resolveCommandCwd(options);
  const meta = readMeta(taskId);
  const mergeReadiness = buildVerdictMergeReadiness(taskId, stored, meta, cwd);
  const result = {
    task_id: taskId,
    verdict: {
      ...stored,
      summary: stored.summary ?? null,
      branch: mergeReadiness.branch,
      branch_head_sha: mergeReadiness.branch_head_sha,
      reviewed_branch_head_sha: mergeReadiness.reviewed_branch_head_sha,
    },
    merge_readiness: mergeReadiness,
  };
  emitSuccess(
    "verdict",
    result,
    JSON.stringify(result, null, 2) + "\n",
    { json: options.json, startedAt },
  );
}

// verdicts --pending — flat list of tasks with verdict=approved (not yet
// merged), verdict=needs-attention, or verdict=must-fix. All three states
// are unresolved work and block the Stop gate (T14) until merged or
// explicitly discarded with `verdict --discard`.
async function handleVerdictsPending(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "pending"],
  });

  // --pending is the only mode currently supported. Require it explicitly
  // so the CLI contract leaves room for future modes (e.g. --resolved)
  // without silently changing default behavior.
  if (!options.pending) {
    throw usageError(
      "verdicts requires --pending (only mode currently supported)",
    );
  }

  const cwd = resolveCommandCwd(options);
  const pendingVerdicts = new Set(["approved", "needs-attention", "must-fix"]);
  const tasks = listTasks();
  const pending = [];
  for (const taskId of tasks) {
    const verdict = readVerdict(taskId);
    if (!verdict) continue;
    const meta = readMeta(taskId);
    if (verdict.merged_at || meta?.merged_at || meta?.phase === "merged") {
      continue;
    }
    if (verdict.superseded_by || meta?.superseded_by || meta?.phase === "superseded") {
      continue;
    }
    if (pendingVerdicts.has(verdict.verdict)) {
      const mergeReadiness = buildVerdictMergeReadiness(taskId, verdict, meta, cwd);
      pending.push({
        task_id: taskId,
        verdict: verdict.verdict,
        summary: verdict.summary ?? null,
        decided_at: verdict.decided_at,
        branch: mergeReadiness.branch,
        branch_head_sha: mergeReadiness.branch_head_sha,
        reviewed_branch_head_sha: mergeReadiness.reviewed_branch_head_sha,
        current_branch_head_sha: mergeReadiness.current_branch_head_sha,
        merge_ready: mergeReadiness.merge_ready,
        merge_blocked_by: mergeReadiness.merge_blocked_by,
        merge_blockers: mergeReadiness.merge_blockers,
        merge_block_reason: mergeReadiness.merge_block_reason,
        next_action: mergeReadiness.next_action,
      });
    }
  }

  const rendered =
    pending.length === 0
      ? "No pending verdicts.\n"
      : pending
          .map(
            (p) =>
              `${p.task_id}  ${p.verdict}  ${p.branch ?? "(no branch)"}  ${p.merge_ready ? "merge-ready" : `blocked:${p.merge_blocked_by ?? "unknown"}`}  ${p.summary ?? ""}`,
          )
          .join("\n") + "\n";

  emitSuccess(
    "verdicts",
    { count: pending.length, pending },
    rendered,
    { json: options.json, startedAt },
  );
}

// merge <task_id> — gated merge of a worktree branch back into its base.
// Refuses to proceed unless verdict.json is approved for this exact branch SHA.
// Performs a fast-forward merge (no merge commit, no rebase). On conflict
// or if the merge isn't ff-eligible, leaves the worktree intact and returns
// MERGE_CONFLICT so the orchestrator can re-run /codex-bridge:iterate.
async function handleMerge(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "no-tests", "pr"],
  });
  const taskId = positionals[0];
  if (!taskId) {
    throw usageError("merge requires a task_id positional argument");
  }
  const cwd = resolveCommandCwd(options);

  const verdict = readVerdict(taskId);
  if (!verdict) {
    throw notFoundError(
      `no verdict found for ${taskId}; run review and record an approved verdict before merging`,
    );
  }
  if (verdict.verdict !== "approved") {
    throw new CliError(
      `verdict for ${taskId} is ${verdict.verdict}, not approved; refusing to merge. Re-run review or iterate before approving this task.`,
      { code: "VERDICT_NOT_APPROVED", class: "conflict" },
    );
  }
  const reviewedBranchHeadSha = readReviewedBranchHeadSha(verdict);
  if (!reviewedBranchHeadSha) {
    throw new CliError(
      `approved verdict for ${taskId} is missing branch_head_sha; rerun review so the approval is bound to the reviewed branch head`,
      { code: "VERDICT_HEAD_SHA_MISSING", class: "conflict" },
    );
  }

  const meta = readMeta(taskId);
  if (!meta) {
    throw notFoundError(
      `no meta.json found for ${taskId}; the task was not dispatched via --worktree-auto`,
    );
  }
  const branch = meta.worktree?.branch;
  const baseRef = meta.worktree?.base_ref ?? "main";
  if (!branch) {
    throw new CliError(
      `meta.json for ${taskId} missing worktree.branch — task may not have been dispatched via --worktree-auto`,
      { code: "MERGE_META_INVALID", class: "internal" },
    );
  }

  if (options.pr) {
    // --pr (push + gh pr create) deferred — needs additional plumbing for
    // PR body composition from brief + verdict. Track in a follow-up.
    throw new CliError(
      "--pr mode not yet implemented; ff-merge into the base ref is the only supported strategy in v2.0. Drop --pr or wait for the follow-up.",
      { code: "MERGE_PR_NOT_IMPLEMENTED", class: "internal" },
    );
  }

  let mergeResult;
  try {
    mergeResult = mergeSubagentBranch({
      cwd,
      taskId,
      branch,
      baseRef,
      expectedBranchSha: reviewedBranchHeadSha,
      worktreePath: meta.worktree?.path,
      runTests: !options["no-tests"],
    });
  } catch (err) {
    const kind = err?.kind;
    if (kind === "conflict") {
      throw new CliError(
        `merge failed: ${err.message ?? err}. The worktree was left intact; resolve conflicts manually or rerun /codex-bridge:iterate.`,
        { code: "MERGE_CONFLICT", class: "conflict" },
      );
    }
    if (kind === "sha_drift") {
      throw new CliError(
        `merge refused: ${err.message ?? err}`,
        { code: "MERGE_SHA_DRIFT", class: "conflict" },
      );
    }
    if (kind === "precondition") {
      throw new CliError(
        `merge precondition failed: ${err.message ?? err}`,
        { code: "MERGE_PRECONDITION", class: "usage" },
      );
    }
    throw new CliError(
      `merge failed: ${err.message ?? err}`,
      { code: "MERGE_INTERNAL", class: "internal" },
    );
  }

  const mergedAt = nowIso();
  const {
    schema_version: _verdictSchemaVersion,
    task_id: _verdictTaskId,
    decided_at: _verdictDecidedAt,
    ...verdictBody
  } = verdict;
  writeVerdict(taskId, {
    ...verdictBody,
    merged_at: mergedAt,
    merge: mergeResult,
  });
  const {
    schema_version: _schemaVersion,
    task_id: _taskId,
    written_at: _writtenAt,
    ...metaBody
  } = meta;
  writeMeta(taskId, {
    ...metaBody,
    phase: "merged",
    merged_at: mergedAt,
    merge: mergeResult,
  });

  const payload = {
    task_id: taskId,
    merge: mergeResult,
    verdict: verdict.verdict,
    reviewed_branch_head_sha: reviewedBranchHeadSha,
  };
  emitSuccess(
    "merge",
    payload,
    `Merged ${branch} into ${baseRef} (${mergeResult.commit_sha?.slice(0, 8) ?? "?"})\n`,
    { json: options.json, startedAt },
  );
}

async function handleSend(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [
      "mode", "effort", "cwd", "backend",
      "idle-timeout-ms",
      "turn-timeout-ms",
      "question-timeout-ms"
    ],
    booleanOptions: ["json", "wait", "quiet"],
    aliasMap: { m: "mode" }
  });

  const VALID_MODES = new Set(["plan", "default"]);
  if (options.mode != null && !VALID_MODES.has(options.mode)) {
    throw usageError(`mode must be plan or default, got ${JSON.stringify(options.mode)}`);
  }

  const idleTimeoutOverride = parsePositiveMsOption("--idle-timeout-ms", options["idle-timeout-ms"]);
  // `send` doesn't distinguish plan vs default (the mode is already fixed by
  // the resumed thread), so one --turn-timeout-ms flag covers it. It maps
  // onto whichever of turn_plan_ms / turn_default_ms the resolved mode picks.
  const turnTimeoutOverride = parsePositiveMsOption("--turn-timeout-ms", options["turn-timeout-ms"]);
  const questionTimeoutOverride = parsePositiveMsOption("--question-timeout-ms", options["question-timeout-ms"]);
  // See handleTask: --json implies --quiet so orchestrators consuming the
  // envelope don't also have to filter the stderr UUID trap.
  const quietMode = Boolean(options.quiet) || (Boolean(options.json) && options.quiet !== false);

  const startedAt = Date.now();
  const rawThreadId = positionals[0];
  if (!rawThreadId) {
    throw usageError("send requires <thread-id>");
  }
  if (!isThreadId(rawThreadId)) {
    throw invalidThreadIdError(rawThreadId, "thread-id");
  }
  const threadId = rawThreadId.trim();

  const promptParts = positionals.slice(1);
  const cwd = resolveCommandCwd(options);
  const prompt = resolvePromptInput(options, promptParts, cwd);
  if (!prompt) {
    throw validationError("send requires a prompt (text or file)", "MISSING_PROMPT");
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getBridgeConfig(cwd, workspaceRoot);
  const adapter = await resolveCommandAdapter({
    cwd,
    workspaceRoot,
    backend: options.backend ?? null,
  });
  ensureCodexRuntimeAdapter(adapter);
  guardCapability(adapter, "supports_resume");
  const modeOverride = options.mode;

  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));

  const sendIsPlanMode = modeOverride === "plan";
  const turnOptions = {
    resumeThreadId: threadId,
    prompt,
    model: config.model,
    effort: normalizeReasoningEffort(options.effort ?? config.effort),
    sandbox: modeOverride === "default" ? "workspace-write" : modeOverride === "plan" ? "read-only" : undefined,
    onProgress: null,
    // Resolution order: --idle-timeout-ms flag → config.yaml `idle_timeout_ms`
    // → 300_000 fallback. Mirrors the `task` path; see runBridgeTask.
    idleTimeoutMs: idleTimeoutOverride != null
      ? idleTimeoutOverride
        : (Number(config.idle_timeout_ms) > 0 ? Number(config.idle_timeout_ms) : DEFAULT_CONFIG.idle_timeout_ms),
    // Turn timeout: per-invocation override > the mode-appropriate config key
    // (turn_plan_ms for plan-mode sends, turn_default_ms otherwise) > built-in
    // default. `send` gets a single --turn-timeout-ms flag that maps onto the
    // right budget based on the resolved mode.
    turnTimeoutMs: turnTimeoutOverride
      ?? (sendIsPlanMode
        ? (Number(config.turn_plan_ms) > 0 ? Number(config.turn_plan_ms) : DEFAULT_CONFIG.turn_plan_ms)
        : (Number(config.turn_default_ms) > 0 ? Number(config.turn_default_ms) : DEFAULT_CONFIG.turn_default_ms)),
    onTurnStart: (info) => {
      const s = findSession(sessionDir, info.threadId) ?? initSession(sessionDir, info.threadId);
      logNdjson(s, "TURN_PARAMS", "turn/start", {
        model: info.turnParams.model,
        effort: info.turnParams.effort,
        collaborationMode: info.turnParams.collaborationMode,
        sandboxPolicy: info.turnParams.sandboxPolicy,
        hasOutputSchema: Boolean(info.turnParams.outputSchema),
        promptLength: info.promptLength,
        promptPreview: info.promptPreview
      });
    },
    onItemCompleted: (item, { threadId: itemThreadId }) => {
      const effectiveThreadId = itemThreadId ?? null;
      if (!effectiveThreadId) return;
      const s = findSession(sessionDir, effectiveThreadId) ?? initSession(sessionDir, effectiveThreadId);
      logNdjson(s, "ITEM_COMPLETED", "item/completed", {
        itemId: item?.id ?? null,
        itemType: item?.type ?? null,
        text: extractItemText(item)
      });
    },
    onServerRequest: createBridgeServerRequestHandler({
      sessionDir,
      config,
      questionAnswerMs: questionTimeoutOverride ?? null,
      cwd
    })
  };

  // `sandboxPolicy` must honor `config.sandbox_policy` regardless of whether
  // the caller passed `--mode`. Previously the override only applied inside
  // the `if (modeOverride)` block, so a plain `send <tid> "prompt"` silently
  // dropped `sandbox_policy: danger-full-access` and inherited the thread's
  // original (read-only) sandbox — defeating the user's explicit config.
  // Resolve through `buildSandboxPolicy` with a mode derived from the
  // override (if set) or from the turn's thread semantics (read-only when
  // nothing narrows it, widened only if the config explicitly says so).
  const resolvedSandboxMode = modeOverride === "default" ? "default" : "plan";
  turnOptions.sandboxPolicy = buildSandboxPolicy(resolvedSandboxMode, config);
  if (modeOverride) {
    turnOptions.collaborationMode = buildCollaborationMode(modeOverride, config, {
      effort: options.effort,
      developerInstructions: loadDeveloperInstructions(modeOverride),
    });
  }

  ensureCodexAvailable(cwd);
  const dispatch = await adapter.resume(threadId, prompt, {
    cwd,
    sessionDir,
    model: config.model,
    effort: turnOptions.effort,
    mode: modeOverride ?? "default",
    adapterOptions: {
      turnOptions,
    },
  });
  const result = dispatch.rawResult ?? dispatch;

  // Route failed Codex turns through emitError so exit code reflects the
  // failure class. Previously `send` emitted success + exit 0 even when the
  // turn failed with Unauthorized/ContextWindowExceeded/etc.
  if (result.status !== 0) {
    const errLike = result.error ?? { message: `send failed on thread ${threadId} (status ${result.status}).` };
    const session = findSession(sessionDir, threadId) ?? initSession(sessionDir, threadId);
    const classified = classifyError(errLike);
    logEvent(session, formatErrorEvent(session, {
      errorCode: classified.code,
      message: classified.message,
      phase: classified.class,
      origin: "send",
      scriptPath: SCRIPT_PATH,
      cwd
    }));
    logNdjson(session, "ERROR", "turn/completed", { error: classified });
    emitError(errLike, { json: options.json, command: "send" });
    return;
  }

  const session = findSession(sessionDir, threadId) ?? initSession(sessionDir, threadId);
  if (result.planDetected && result.planText) {
    const planPath = writePlan(session, result.planText);
    const steps = extractPlanSteps(result.planText);
    logEvent(session, formatPlanEvent(session, {
      turnId: result.turnId,
      planTitle: result.planText.split("\n")[0]?.slice(0, 80) ?? "Plan",
      steps,
      planPath,
      scriptPath: SCRIPT_PATH,
      cwd
    }));
    logNdjson(session, "PLAN", "item/completed", {
      turnId: result.turnId ?? null,
      planPath,
      planDetected: true
    });
    const eventsPath = session?.eventsPath ?? null;
    const renderedLines = [`Plan updated for ${threadId}.`];
    if (eventsPath) renderedLines.push(`  events: ${eventsPath}`);
    emitSuccess(
      "send",
      {
        threadId,
        status: result.status,
        turnId: result.turnId ?? null,
        eventsPath,
        phase: "plan-pending",
        planPath,
        planSteps: steps,
        finalMessage: result.finalMessage ?? null
      },
      `${renderedLines.join("\n")}\n`,
      { json: options.json, startedAt }
    );
    return;
  }
  logEvent(session, formatDoneEvent(session, {
    duration: Math.round((Date.now() - startedAt) / 1000),
    diffStat: "send follow-up",
    files: [],
    config: {
      model: config.model,
      effort: turnOptions.effort,
      modeFlow: modeOverride ?? "resume"
    },
    diffPath: "not captured for send",
    scriptPath: SCRIPT_PATH,
    cwd
  }));
  logNdjson(session, "DONE", "turn/completed", {
    turnId: result.turnId ?? null,
    status: result.status
  });
  const eventsPath = session?.eventsPath ?? null;
  const renderedLines = [`Sent to ${threadId}. Status: ${result.status}`];
  if (eventsPath) renderedLines.push(`  events: ${eventsPath}`);
  const payload = {
    threadId,
    status: result.status,
    turnId: result.turnId ?? null,
    eventsPath,
    finalMessage: result.finalMessage ?? null
  };
  emitSuccess("send", payload, `${renderedLines.join("\n")}\n`, {
    json: options.json,
    startedAt
  });
}

async function handleSteer(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "backend"],
    booleanOptions: ["json"]
  });

  const [rawThreadId, turnId, ...promptParts] = positionals;
  if (!rawThreadId || !turnId) {
    throw usageError("steer requires <thread-id> <turn-id> <prompt...>");
  }
  if (!isThreadId(rawThreadId)) {
    throw invalidThreadIdError(rawThreadId, "thread-id");
  }
  const threadId = rawThreadId.trim();

  const cwd = resolveCommandCwd(options);
  const prompt = resolvePromptInput(options, promptParts, cwd);
  if (!prompt) {
    throw validationError("steer requires a prompt", "MISSING_PROMPT");
  }

  const adapter = await resolveCommandAdapter({
    cwd,
    workspaceRoot: resolveWorkspaceRoot(cwd),
    backend: options.backend ?? null,
  });
  ensureCodexRuntimeAdapter(adapter);
  guardCapability(adapter, "supports_steering");
  ensureCodexAvailable(cwd);
  await adapter.steer(threadId, turnId, prompt, { cwd });

  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const session = findSession(sessionDir, threadId);
  if (session) {
    logNdjson(session, "STEER", "turn/steer", { turnId, prompt: prompt.slice(0, 120) });
  }

  emitSuccess("steer", { threadId, turnId, steered: true }, `Steered turn ${turnId} on thread ${threadId}\n`, {
    json: options.json,
    startedAt
  });
}

async function handleRespond(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["question-id", "answer", "json-payload", "cwd", "backend"],
    booleanOptions: ["json"]
  });

  const requestId = positionals[0];
  if (!requestId) {
    throw usageError("respond requires <request-id>");
  }

  const cwd = resolveCommandCwd(options);
  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const adapter = await resolveCommandAdapter({
    cwd,
    workspaceRoot: resolveWorkspaceRoot(cwd),
    backend: options.backend ?? null,
  });
  ensureCodexRuntimeAdapter(adapter);
  guardCapability(adapter, "supports_questions");

  // Look up the pending request from disk (written by the worker process)
  const pending = readPendingRequestById(sessionDir, requestId);
  if (!pending) {
    throw notFoundError(
      `No pending request found: ${requestId}.`,
      "PENDING_REQUEST_NOT_FOUND",
      "It may have timed out or already been answered."
    );
  }

  let payload;
  if (options["json-payload"]) {
    try {
      payload = JSON.parse(options["json-payload"]);
    } catch (error) {
      throw usageError(
        `respond --json-payload must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    const answer = options.answer;
    if (!answer) {
      throw usageError("respond requires --answer");
    }
    if (pending.method === "item/tool/requestUserInput") {
      const qId = options["question-id"] ?? pending.firstQuestionId ?? "q1";
      payload = { answers: { [qId]: { answers: [answer] } } };
    } else {
      payload = { decision: answer };
    }
  }

  // The adapter writes the response file — the worker process polls for this
  // and sends the response on its own connection, which holds the original
  // app-server request.
  await adapter.respond(pending.threadId, requestId, payload, { sessionDir });

  const session = findSession(sessionDir, pending.threadId);
  if (session) {
    logNdjson(session, "SERVER_RESPONSE", null, { requestId, payload });
  }

  emitSuccess(
    "respond",
    { status: "responded", requestId, threadId: pending.threadId },
    `Response written for ${requestId}. Worker will deliver it.\n`,
    { json: options.json, startedAt }
  );
}

async function handleSummary(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["tail", "cwd"],
    booleanOptions: ["json"]
  });

  const threadId = positionals[0];
  if (!threadId) {
    throw usageError("summary requires <thread-id>");
  }

  const cwd = resolveCommandCwd(options);
  const config = getBridgeConfig(cwd, resolveWorkspaceRoot(cwd));
  const sessionDir = resolveSessionDir(config.session_dir, resolveWorkspaceRoot(cwd));
  const session = findSession(sessionDir, threadId);
  if (!session) {
    throw notFoundError(
      `No session found for thread ${threadId}`,
      "SESSION_NOT_FOUND"
    );
  }

  const tailLines = parseInt(options.tail) || 200;
  let content;
  try {
    content = fs.readFileSync(session.ndjsonPath, "utf8");
  } catch {
    throw new CliError(
      `Cannot read session log: ${session.ndjsonPath}`,
      { class: "internal", code: "SESSION_LOG_UNREADABLE", retryable: false }
    );
  }

  const allLines = content.split("\n").filter(Boolean);
  const lines = allLines.slice(-tailLines);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  const transcript = buildTranscript(entries, threadId);
  emitSuccess("summary", { threadId, entries }, `${transcript}\n`, {
    json: options.json,
    startedAt
  });
}

function buildTranscript(entries, threadId) {
  const lines = [`## Thread ${threadId}`];
  let currentTurnId = null;
  let turnIndex = 0;

  for (const entry of entries) {
    if (entry.tag === "TURN_STARTED" || (entry.method === "turn/started" && entry.data?.turn?.id)) {
      turnIndex += 1;
      currentTurnId = entry.data?.turn?.id ?? entry.data?.turnId ?? `turn-${turnIndex}`;
      const ts = entry.ts ? entry.ts.slice(11, 19) : "";
      lines.push("", `### Turn ${turnIndex} — ${ts}`);
      continue;
    }

    if (entry.method === "item/completed") {
      const item = entry.data?.item ?? entry.data ?? {};
      if (item.type === "userMessage") {
        const text = item.content?.map((c) => c.text).join(" ") ?? "";
        lines.push(`> ${text}`);
      } else if (item.type === "agentMessage") {
        lines.push("", `**Assistant:** ${item.text ?? ""}`);
      } else if (item.type === "plan") {
        lines.push("", `**Plan proposed:**`, item.text ?? "");
      } else if (item.type === "commandExecution") {
        const cmd = (item.command ?? "").slice(0, 200);
        lines.push(`tool: shell ${cmd}`);
      } else if (item.type === "fileChange") {
        const files = (item.changes ?? []).map((c) => c.path).join(", ");
        lines.push(`tool: apply_patch ${files.slice(0, 200)}`);
      } else if (item.type === "exitedReviewMode") {
        lines.push("", `**Review:** ${item.review ?? ""}`);
      }
      continue;
    }

    if (entry.tag === "ERROR") {
      lines.push("", `**Error:** ${entry.data?.message ?? JSON.stringify(entry.data)}`);
    }
  }

  return lines.join("\n");
}

// ── MAIN ──────────────────────────────────────────────────────────────────

const SUBCOMMAND_DISPATCH = Object.freeze({
  setup: handleSetup,
  version: handleVersion,
  update: handleUpdate,
  config: handleConfig,
  "auth-status": handleAuthStatus,
  review: handleReview,
  "adversarial-review": (argv) => handleReviewCommand(argv, { reviewName: "Adversarial Review" }),
  task: handleTask,
  "task-worker": handleTaskWorker,
  send: handleSend,
  steer: handleSteer,
  respond: handleRespond,
  summary: handleSummary,
  status: handleStatus,
  result: handleResult,
  wait: handleWait,
  events: handleEvents,
  "task-resume-candidate": handleTaskResumeCandidate,
  cancel: handleCancel,
  "await-artifact": handleAwaitArtifact,
  merge: handleMerge,
  verdict: handleVerdict,
  verdicts: handleVerdictsPending,
  iterate: handleIterate,
  doctor: handleDoctor
});

// Node's default SIGPIPE handling terminates the process when a downstream
// reader closes the pipe (e.g. `codex-bridge task | head -10`). For the
// foreground `task` / `send` / `review` paths that emit streaming progress to
// stdout, this kills the wrapper mid-turn and orphans the Codex thread — the
// app-server keeps running but our supervisor process is gone, leaving jobs
// stuck in `orphaned` state. Background workers are immune (they use
// `stdio:"ignore"`); this guard makes every foreground command path equally
// tolerant of downstream pipe closure. See `fix/three-live-bugs` plan.
process.on("SIGPIPE", () => {});
process.stdout.on("error", (err) => {
  if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) return;
  throw err;
});
process.stderr.on("error", (err) => {
  if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) return;
  throw err;
});

// Crash-report trap. Prior to v1.2.5 an unhandled rejection or uncaught
// exception between "detached worker spawned" and "envelope emitted" could
// silently exit the wrapper with status 1 while the worker kept running —
// the user saw "launcher exit 1, detached job healthy" with no diagnostic.
// Any such event now writes a JSON dump to ~/.codex-bridge/crashes/<ts>-<pid>.log
// and emits a single stderr line pointing at it. We still propagate the
// process exit (not going to swallow real crashes), but the trail closes the
// "exit 1 without explanation" observability gap.
function writeCrashLog(kind, error) {
  try {
    const crashDir = path.join(os.homedir(), ".codex-bridge", "crashes");
    fs.mkdirSync(crashDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(crashDir, `${ts}-${process.pid}.log`);
    const payload = {
      kind,
      ts,
      pid: process.pid,
      argv: process.argv,
      cwd: process.cwd(),
      nodeVersion: process.version,
      bridgeVersion: BRIDGE_VERSION,
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack, code: error.code }
        : { raw: String(error) }
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    try {
      process.stderr.write(
        `[codex-bridge] internal ${kind}: ${error?.message ?? error} — crash report at ${file}\n`
      );
    } catch { /* stderr already closed; file is enough */ }
  } catch { /* best-effort; never throw from the trap */ }
}
process.on("unhandledRejection", (reason) => {
  writeCrashLog("unhandledRejection", reason);
  process.exitCode = process.exitCode || 1;
});
process.on("uncaughtException", (err) => {
  writeCrashLog("uncaughtException", err);
  process.exit(process.exitCode || 1);
});

async function main() {
  const startedAt = Date.now();
  const rawArgv = process.argv.slice(2);
  const [subcommand, ...argv] = rawArgv;

  // Hot-path auto-apply. Non-blocking fire-and-forget: cache-backed
  // release probe (1 h TTL, anonymous) + detached `npx skills@latest add
  // …` when a newer version lands. Rate-limited to one apply attempt per
  // hour so concurrent invocations don't thrash. Stdio routed to
  // `~/.codex-bridge/auto-update.log` so the caller's output is never
  // touched. Opt out via `CODEX_BRIDGE_NO_UPDATE_CHECK=1`.
  maybeTriggerAutoApply(rawArgv, subcommand);

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    if (detectJsonFlag(rawArgv)) {
      emitSuccess("help", buildMachineReadableHelp(), null, { json: true, startedAt });
      return;
    }
    printUsage();
    return;
  }

  // Per-subcommand --help / -h short-circuits before the handler runs so we
  // never fire a Codex turn just to answer a discovery query. Pass the full
  // rawArgv so the per-subcommand prompt-skipping in detectHelpFlag sees the
  // subcommand at index 0.
  if (COMMANDS[subcommand] && detectHelpFlag(rawArgv)) {
    printSubcommandUsage(subcommand);
    return;
  }

  const handler = SUBCOMMAND_DISPATCH[subcommand];
  if (!handler) {
    throw new CliError(`Unknown subcommand: ${subcommand}`, {
      class: "usage",
      code: "UNKNOWN_SUBCOMMAND",
      retryable: false,
      suggestion: "Run `help --json` to list available subcommands."
    });
  }

  await handler(argv);
}

main().catch((error) => {
  const rawArgv = process.argv.slice(2);
  const json = detectJsonFlag(rawArgv);
  const command = rawArgv[0] && COMMANDS[rawArgv[0]] ? rawArgv[0] : null;
  emitError(error, { json, command });
});
