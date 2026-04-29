import test from "node:test";
import assert from "node:assert/strict";

import {
  loadAdapter,
  selectAdapter,
  guardCapability,
  registerErrorMapper,
  getErrorMapper,
  AdapterError,
  _resetAdapterCache,
} from "../src/adapters/index.mjs";

test("selectAdapter({backend:'codex'}) resolves the codex adapter", async () => {
  _resetAdapterCache();
  const adapter = await selectAdapter({ backend: "codex" });
  assert.equal(adapter.name, "codex");
  assert.equal(adapter.displayName, "OpenAI Codex");
  assert.equal(typeof adapter.capabilities, "function");
});

test("selectAdapter({}) falls back to the built-in default backend", async () => {
  _resetAdapterCache();
  const adapter = await selectAdapter({});
  assert.equal(adapter.name, "codex");
});

test("selectAdapter({backend:'unknown'}) rejects with BACKEND_INCAPABLE", async () => {
  _resetAdapterCache();
  await assert.rejects(
    selectAdapter({ backend: "unknown" }),
    (err) =>
      err instanceof AdapterError &&
      err.code === "BACKEND_INCAPABLE" &&
      err.message.includes("Unknown backend"),
  );
});

test("cwdConfig.default_backend wins over workspaceConfig.default_backend", async () => {
  _resetAdapterCache();
  // Both layers define a backend; cwd should win per the documented
  // resolution order (cwd > workspace > user > built-in default).
  // Assert by observing the error message — if cwd is tried first,
  // the error names cwd's value. If workspace were tried first, the
  // error would name workspace's value instead.
  await assert.rejects(
    selectAdapter({
      cwdConfig: { default_backend: "cwd-backend" },
      workspaceConfig: { default_backend: "workspace-backend" },
    }),
    (err) =>
      err instanceof AdapterError &&
      err.code === "BACKEND_INCAPABLE" &&
      err.message.includes("cwd-backend"),
  );
});

test("envBackend wins over config layers when set", async () => {
  _resetAdapterCache();
  await assert.rejects(
    selectAdapter({
      envBackend: "env-backend",
      cwdConfig: { default_backend: "cwd-backend" },
    }),
    (err) =>
      err instanceof AdapterError && err.message.includes("env-backend"),
  );
});

test("backend (CLI flag) wins over every other layer", async () => {
  _resetAdapterCache();
  await assert.rejects(
    selectAdapter({
      backend: "cli-flag",
      envBackend: "env-backend",
      metaBackend: "meta-backend",
      cwdConfig: { default_backend: "cwd-backend" },
      workspaceConfig: { default_backend: "workspace-backend" },
      userConfig: { default_backend: "user-backend" },
      defaultBackend: "fallback",
    }),
    (err) =>
      err instanceof AdapterError && err.message.includes("cli-flag"),
  );
});

test("subagentType routing resolves through workspaceConfig.adapter_routing", async () => {
  _resetAdapterCache();
  const adapter = await selectAdapter({
    subagentType: "Explore",
    workspaceConfig: {
      adapter_routing: { Explore: { backend: "codex" } },
    },
  });
  assert.equal(adapter.name, "codex");
});

test("loadAdapter caches resolved adapters between calls", async () => {
  _resetAdapterCache();
  const first = await loadAdapter("codex");
  const second = await loadAdapter("codex");
  assert.equal(first, second);
});

test("guardCapability passes when the flag is true", async () => {
  _resetAdapterCache();
  const adapter = await loadAdapter("codex");
  assert.doesNotThrow(() => guardCapability(adapter, "supports_plan_mode"));
  assert.doesNotThrow(() => guardCapability(adapter, "supports_streaming"));
  assert.doesNotThrow(() => guardCapability(adapter, "supports_worktree"));
});

test("guardCapability throws BACKEND_INCAPABLE when the flag is missing or false", async () => {
  _resetAdapterCache();
  const adapter = await loadAdapter("codex");
  assert.throws(
    () => guardCapability(adapter, "supports_unicorn"),
    (err) =>
      err instanceof AdapterError &&
      err.code === "BACKEND_INCAPABLE" &&
      err.details?.capability === "supports_unicorn",
  );
});

test("registerErrorMapper round-trips with getErrorMapper", () => {
  const mapper = (err) => ({ code: "TEST", class: "test" });
  registerErrorMapper("test-adapter", mapper);
  assert.equal(getErrorMapper("test-adapter"), mapper);
});

test("registerErrorMapper rejects non-function values", () => {
  assert.throws(
    () => registerErrorMapper("bad-adapter", "not a function"),
    (err) =>
      err instanceof AdapterError && err.code === "BACKEND_INCAPABLE",
  );
});

test("AdapterError carries code, message, and details", () => {
  const err = new AdapterError("TEST_CODE", "test message", { detail: 1 });
  assert.equal(err.code, "TEST_CODE");
  assert.equal(err.message, "test message");
  assert.deepEqual(err.details, { detail: 1 });
  assert.ok(err instanceof Error);
});

test("codex adapter declares the canonical capability shape", async () => {
  _resetAdapterCache();
  const adapter = await loadAdapter("codex");
  const caps = adapter.capabilities();

  // Required canonical flags from src/adapters/_interface/CAPABILITIES.md.
  for (const flag of [
    "supports_plan_mode",
    "supports_questions",
    "supports_streaming",
    "supports_resume",
    "supports_steering",
    "supports_background",
    "supports_auto_pipeline",
    "supports_adversarial_review",
    "supports_worktree",
    "supports_artifact_registry",
  ]) {
    assert.equal(typeof caps[flag], "boolean", `${flag} should be boolean`);
  }
  assert.ok(Array.isArray(caps.input_modalities));
  assert.ok(Array.isArray(caps.output_modalities));
  assert.equal(typeof caps.max_prompt_chars, "number");
  assert.ok(["subscription", "metered", "local"].includes(caps.billing_model));
  assert.ok(["oauth-cli", "api-key", "none", "ssh-key"].includes(caps.auth_strategy));
  assert.equal(typeof caps.transport, "string");
});

test("selectAdapter throws when every layer is empty", async () => {
  _resetAdapterCache();
  await assert.rejects(
    selectAdapter({ defaultBackend: "" }),
    (err) =>
      err instanceof AdapterError &&
      err.code === "BACKEND_INCAPABLE" &&
      err.message.includes("No backend resolved"),
  );
});
