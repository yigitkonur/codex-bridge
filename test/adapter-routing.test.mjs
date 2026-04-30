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
  _resetErrorMappers,
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

test("envBackend wins over metaBackend (layer 2 beats layer 3)", async () => {
  _resetAdapterCache();
  await assert.rejects(
    selectAdapter({
      envBackend: "env-backend",
      metaBackend: "meta-backend",
    }),
    (err) =>
      err instanceof AdapterError && err.message.includes("env-backend"),
  );
});

test("metaBackend wins over adapter_routing and default_backend layers", async () => {
  _resetAdapterCache();
  // metaBackend is layer 3 in CAPABILITIES.md; routing and default_backend
  // layers (4–7) must not overrule it. Without this assertion a refactor
  // that demoted metaBackend below routing could pass the rest of the suite.
  await assert.rejects(
    selectAdapter({
      metaBackend: "meta-backend",
      subagentType: "Explore",
      cwdConfig: {
        adapter_routing: { Explore: { backend: "cwd-route" } },
        default_backend: "cwd-backend",
      },
    }),
    (err) =>
      err instanceof AdapterError && err.message.includes("meta-backend"),
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

test("cwd adapter_routing wins over workspace and user routing", async () => {
  _resetAdapterCache();
  await assert.rejects(
    selectAdapter({
      subagentType: "Explore",
      cwdConfig: {
        adapter_routing: { Explore: { backend: "cwd-route" } },
      },
      workspaceConfig: {
        adapter_routing: { Explore: { backend: "workspace-route" } },
      },
      userConfig: {
        adapter_routing: { Explore: { backend: "user-route" } },
      },
    }),
    (err) =>
      err instanceof AdapterError &&
      err.code === "BACKEND_INCAPABLE" &&
      err.message.includes("cwd-route"),
  );
});

test("user adapter_routing wins over every default_backend layer", async () => {
  _resetAdapterCache();
  // All routing layers (cwd/workspace/user) precede every default_backend
  // layer. With cwd/workspace/user default_backend set but only userConfig
  // carrying adapter_routing, the user-route value must win — even though
  // a buggy implementation that put cwd default_backend ahead of user
  // routing would otherwise resolve "cwd-backend".
  await assert.rejects(
    selectAdapter({
      subagentType: "Explore",
      cwdConfig: { default_backend: "cwd-backend" },
      workspaceConfig: { default_backend: "workspace-backend" },
      userConfig: {
        adapter_routing: { Explore: { backend: "user-route" } },
        default_backend: "user-backend",
      },
    }),
    (err) =>
      err instanceof AdapterError &&
      err.code === "BACKEND_INCAPABLE" &&
      err.message.includes("user-route"),
  );
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

  const falseCapabilityAdapter = {
    name: "stub-backend",
    capabilities: () => ({ supports_explicit_false: false }),
  };
  assert.throws(
    () => guardCapability(falseCapabilityAdapter, "supports_explicit_false"),
    (err) =>
      err instanceof AdapterError &&
      err.code === "BACKEND_INCAPABLE" &&
      err.details?.backend === "stub-backend" &&
      err.details?.capability === "supports_explicit_false",
  );
});

test("registerErrorMapper round-trips with getErrorMapper", () => {
  _resetErrorMappers();
  const mapper = (err) => ({ code: "TEST", class: "test" });
  registerErrorMapper("test-adapter", mapper);
  assert.equal(getErrorMapper("test-adapter"), mapper);
});

test("registerErrorMapper rejects non-function values", () => {
  _resetErrorMappers();
  assert.throws(
    () => registerErrorMapper("bad-adapter", "not a function"),
    (err) =>
      err instanceof AdapterError && err.code === "BACKEND_INCAPABLE",
  );
  // Confirm the rejected value did not get installed.
  assert.equal(getErrorMapper("bad-adapter"), undefined);
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
