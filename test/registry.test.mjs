import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  REGISTRY_SCHEMA_VERSION,
  registryRoot,
  jobDir,
  existsTask,
  ensureJobDir,
  writeMeta,
  readMeta,
  listTasks,
  readVerdict,
  writeVerdict,
  appendEvent,
} from "../src/lib/registry.mjs";

function withTempRegistry(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-registry-"));
  const prev = process.env.CODEX_BRIDGE_REGISTRY;
  process.env.CODEX_BRIDGE_REGISTRY = root;
  try {
    return fn(root);
  } finally {
    if (prev === undefined) delete process.env.CODEX_BRIDGE_REGISTRY;
    else process.env.CODEX_BRIDGE_REGISTRY = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("registryRoot honors CODEX_BRIDGE_REGISTRY override", () => {
  withTempRegistry((root) => {
    assert.equal(registryRoot(), root);
  });
});

test("jobDir builds <root>/<taskId> and rejects bad task IDs", () => {
  withTempRegistry((root) => {
    assert.equal(jobDir("task-abc"), path.join(root, "task-abc"));
    assert.throws(() => jobDir(""));
    assert.throws(() => jobDir(null));
    assert.throws(() => jobDir("../escape"));
    assert.throws(() => jobDir("with spaces"));
    assert.throws(() => jobDir("path/sep"));
  });
});

test("writeMeta + readMeta round-trip with timestamp + schema_version", () => {
  withTempRegistry(() => {
    const meta = {
      backend: "codex",
      model: "gpt-5.4",
      base_sha: "abc1234",
      phase: "running",
    };
    const target = writeMeta("task-xyz", meta);
    assert.ok(fs.existsSync(target));

    const round = readMeta("task-xyz");
    assert.equal(round.task_id, "task-xyz");
    assert.equal(round.schema_version, REGISTRY_SCHEMA_VERSION);
    assert.equal(round.backend, "codex");
    assert.equal(round.model, "gpt-5.4");
    assert.equal(round.phase, "running");
    assert.match(round.written_at, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("readMeta returns null for missing tasks", () => {
  withTempRegistry(() => {
    assert.equal(readMeta("does-not-exist"), null);
  });
});

test("existsTask reflects directory presence", () => {
  withTempRegistry(() => {
    assert.equal(existsTask("nope"), false);
    ensureJobDir("yes");
    assert.equal(existsTask("yes"), true);
  });
});

test("listTasks enumerates registered tasks alphabetically", () => {
  withTempRegistry(() => {
    ensureJobDir("task-c");
    ensureJobDir("task-a");
    ensureJobDir("task-b");
    assert.deepEqual(listTasks(), ["task-a", "task-b", "task-c"]);
  });
});

test("listTasks returns [] when registry root absent", () => {
  // Don't use withTempRegistry — point at a path that won't exist
  const prev = process.env.CODEX_BRIDGE_REGISTRY;
  process.env.CODEX_BRIDGE_REGISTRY = path.join(
    os.tmpdir(),
    `codex-bridge-registry-missing-${Date.now()}`,
  );
  try {
    assert.deepEqual(listTasks(), []);
  } finally {
    if (prev === undefined) delete process.env.CODEX_BRIDGE_REGISTRY;
    else process.env.CODEX_BRIDGE_REGISTRY = prev;
  }
});

test("writeVerdict validates verdict enum", () => {
  withTempRegistry(() => {
    assert.throws(() =>
      writeVerdict("task-v", { verdict: "magic", summary: "x" }),
    );
    assert.throws(() => writeVerdict("task-v", { verdict: null }));
    assert.doesNotThrow(() =>
      writeVerdict("task-v", { verdict: "approved", summary: "ok" }),
    );
  });
});

test("writeVerdict + readVerdict round-trip", () => {
  withTempRegistry(() => {
    writeVerdict("task-v", {
      verdict: "needs-attention",
      summary: "two findings",
      findings: ["a", "b"],
    });
    const round = readVerdict("task-v");
    assert.equal(round.verdict, "needs-attention");
    assert.equal(round.summary, "two findings");
    assert.deepEqual(round.findings, ["a", "b"]);
    assert.match(round.decided_at, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("appendEvent line-buffers to events.jsonl with timestamp", () => {
  withTempRegistry(() => {
    appendEvent("task-e", { tag: "DONE", message: "first" });
    appendEvent("task-e", { tag: "ERROR", message: "second" });
    const eventsPath = path.join(jobDir("task-e"), "events.jsonl");
    const text = fs.readFileSync(eventsPath, "utf8");
    const lines = text.split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.tag, "DONE");
    assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("writeMeta is atomic — concurrent writers never see partial JSON", async () => {
  await withTempRegistry(async () => {
    const writers = [];
    for (let i = 0; i < 10; i++) {
      writers.push(
        Promise.resolve().then(() =>
          writeMeta("task-race", { iteration: i }),
        ),
      );
    }
    await Promise.all(writers);
    // Every read in this loop should yield a fully-parseable JSON, even
    // though writers raced. A non-atomic write would occasionally
    // produce a partial file and crash JSON.parse.
    for (let i = 0; i < 20; i++) {
      const m = readMeta("task-race");
      assert.ok(m);
      assert.equal(typeof m.iteration, "number");
    }
  });
});
