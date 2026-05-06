import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SANDBOX_ENFORCEMENT_MARKER_KEY = "_codex_bridge_sandbox_enforce";
export const SANDBOX_ENFORCEMENT_MARKER_VALUE = "codex-bridge";

export const SANDBOX_ENFORCEMENT_DENY_RULES = Object.freeze([
  {
    tool: "Bash",
    matcher: { command: ".*codex-bridge(?:\\.mjs)?\\s+task\\b.*--read-only" },
    reason: "sandbox.enforce: true (workspace policy) - --read-only forbidden",
    [SANDBOX_ENFORCEMENT_MARKER_KEY]: SANDBOX_ENFORCEMENT_MARKER_VALUE,
  },
  {
    tool: "Bash",
    matcher: {
      command: ".*codex\\s+(?:exec\\s+)?.*(?:--sandbox(?:\\s+|=)|-s(?:\\s+|=))(?:read-only|workspace-write)",
    },
    reason: "Direct codex CLI sandbox downgrade forbidden",
    [SANDBOX_ENFORCEMENT_MARKER_KEY]: SANDBOX_ENFORCEMENT_MARKER_VALUE,
  },
]);

export function resolveClaudeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export function readClaudeSettings(settingsPath = resolveClaudeSettingsPath()) {
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

export function writeClaudeSettings(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tmpPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, settingsPath);
}

export function hasSandboxEnforcement(settings) {
  const deny = settings?.permissions?.deny;
  return Array.isArray(deny) && deny.filter((rule) =>
    rule?.[SANDBOX_ENFORCEMENT_MARKER_KEY] === SANDBOX_ENFORCEMENT_MARKER_VALUE
  ).length === SANDBOX_ENFORCEMENT_DENY_RULES.length;
}

export function getSandboxEnforcementStatus(settingsPath = resolveClaudeSettingsPath()) {
  const read = readClaudeSettings(settingsPath);
  return {
    installed: read.settings ? hasSandboxEnforcement(read.settings) : false,
    settingsPath,
    settingsExists: read.exists,
    settingsParseError: read.parseError,
    markerKey: SANDBOX_ENFORCEMENT_MARKER_KEY,
  };
}

function assertSettingsShape(settingsPath, read, action) {
  if (read.parseError) {
    throw new Error(`Cannot ${action} sandbox enforcement in ${settingsPath}: ${read.parseError}.`);
  }
  const settings = read.settings ?? {};
  if (settings.permissions == null) settings.permissions = {};
  if (!settings.permissions || typeof settings.permissions !== "object" || Array.isArray(settings.permissions)) {
    throw new Error(`Cannot ${action} sandbox enforcement in ${settingsPath}: permissions must be a JSON object.`);
  }
  if (settings.permissions.deny == null) settings.permissions.deny = [];
  if (!Array.isArray(settings.permissions.deny)) {
    throw new Error(`Cannot ${action} sandbox enforcement in ${settingsPath}: permissions.deny must be an array.`);
  }
  return settings;
}

export function installSandboxEnforcement(settingsPath = resolveClaudeSettingsPath()) {
  const read = readClaudeSettings(settingsPath);
  const settings = assertSettingsShape(settingsPath, read, "install");
  const alreadyInstalled = hasSandboxEnforcement(settings);
  if (!alreadyInstalled) {
    settings.permissions.deny = settings.permissions.deny.filter((rule) =>
      rule?.[SANDBOX_ENFORCEMENT_MARKER_KEY] !== SANDBOX_ENFORCEMENT_MARKER_VALUE
    );
    settings.permissions.deny.push(...SANDBOX_ENFORCEMENT_DENY_RULES);
    writeClaudeSettings(settingsPath, settings);
  }
  return {
    alreadyInstalled,
    status: getSandboxEnforcementStatus(settingsPath),
  };
}

export function uninstallSandboxEnforcement(settingsPath = resolveClaudeSettingsPath()) {
  const read = readClaudeSettings(settingsPath);
  const settings = assertSettingsShape(settingsPath, read, "uninstall");
  const before = settings.permissions.deny.length;
  settings.permissions.deny = settings.permissions.deny.filter((rule) =>
    rule?.[SANDBOX_ENFORCEMENT_MARKER_KEY] !== SANDBOX_ENFORCEMENT_MARKER_VALUE
  );
  const removed = before - settings.permissions.deny.length;
  if (removed > 0 || !read.exists) {
    writeClaudeSettings(settingsPath, settings);
  }
  return {
    removed,
    status: getSandboxEnforcementStatus(settingsPath),
  };
}
