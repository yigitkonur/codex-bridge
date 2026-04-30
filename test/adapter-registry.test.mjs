import assert from "node:assert/strict";
import test from "node:test";

import {
  AdapterError,
  _resetAdapterCache,
  _validateAdapterForTest,
  getErrorMapper,
  guardCapability,
  registerErrorMapper,
  selectAdapter,
} from "../src/adapters/index.mjs";
import { buildErrorEnvelope, classifyError, ExitCode } from "../src/lib/cli-errors.mjs";

const BASE_CAPABILITIES = Object.freeze({
  supports_plan_mode: true,
  supports_questions: false,
  supports_streaming: true,
  supports_resume: false,
  supports_steering: false,
  supports_background: true,
  supports_auto_pipeline: true,
  supports_adversarial_review: true,
  supports_worktree: true,
  supports_artifact_registry: true,
  input_modalities: ["text"],
  output_modalities: ["text", "diff", "structured"],
  max_prompt_chars: 512000,
  billing_model: "subscription",
  auth_strategy: "oauth-cli",
  transport: "json-rpc-unix-socket",
});

const OPTIONAL_CAPABILITY_METHODS = Object.freeze({
  supports_questions: "respond",
  supports_resume: "resume",
  supports_steering: "steer",
});

function makeAdapter({ capabilities = {}, methods = {} } = {}) {
  return {
    name: "test",
    displayName: "Test Adapter",
    capabilities() {
      return Object.freeze({ ...BASE_CAPABILITIES, ...capabilities });
    },
    validateConfig() {
      return { valid: true, errors: [] };
    },
    dispatch() {},
    async *streamEvents() {},
    getResult() {},
    cancel() {},
    ...methods,
  };
}

function assertBackendIncapable(err) {
  assert.equal(err instanceof AdapterError, true);
  assert.equal(err.code, "BACKEND_INCAPABLE");

  const classified = classifyError(err);
  assert.equal(classified.class, "validation");
  assert.equal(classified.code, "BACKEND_INCAPABLE");
  assert.equal(classified.exitCode, ExitCode.VALIDATION);

  const envelope = buildErrorEnvelope(classified, { command: "task" });
  assert.equal(envelope.error.code, "BACKEND_INCAPABLE");
  assert.equal(envelope.error.retryable, false);
}

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
      assertBackendIncapable(err);
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
      assertBackendIncapable(err);
      assert.match(err.message, /not a boolean support flag/);
      return true;
    },
  );
});

test("codex adapter under-declares optional lifecycle capabilities until handlers exist", async () => {
  _resetAdapterCache();

  const adapter = await selectAdapter({ backend: "codex" });
  const capabilities = adapter.capabilities();

  for (const [capability, method] of Object.entries(OPTIONAL_CAPABILITY_METHODS)) {
    assert.equal(capabilities[capability], false);
    assert.equal(adapter[method], undefined);
    assert.throws(
      () => guardCapability(adapter, capability),
      (err) => {
        assertBackendIncapable(err);
        assert.match(err.message, new RegExp(capability));
        return true;
      },
    );
  }
});

test("adapter validation rejects true optional lifecycle flags without handlers", () => {
  for (const [capability, method] of Object.entries(OPTIONAL_CAPABILITY_METHODS)) {
    const missingHandler = makeAdapter({
      capabilities: {
        [capability]: true,
      },
    });

    assert.throws(
      () => _validateAdapterForTest(missingHandler, "test"),
      (err) => {
        assertBackendIncapable(err);
        assert.match(err.message, new RegExp(`${capability}=true`));
        assert.equal(err.details.capability, capability);
        assert.equal(err.details.method, method);
        return true;
      },
    );

    const withHandler = makeAdapter({
      capabilities: {
        [capability]: true,
      },
      methods: {
        [method]: () => ({ ok: true }),
      },
    });
    assert.doesNotThrow(() => _validateAdapterForTest(withHandler, "test"));
  }
});

test("_resetAdapterCache clears registered error mappers", () => {
  registerErrorMapper("codex", () => ({ code: "X", class: "test" }));
  assert.equal(typeof getErrorMapper("codex"), "function");

  _resetAdapterCache();
  assert.equal(getErrorMapper("codex"), undefined);
});
