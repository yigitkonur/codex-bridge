import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  REGISTRY_SCHEMA_VERSION,
  RegistryReadError,
  registryRoot,
  jobDir,
  existsTask,
  ensureJobDir,
  writeMeta,
  readMeta,
  listTasks,
  readReview,
  readVerdict,
  writeReview,
  writeVerdict,
  appendEvent,
} from "../src/lib/registry.mjs";

function withTempRegistry(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-registry-"));
  const prev = process.env.CODEX_BRIDGE_REGISTRY;
  process.env.CODEX_BRIDGE_REGISTRY = root;
  const cleanup = () => {
    if (prev === undefined) delete process.env.CODEX_BRIDGE_REGISTRY;
    else process.env.CODEX_BRIDGE_REGISTRY = prev;
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    const result = fn(root);
    if (result && typeof result.then === "function") {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
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
    assert.throws(() => jobDir("."));
    assert.throws(() => jobDir(".."));
  });
});

test("writeMeta + readMeta round-trip with timestamp + schema_version", () => {
  withTempRegistry(() => {
    const meta = {
      backend: "codex",
      model: "gpt-5.4",
      base_sha: "abc1234",
      phase: "running",
      schema_version: "bad",
      task_id: "spoofed-task",
      written_at: "1999-01-01T00:00:00.000Z",
    };
    const target = writeMeta("task-xyz", meta);
    assert.ok(fs.existsSync(target));

    const round = readMeta("task-xyz");
    assert.equal(round.task_id, "task-xyz");
    assert.equal(round.schema_version, REGISTRY_SCHEMA_VERSION);
    assert.notEqual(round.written_at, "1999-01-01T00:00:00.000Z");
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

test("readMeta, readReview, and readVerdict throw on corrupt JSON", () => {
  withTempRegistry(() => {
    const dir = ensureJobDir("task-corrupt");
    const metaPath = path.join(dir, "meta.json");
    const reviewPath = path.join(dir, "review.json");
    const verdictPath = path.join(dir, "verdict.json");
    fs.writeFileSync(metaPath, "{ nope\n", "utf8");
    fs.writeFileSync(reviewPath, "{ nope\n", "utf8");
    fs.writeFileSync(verdictPath, "{ nope\n", "utf8");

    assert.throws(() => readMeta("task-corrupt"), (error) => {
      assert.ok(error instanceof RegistryReadError);
      assert.equal(error.code, "REGISTRY_READ_FAILED");
      assert.equal(error.filePath, metaPath);
      // The original SyntaxError must be preserved on .cause so
      // operators can see the underlying parser message in logs.
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    });

    assert.throws(() => readReview("task-corrupt"), (error) => {
      assert.ok(error instanceof RegistryReadError);
      assert.equal(error.code, "REGISTRY_READ_FAILED");
      assert.equal(error.filePath, reviewPath);
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    });

    assert.throws(() => readVerdict("task-corrupt"), (error) => {
      assert.ok(error instanceof RegistryReadError);
      assert.equal(error.code, "REGISTRY_READ_FAILED");
      assert.equal(error.filePath, verdictPath);
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    });
  });
});

test("readReview returns null when no review exists", () => {
  withTempRegistry(() => {
    assert.equal(readReview("task-no-review"), null);
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

test("listTasks filters non-conforming directory names", () => {
  // Defends the contract that every name in listTasks() is callable
  // through readMeta/readVerdict without TypeError. A stray directory
  // (manual mkdir, partial migration, abandoned tmp artifact) must not
  // poison the listing.
  withTempRegistry((root) => {
    ensureJobDir("task-good");
    fs.mkdirSync(path.join(root, "with space"));
    fs.mkdirSync(path.join(root, "has@symbol"));
    fs.writeFileSync(path.join(root, "loose-file"), "");
    assert.deepEqual(listTasks(), ["task-good"]);
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
      schema_version: "bad",
      task_id: "spoofed-task",
      decided_at: "1999-01-01T00:00:00.000Z",
    });
    const round = readVerdict("task-v");
    assert.equal(round.verdict, "needs-attention");
    assert.equal(round.task_id, "task-v");
    assert.equal(round.schema_version, REGISTRY_SCHEMA_VERSION);
    assert.notEqual(round.decided_at, "1999-01-01T00:00:00.000Z");
    assert.equal(round.summary, "two findings");
    assert.deepEqual(round.findings, ["a", "b"]);
    assert.match(round.decided_at, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("writeReview + readReview round-trip with registry-controlled fields", () => {
  withTempRegistry(() => {
    writeReview("task-r", {
      schema_version: "bad",
      task_id: "spoofed-task",
      ts: "1999-01-01T00:00:00.000Z",
      review_kind: "native",
      verdict: "approved",
      summary: "clean",
      findings: [],
      next_steps: [],
      target: { mode: "branch", baseRef: "main" },
      reviewed_branch_head_sha: "0123456789abcdef0123456789abcdef01234567",
      raw_output: "No issues found.",
    });
    const round = readReview("task-r");
    assert.equal(round.task_id, "task-r");
    assert.equal(round.schema_version, REGISTRY_SCHEMA_VERSION);
    assert.notEqual(round.ts, "1999-01-01T00:00:00.000Z");
    assert.equal(round.review_kind, "native");
    assert.equal(round.verdict, "approved");
    assert.equal(round.summary, "clean");
    assert.deepEqual(round.target, { mode: "branch", baseRef: "main" });
    assert.equal(round.reviewed_branch_head_sha, "0123456789abcdef0123456789abcdef01234567");
    assert.match(round.ts, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("appendEvent line-buffers to events.jsonl with timestamp", () => {
  withTempRegistry(() => {
    appendEvent("task-e", { tag: "DONE", message: "first" });
    appendEvent("task-e", { tag: "ERROR", message: "second" });
    // Caller-supplied `ts` must NOT override the registry's append-time
    // stamp — otherwise a misbehaving emitter could backdate forensics.
    const spoof = "1999-01-01T00:00:00.000Z";
    appendEvent("task-e", { tag: "SPOOF", ts: spoof });
    const eventsPath = path.join(jobDir("task-e"), "events.jsonl");
    const text = fs.readFileSync(eventsPath, "utf8");
    const lines = text.split("\n").filter(Boolean);
    assert.equal(lines.length, 3);
    const first = JSON.parse(lines[0]);
    assert.equal(first.tag, "DONE");
    assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T/);
    const third = JSON.parse(lines[2]);
    assert.equal(third.tag, "SPOOF");
    assert.notEqual(third.ts, spoof);
    assert.match(third.ts, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("writeMeta is atomic — concurrent writers never see partial JSON", async () => {
  await withTempRegistry(async (root) => {
    const writers = [];
    for (let i = 0; i < 10; i++) {
      writers.push(
        Promise.resolve().then(() => {
          const target = writeMeta("task-race", { iteration: i });
          const relative = path.relative(root, target);
          assert.ok(
            relative && !relative.startsWith("..") && !path.isAbsolute(relative),
          );
        }),
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
