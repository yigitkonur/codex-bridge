import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const hookPath = path.join(root, "plugin/hooks/user-prompt-submit.mjs");

function makeTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-prompt-home-"));
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-prompt-data-"));
  return { home, pluginData };
}

function runHook(input, env = {}) {
  const result = spawnSync(process.execPath, [hookPath], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_BRIDGE_HOOK_DISABLE: "",
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout, parsed: JSON.parse(result.stdout) };
}

function planMarkerPathFor(sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9._-]+/g, "-") || "default";
  return path.join(os.tmpdir(), `codex-bridge-${safe}.plan-mode-pin`);
}

function cleanMarker(sessionId) {
  try {
    fs.rmSync(planMarkerPathFor(sessionId), { force: true });
  } catch {
    // ignore
  }
}

test("UserPromptSubmit pins plan mode when prompt contains 'plan' keyword", () => {
  const { home, pluginData } = makeTempHome();
  const sessionId = `plan-test-${process.pid}-1`;
  cleanMarker(sessionId);
  try {
    const { parsed } = runHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "plan a refactor of src/foo.ts",
        session_id: sessionId,
      },
      { HOME: home, CODEX_BRIDGE_PLUGIN_DATA: pluginData },
    );
    // Pin is silent — no additionalContext required for keyword match alone.
    assert.equal(parsed.continue, true);
    const markerPath = planMarkerPathFor(sessionId);
    assert.ok(fs.existsSync(markerPath), "marker file must exist");
    const meta = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.equal(meta.matched_keyword, "plan");
    assert.match(meta.user_prompt_excerpt, /plan a refactor/);
    assert.match(meta.triggered_at, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    cleanMarker(sessionId);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});

test("UserPromptSubmit does NOT pin plan mode when prompt has no keyword", () => {
  const { home, pluginData } = makeTempHome();
  const sessionId = `plan-test-${process.pid}-2`;
  cleanMarker(sessionId);
  try {
    const { parsed } = runHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "implement bug fix in src/foo.ts",
        session_id: sessionId,
      },
      { HOME: home, CODEX_BRIDGE_PLUGIN_DATA: pluginData },
    );
    assert.equal(parsed.continue, true);
    const markerPath = planMarkerPathFor(sessionId);
    assert.equal(fs.existsSync(markerPath), false, "marker file must not exist");
  } finally {
    cleanMarker(sessionId);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});

test("UserPromptSubmit does NOT trigger on 'plan' substring inside other words", () => {
  const { home, pluginData } = makeTempHome();
  const sessionId = `plan-test-${process.pid}-3`;
  cleanMarker(sessionId);
  try {
    const cases = [
      "explain the architecture",
      "implementation needs review",
      "explanation of caching policy",
    ];
    for (const prompt of cases) {
      cleanMarker(sessionId);
      const { parsed } = runHook(
        {
          hook_event_name: "UserPromptSubmit",
          prompt,
          session_id: sessionId,
        },
        { HOME: home, CODEX_BRIDGE_PLUGIN_DATA: pluginData },
      );
      assert.equal(parsed.continue, true);
      assert.equal(
        fs.existsSync(planMarkerPathFor(sessionId)),
        false,
        `marker file must not exist for prompt: ${prompt}`,
      );
    }
  } finally {
    cleanMarker(sessionId);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});

test("UserPromptSubmit triggers on Turkish plan keywords (planla, planlama)", () => {
  const { home, pluginData } = makeTempHome();
  const sessionId = `plan-test-${process.pid}-4`;
  const cases = [
    { prompt: "planla bir refaktor", keyword: "planla" },
    { prompt: "planlama yap", keyword: "planlama" },
    { prompt: "make a plan for cleanup", keyword: "make a plan" },
    { prompt: "PLAN A REFACTOR", keyword: "plan" }, // case-insensitive
  ];
  try {
    for (const { prompt, keyword } of cases) {
      cleanMarker(sessionId);
      const { parsed } = runHook(
        {
          hook_event_name: "UserPromptSubmit",
          prompt,
          session_id: sessionId,
        },
        { HOME: home, CODEX_BRIDGE_PLUGIN_DATA: pluginData },
      );
      assert.equal(parsed.continue, true);
      const markerPath = planMarkerPathFor(sessionId);
      assert.ok(fs.existsSync(markerPath), `marker missing for prompt: ${prompt}`);
      const meta = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      assert.equal(meta.matched_keyword, keyword, `wrong keyword for: ${prompt}`);
    }
  } finally {
    cleanMarker(sessionId);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});

test("UserPromptSubmit marker path is session-scoped (different sessions don't interfere)", () => {
  const { home, pluginData } = makeTempHome();
  const sessionA = `plan-test-${process.pid}-A`;
  const sessionB = `plan-test-${process.pid}-B`;
  cleanMarker(sessionA);
  cleanMarker(sessionB);
  try {
    runHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "plan a refactor",
        session_id: sessionA,
      },
      { HOME: home, CODEX_BRIDGE_PLUGIN_DATA: pluginData },
    );
    assert.ok(
      fs.existsSync(planMarkerPathFor(sessionA)),
      "session A marker should exist",
    );
    assert.equal(
      fs.existsSync(planMarkerPathFor(sessionB)),
      false,
      "session B marker should not exist",
    );

    runHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "implement bug fix",
        session_id: sessionB,
      },
      { HOME: home, CODEX_BRIDGE_PLUGIN_DATA: pluginData },
    );
    // Session B prompt did not trigger; A's marker is unchanged.
    assert.ok(
      fs.existsSync(planMarkerPathFor(sessionA)),
      "session A marker should still exist after session B prompt",
    );
    assert.equal(
      fs.existsSync(planMarkerPathFor(sessionB)),
      false,
      "session B marker should still not exist",
    );
  } finally {
    cleanMarker(sessionA);
    cleanMarker(sessionB);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});

test("UserPromptSubmit honors CODEX_BRIDGE_HOOK_DISABLE for plan-mode pin", () => {
  const { home, pluginData } = makeTempHome();
  const sessionId = `plan-test-${process.pid}-disabled`;
  cleanMarker(sessionId);
  try {
    for (const disableValue of ["user-prompt-submit", "all"]) {
      cleanMarker(sessionId);
      const { parsed } = runHook(
        {
          hook_event_name: "UserPromptSubmit",
          prompt: "plan a refactor",
          session_id: sessionId,
        },
        {
          HOME: home,
          CODEX_BRIDGE_PLUGIN_DATA: pluginData,
          CODEX_BRIDGE_HOOK_DISABLE: disableValue,
        },
      );
      assert.deepEqual(parsed, { continue: true });
      assert.equal(
        fs.existsSync(planMarkerPathFor(sessionId)),
        false,
        `marker should not exist when disabled=${disableValue}`,
      );
    }
  } finally {
    cleanMarker(sessionId);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});

test("UserPromptSubmit plan-mode pin coexists with rewake/resume blocks", () => {
  const { home, pluginData } = makeTempHome();
  const sessionId = `plan-test-${process.pid}-coexist`;
  cleanMarker(sessionId);
  try {
    // "continue" matches resume-intent AND should NOT match plan keywords.
    // "plan" inside the same prompt should still pin plan mode.
    const { parsed } = runHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "continue: plan the next refactor",
        session_id: sessionId,
      },
      { HOME: home, CODEX_BRIDGE_PLUGIN_DATA: pluginData },
    );
    assert.equal(parsed.continue, true);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(parsed.hookSpecificOutput.additionalContext, /resume-intent detected/);
    // Plan-mode marker should also exist.
    assert.ok(
      fs.existsSync(planMarkerPathFor(sessionId)),
      "plan marker should exist alongside resume-intent block",
    );
  } finally {
    cleanMarker(sessionId);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});

test("UserPromptSubmit falls back to 'default' marker when no session_id present", () => {
  const { home, pluginData } = makeTempHome();
  cleanMarker("default");
  try {
    const { parsed } = runHook(
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "make a plan",
      },
      { HOME: home, CODEX_BRIDGE_PLUGIN_DATA: pluginData },
    );
    assert.equal(parsed.continue, true);
    const markerPath = planMarkerPathFor("default");
    assert.ok(fs.existsSync(markerPath), "default marker file must exist");
    const meta = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.equal(meta.matched_keyword, "make a plan");
  } finally {
    cleanMarker("default");
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(pluginData, { recursive: true, force: true });
  }
});
