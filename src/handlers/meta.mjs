import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { guardCapability } from "../adapters/index.mjs";
import {
  getCodexAuthStatus,
  getCodexAvailability,
  getSessionRuntimeStatus,
} from "../adapters/codex/codex.mjs";
import { buildCollaborationMode, buildSandboxPolicy, COMPLETION_CHECK_SCHEMA, DEFAULT_CONFIG, resolveConfigLayers, resolveConfigSources, validateConfigLayers } from "../lib/config.mjs";
import { CliError, conflictError, emitError, emitSuccess, invalidThreadIdError, notFoundError, usageError, validationError, classifyError } from "../lib/cli-errors.mjs";
import { detectOfficialOpenAICodexPlugin, OFFICIAL_PLUGIN_STATUS } from "../lib/official-plugin.mjs";
import { readStopReviewGate, setStopReviewGate } from "../lib/stop-review-gate.mjs";
import { existsTask, jobDir, listTasks, readMeta, readVerdict, writeBriefArtifacts, writeMeta, writeVerdict } from "../lib/registry.mjs";
import { loadBrief, renderBriefAsMarkdown } from "../lib/brief.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "../lib/process.mjs";
import { getConfig, listJobs, resolveJobFile, setConfig, updateState, upsertJob, writeJobFile } from "../lib/state.mjs";
import { buildSingleJobSnapshot, buildStatusSnapshot, readStoredJob, resolveCancelableJob, resolveResultJob, sortJobsNewestFirst } from "../lib/job-control.mjs";
import { appendLogLine, createJobLogFile, createJobProgressUpdater, nowIso, runTrackedJob } from "../lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import { renderCancelReport, renderJobStatusReport, renderSetupReport, renderStatusReport, renderStoredJobResult } from "../lib/render.mjs";
import {
  captureGitDiff,
  findSession,
  formatDoneEvent,
  formatErrorEvent,
  formatIncompleteEvent,
  formatPlanEvent,
  initSession,
  logEvent,
  logNdjson,
  resolveSessionDir,
  TERMINAL_TAG_REGEX,
  writePlan,
} from "../lib/session-log.mjs";
import { readPendingRequestById } from "../lib/pending-requests.mjs";
import { readStdinIfPiped } from "../lib/fs.mjs";
import { mapReviewVerdictToTaskVerdict } from "../lib/review-result.mjs";
import { checkForUpdate, formatUpdateNotice } from "../lib/update-check.mjs";
import { runIterateLoop } from "../lib/iterate-loop.mjs";
import { createSubagentWorktree, ensureGitRepository, mergeSubagentBranch, resolveReviewTarget } from "../lib/git.mjs";
import { isThreadId } from "../lib/thread-id.mjs";
import {
  BRIDGE_CAPABILITIES,
  BRIDGE_SCHEMA_VERSION,
  BRIDGE_VERSION,
  DEFAULT_STATUS_POLL_INTERVAL_MS,
  DEFAULT_STATUS_WAIT_TIMEOUT_MS,
  ROOT_DIR,
  SCRIPT_PATH,
  STOP_REVIEW_GATE_LOCK_FILE,
} from "../lib/runtime-paths.mjs";
import { ensureCodexRuntimeAdapter, getBridgeConfig, loadDeveloperInstructions, resolveCommandAdapter } from "../lib/bridge-config.mjs";
import { bridgeCommand, buildMonitorHint, buildRecovery, extractItemText } from "../lib/envelope-helpers.mjs";
import { COMMANDS, EXIT_CODE_DOC, GLOBAL_FLAGS_DOC } from "../commands-meta.mjs";

const MONITOR_HOOK_EVENT = "PostToolUse";
const MONITOR_HOOK_MATCHER = "Bash|Agent";
const MONITOR_HOOK_SCRIPT = "tool.mjs";
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
} from "../lib/task-runtime.mjs";
import {
  normalizeReasoningEffort,
  normalizeRequestedModel,
  parseCommandInput,
  resolveCommandCwd,
  resolveCommandWorkspace,
  resolvePromptInput,
} from "../lib/handler-utils.mjs";
import { getSandboxEnforcementStatus, installSandboxEnforcement, uninstallSandboxEnforcement } from "../lib/sandbox-enforcement.mjs";

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

function resolveClaudeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function resolveMonitorHookScriptPath() {
  const candidates = [
    path.join(ROOT_DIR, "hooks", MONITOR_HOOK_SCRIPT),
    path.resolve(ROOT_DIR, "..", "hooks", MONITOR_HOOK_SCRIPT),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function monitorHookCommand(hookScriptPath) {
  return `node ${JSON.stringify(hookScriptPath)} PostToolUse`;
}

function buildMonitorHookEntry(hookScriptPath) {
  return {
    matcher: MONITOR_HOOK_MATCHER,
    hooks: [
      {
        type: "command",
        command: monitorHookCommand(hookScriptPath),
        timeout: 5,
      },
    ],
  };
}

function readClaudeSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return { exists: false, settings: {}, parseError: null };
  }
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        exists: true,
        settings: null,
        parseError: "settings file must contain a JSON object",
      };
    }
    return { exists: true, settings: parsed, parseError: null };
  } catch (err) {
    return {
      exists: true,
      settings: null,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

function hasMonitorHookMirror(settings, hookScriptPath) {
  const postToolUse = settings?.hooks?.[MONITOR_HOOK_EVENT];
  if (!Array.isArray(postToolUse)) return false;
  const command = monitorHookCommand(hookScriptPath);
  return postToolUse.some((entry) =>
    entry?.matcher === MONITOR_HOOK_MATCHER &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some((hook) =>
      hook?.type === "command" &&
      hook?.command === command
    )
  );
}

function getMonitorHookMirrorStatus() {
  const settingsPath = resolveClaudeSettingsPath();
  const hookScriptPath = resolveMonitorHookScriptPath();
  const read = readClaudeSettings(settingsPath);
  return {
    installed: read.settings ? hasMonitorHookMirror(read.settings, hookScriptPath) : false,
    settingsPath,
    settingsExists: read.exists,
    settingsParseError: read.parseError,
    hookScriptPath,
    hookScriptExists: fs.existsSync(hookScriptPath),
    installCommand: "codex-bridge setup --install-monitor-hook",
  };
}

function writeClaudeSettings(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tmpPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, settingsPath);
}

function installMonitorHookMirror() {
  const settingsPath = resolveClaudeSettingsPath();
  const hookScriptPath = resolveMonitorHookScriptPath();
  if (!fs.existsSync(hookScriptPath)) {
    throw validationError(
      `Cannot install Monitor hook mirror because ${MONITOR_HOOK_SCRIPT} was not found at ${hookScriptPath}.`,
      "MONITOR_HOOK_SCRIPT_MISSING",
      "Run this from a packaged codex-bridge plugin install, or arm Monitor manually from result.monitor.tool_hint.",
    );
  }

  const read = readClaudeSettings(settingsPath);
  if (read.parseError) {
    throw validationError(
      `Cannot update ${settingsPath}: ${read.parseError}.`,
      "CLAUDE_SETTINGS_PARSE_ERROR",
      "Fix ~/.claude/settings.json so it is valid JSON, then rerun setup --install-monitor-hook.",
    );
  }

  const settings = read.settings ?? {};
  if (settings.hooks == null) {
    settings.hooks = {};
  }
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    throw validationError(
      `Cannot update ${settingsPath}: hooks must be a JSON object.`,
      "CLAUDE_SETTINGS_HOOKS_INVALID",
      "Fix ~/.claude/settings.json hooks shape, then rerun setup --install-monitor-hook.",
    );
  }
  const existing = settings.hooks[MONITOR_HOOK_EVENT];
  if (existing == null) {
    settings.hooks[MONITOR_HOOK_EVENT] = [];
  } else if (!Array.isArray(existing)) {
    throw validationError(
      `Cannot update ${settingsPath}: hooks.${MONITOR_HOOK_EVENT} must be an array.`,
      "CLAUDE_SETTINGS_POST_TOOL_USE_INVALID",
      "Fix ~/.claude/settings.json hooks.PostToolUse shape, then rerun setup --install-monitor-hook.",
    );
  }

  const alreadyInstalled = hasMonitorHookMirror(settings, hookScriptPath);
  if (!alreadyInstalled) {
    settings.hooks[MONITOR_HOOK_EVENT].push(buildMonitorHookEntry(hookScriptPath));
    writeClaudeSettings(settingsPath, settings);
  }

  return {
    alreadyInstalled,
    status: getMonitorHookMirrorStatus(),
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
  const monitorHook = getMonitorHookMirrorStatus();
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
  if (monitorHook.settingsParseError) {
    nextSteps.push(`Monitor hook mirror status could not read ${monitorHook.settingsPath}: ${monitorHook.settingsParseError}.`);
  } else if (!monitorHook.installed && monitorHook.hookScriptExists) {
    nextSteps.push("Optional: run `codex-bridge setup --install-monitor-hook` to mirror the Monitor PostToolUse hook into Claude user settings.");
  } else if (!monitorHook.installed && !monitorHook.hookScriptExists) {
    nextSteps.push("Monitor hook mirror unavailable in this install; arm Monitor manually from `result.monitor.tool_hint` after background dispatch.");
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
    monitorHookInstalled: monitorHook.installed,
    monitorHookSettingsPath: monitorHook.settingsPath,
    monitorHookSettingsExists: monitorHook.settingsExists,
    monitorHookSettingsParseError: monitorHook.settingsParseError,
    monitorHookScriptPath: monitorHook.hookScriptPath,
    monitorHookScriptExists: monitorHook.hookScriptExists,
    monitorHookInstallCommand: monitorHook.installCommand,
    sandboxEnforcementInstalled: sandboxEnforcement.installed,
    sandboxEnforcementSettingsPath: sandboxEnforcement.settingsPath,
    sandboxEnforcementSettingsExists: sandboxEnforcement.settingsExists,
    sandboxEnforcementSettingsParseError: sandboxEnforcement.settingsParseError,
    actionsTaken,
    nextSteps
  };
}

export async function handleSetup(argv) {
  const startedAt = Date.now();
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate", "install-monitor-hook", "enforce-sandbox", "disable-sandbox-enforcement"]
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

  if (options["install-monitor-hook"]) {
    const result = installMonitorHookMirror();
    actionsTaken.push(
      result.alreadyInstalled
        ? `Monitor PostToolUse hook mirror already present in ${result.status.settingsPath}.`
        : `Installed Monitor PostToolUse hook mirror in ${result.status.settingsPath}.`
    );
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

export async function handleVersion(argv) {
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
export async function handleConfigShow(argv) {
  const startedAt = Date.now();
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const action = positionals[0] ?? "show";
  if (action !== "show") {
    throw usageError(
      `config: unknown action '${action}'. Supported: show.`
    );
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sources = resolveConfigSources(ROOT_DIR, cwd, workspaceRoot);
  const effective = getBridgeConfig(cwd, workspaceRoot);
  const diagnostics = validateConfigLayers(ROOT_DIR, cwd, workspaceRoot);

  // Diff against defaults so the caller can see which keys were overridden
  // (useful for a human-eyeballing the output).
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
  for (const [k, v] of Object.entries(effective)) {
    const marker = Object.prototype.hasOwnProperty.call(overrides, k) ? "*" : " ";
    const preview = typeof v === "string" && v.length > 70 ? `${v.slice(0, 67)}...` : JSON.stringify(v);
    lines.push(`  ${marker} ${k}: ${preview}`);
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
}

// Check for updates and print a human-readable verdict plus the one-command
// install recipe. Pass --force to bypass the cache. Never mutates the
// installed skill itself —
// updates land via `npx skills …` from the user's shell, not from inside
// the bridge. This keeps the bridge's blast radius tight (no self-modify)
// and means a failed update check is always recoverable: try again later.
export async function handleUpdate(argv) {
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

export async function handleAuthStatus(argv) {
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

export function buildMachineReadableHelp() {
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
      { flag: "--cwd <dir>", alias: "-C", description: "Parsed before or after the subcommand; overrides the working directory for all bridge operations." },
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
