// Backend adapter registry. See ./index.d.ts for the contract,
// ./_interface/INTERFACE.md for the prose version, and
// ./_interface/CAPABILITIES.md for the resolution order.

import codexAdapter from "./codex/index.mjs";

const REQUIRED_FIELDS = ["name", "displayName"];
const REQUIRED_METHODS = ["capabilities", "validateConfig", "dispatch", "streamEvents", "getResult", "cancel"];

const ADAPTER_LOADERS = {
  codex: () => codexAdapter,
};

// v2.0 ships only codex. Future adapters are added here when their
// index.mjs is implemented; stub directories under src/adapters/ are
// documentation, not a promise that loadAdapter will succeed.
const KNOWN_ADAPTERS = Object.keys(ADAPTER_LOADERS);

const adapterCache = new Map();
const errorMappers = new Map();

export class AdapterError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.details = details;
  }
}

function validateAdapter(adapter, name) {
  if (!adapter || typeof adapter !== "object") {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      `Adapter '${name}' default export is not an object`,
    );
  }
  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(adapter, field)) {
      throw new AdapterError(
        "BACKEND_INCAPABLE",
        `Adapter '${name}' missing required field: ${field}`,
      );
    }
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new AdapterError(
        "BACKEND_INCAPABLE",
        `Adapter '${name}' missing required method: ${method}`,
      );
    }
  }
  if (adapter.name !== name) {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      `Adapter at '${name}/index.mjs' declares name='${adapter.name}', expected '${name}'`,
    );
  }
}

export async function loadAdapter(name) {
  if (!KNOWN_ADAPTERS.includes(name)) {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      `Unknown backend '${name}'. Known: ${KNOWN_ADAPTERS.join(", ")}`,
    );
  }
  const cached = adapterCache.get(name);
  if (cached) return cached;

  const adapter = ADAPTER_LOADERS[name]();
  validateAdapter(adapter, name);
  adapterCache.set(name, adapter);
  return adapter;
}

// Resolution order documented in ./_interface/CAPABILITIES.md.
// Highest precedence first; first non-empty string wins.
export async function selectAdapter(options = {}) {
  // Validate config layer shape to prevent silent access errors
  if (options.cwdConfig && typeof options.cwdConfig !== "object") {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      "selectAdapter: cwdConfig must be an object",
    );
  }
  if (options.workspaceConfig && typeof options.workspaceConfig !== "object") {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      "selectAdapter: workspaceConfig must be an object",
    );
  }
  if (options.userConfig && typeof options.userConfig !== "object") {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      "selectAdapter: userConfig must be an object",
    );
  }

  const candidates = [
    options.backend,
    options.envBackend,
    options.metaBackend,
    options.subagentType
      ? options.cwdConfig?.adapter_routing?.[options.subagentType]?.backend
      : undefined,
    options.subagentType
      ? options.workspaceConfig?.adapter_routing?.[options.subagentType]?.backend
      : undefined,
    options.subagentType
      ? options.userConfig?.adapter_routing?.[options.subagentType]?.backend
      : undefined,
    options.cwdConfig?.default_backend,
    options.workspaceConfig?.default_backend,
    options.userConfig?.default_backend,
    options.defaultBackend ?? "codex",
  ];
  const name = candidates.find((c) => typeof c === "string" && c.length > 0);
  if (!name) {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      "No backend resolved (all layers empty)",
    );
  }
  return loadAdapter(name);
}

export function guardCapability(adapter, capability) {
  const caps = adapter.capabilities();
  if (!capability.startsWith("supports_") || typeof caps[capability] !== "boolean") {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      `Capability '${capability}' is not a boolean support flag`,
      { backend: adapter.name, capability },
    );
  }
  if (caps[capability] !== true) {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      `Backend '${adapter.name}' does not support capability '${capability}'`,
      { backend: adapter.name, capability },
    );
  }
}

export function registerErrorMapper(adapterName, mapper) {
  if (typeof mapper !== "function") {
    throw new AdapterError(
      "BACKEND_INCAPABLE",
      `registerErrorMapper(${adapterName}): mapper must be a function`,
    );
  }
  errorMappers.set(adapterName, mapper);
}

export function getErrorMapper(adapterName) {
  return errorMappers.get(adapterName);
}

// Test-only helper.
export function _resetAdapterCache() {
  adapterCache.clear();
  errorMappers.clear();
}
