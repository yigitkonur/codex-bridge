import assert from "node:assert/strict";
import test from "node:test";

import {
  AdapterError,
  _resetAdapterCache,
  getErrorMapper,
  guardCapability,
  registerErrorMapper,
  selectAdapter,
} from "../src/adapters/index.mjs";

test("selectAdapter loads the codex adapter and exposes frozen capabilities", async () => {
  _resetAdapterCache();

  const adapter = await selectAdapter({ backend: "codex" });
  const capabilities = adapter.capabilities();

  assert.equal(adapter.name, "codex");
  assert.equal(capabilities.supports_plan_mode, true);
  assert.equal(Object.isFrozen(capabilities), true);
});

test("selectAdapter rejects unknown backends with AdapterError details", async () => {
  _resetAdapterCache();

  await assert.rejects(
    () => selectAdapter({ backend: "gemini" }),
    (err) => {
      assert.equal(err instanceof AdapterError, true);
      assert.equal(err.code, "BACKEND_INCAPABLE");
      assert.match(err.message, /Unknown backend 'gemini'/);
      return true;
    },
  );
});

test("selectAdapter applies adapter_routing across config layers before default_backend", async () => {
  _resetAdapterCache();

  await assert.rejects(
    () =>
      selectAdapter({
        subagentType: "worker",
        cwdConfig: { adapter_routing: { worker: { backend: "gemini" } } },
        workspaceConfig: {
          adapter_routing: { worker: { backend: "codex" } },
          default_backend: "codex",
        },
      }),
    /Unknown backend 'gemini'/,
  );

  await assert.rejects(
    () =>
      selectAdapter({
        subagentType: "worker",
        userConfig: { adapter_routing: { worker: { backend: "gemini" } } },
        defaultBackend: "codex",
      }),
    /Unknown backend 'gemini'/,
  );
});

test("guardCapability only accepts boolean support flags", async () => {
  _resetAdapterCache();

  const adapter = await selectAdapter({ backend: "codex" });

  assert.doesNotThrow(() => guardCapability(adapter, "supports_plan_mode"));
  assert.throws(
    () => guardCapability(adapter, "max_prompt_chars"),
    (err) => {
      assert.equal(err instanceof AdapterError, true);
      assert.equal(err.code, "BACKEND_INCAPABLE");
      assert.match(err.message, /not a boolean support flag/);
      return true;
    },
  );
});

test("_resetAdapterCache clears registered error mappers", () => {
  registerErrorMapper("codex", () => ({ code: "X", class: "test" }));
  assert.equal(typeof getErrorMapper("codex"), "function");

  _resetAdapterCache();
  assert.equal(getErrorMapper("codex"), undefined);
});
