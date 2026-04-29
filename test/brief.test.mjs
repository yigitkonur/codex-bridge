import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BRIEF_SCHEMA_VERSION,
  VALID_BACKENDS,
  loadBrief,
  renderBriefAsMarkdown,
} from "../src/lib/brief.mjs";
import { ensureJobDir } from "../src/lib/registry.mjs";

function withTempBrief(briefObj, fn) {
  const file = path.join(os.tmpdir(), `brief-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify(briefObj));
  try {
    return fn(file);
  } finally {
    fs.unlinkSync(file);
  }
}

function withTempRegistry(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-registry-"));
  const prev = process.env.CODEX_BRIDGE_REGISTRY;
  process.env.CODEX_BRIDGE_REGISTRY = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) {
      delete process.env.CODEX_BRIDGE_REGISTRY;
    } else {
      process.env.CODEX_BRIDGE_REGISTRY = prev;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const minimal = () => ({
  goal: "Add JWT auth to the Express API",
  worker_assignment: "Implement /auth/login + /auth/refresh in src/auth/",
});

test("loadBrief accepts a minimal valid brief from @path", () => {
  withTempBrief(minimal(), (file) => {
    const r = loadBrief(`@${file}`);
    assert.equal(r.ok, true);
    assert.equal(r.brief.goal, "Add JWT auth to the Express API");
    assert.match(r.briefHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(r.source, file);
  });
});

test("loadBrief accepts inline JSON without @ prefix", () => {
  const r = loadBrief(JSON.stringify(minimal()));
  assert.equal(r.ok, true);
  assert.equal(r.source, "inline");
});

test("loadBrief errors with BRIEF_FILE_NOT_FOUND for missing @path", () => {
  const r = loadBrief("@/nonexistent/path/to/brief.json");
  assert.equal(r.ok, false);
  assert.equal(r.code, "BRIEF_FILE_NOT_FOUND");
});

test("loadBrief errors with BRIEF_INVALID_JSON on malformed JSON", () => {
  const r = loadBrief("{not valid json");
  assert.equal(r.ok, false);
  assert.equal(r.code, "BRIEF_INVALID_JSON");
});

test("loadBrief rejects when goal is missing", () => {
  const r = loadBrief(JSON.stringify({ worker_assignment: "x" }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "BRIEF_SCHEMA_VIOLATION");
  assert.ok(r.details.some((e) => e.includes("goal is required")));
});

test("loadBrief rejects when worker_assignment is missing", () => {
  const r = loadBrief(JSON.stringify({ goal: "x" }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "BRIEF_SCHEMA_VIOLATION");
  assert.ok(r.details.some((e) => e.includes("worker_assignment is required")));
});

test("loadBrief rejects oversize goal", () => {
  const r = loadBrief(
    JSON.stringify({ goal: "x".repeat(2001), worker_assignment: "y" }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, "BRIEF_SCHEMA_VIOLATION");
});

test("loadBrief rejects unknown top-level field", () => {
  const r = loadBrief(
    JSON.stringify({ ...minimal(), surprise: "field" }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.details.some((e) => e.includes("unknown field")));
});

test("loadBrief rejects bad backend_hint", () => {
  const r = loadBrief(
    JSON.stringify({ ...minimal(), backend_hint: "not-real" }),
  );
  assert.equal(r.ok, false);
  // Could be SCHEMA_VIOLATION (enum check) or BACKEND_UNAVAILABLE
  assert.ok(["BRIEF_SCHEMA_VIOLATION", "BRIEF_BACKEND_UNAVAILABLE"].includes(r.code));
});

test("loadBrief accepts backend_hint=codex", () => {
  const r = loadBrief(
    JSON.stringify({ ...minimal(), backend_hint: "codex" }),
  );
  assert.equal(r.ok, true);
});

test("loadBrief rejects iteration_max out of range", () => {
  const r1 = loadBrief(JSON.stringify({ ...minimal(), iteration_max: 0 }));
  assert.equal(r1.ok, false);
  const r2 = loadBrief(JSON.stringify({ ...minimal(), iteration_max: 11 }));
  assert.equal(r2.ok, false);
  const r3 = loadBrief(JSON.stringify({ ...minimal(), iteration_max: 5 }));
  assert.equal(r3.ok, true);
});

test("loadBrief rejects parent_task_id with bad pattern", () => {
  const r = loadBrief(
    JSON.stringify({ ...minimal(), parent_task_id: "not_a_task_id" }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.details.some((e) => e.includes("parent_task_id")));
});

test("loadBrief accepts parent_task_id=task-abc.123", () => {
  withTempRegistry(() => {
    ensureJobDir("task-abc.123");
    const r = loadBrief(
      JSON.stringify({ ...minimal(), parent_task_id: "task-abc.123" }),
    );
    assert.equal(r.ok, true);
  });
});

test("loadBrief rejects missing parent_task_id", () => {
  withTempRegistry(() => {
    const r = loadBrief(
      JSON.stringify({ ...minimal(), parent_task_id: "task-missing" }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.code, "BRIEF_PARENT_NOT_FOUND");
  });
});

test("loadBrief rejects too many specific_concerns", () => {
  const r = loadBrief(
    JSON.stringify({
      ...minimal(),
      specific_concerns: Array(17).fill("x"),
    }),
  );
  assert.equal(r.ok, false);
});

test("loadBrief validates trust_budget_override fields", () => {
  const r = loadBrief(
    JSON.stringify({
      ...minimal(),
      trust_budget_override: { auto_merge_max_diff_lines: -1 },
    }),
  );
  assert.equal(r.ok, false);
  const r2 = loadBrief(
    JSON.stringify({
      ...minimal(),
      trust_budget_override: { auto_merge_max_iterations: 0 },
    }),
  );
  assert.equal(r2.ok, false);
  const r3 = loadBrief(
    JSON.stringify({
      ...minimal(),
      trust_budget_override: { auto_merge_max_file: 1 },
    }),
  );
  assert.equal(r3.ok, false);
  assert.ok(
    r3.details.some((e) => e.includes("unknown trust_budget_override field")),
  );
});

test("loadBrief computes a stable briefHash (SHA-256 of the raw text)", () => {
  const text = JSON.stringify(minimal());
  const r1 = loadBrief(text);
  const r2 = loadBrief(text);
  assert.equal(r1.briefHash, r2.briefHash);
});

test("renderBriefAsMarkdown produces a stable markdown block", () => {
  const md = renderBriefAsMarkdown({
    goal: "Goal text",
    worker_assignment: "Do the thing",
    specific_concerns: ["concern A", "concern B"],
    acceptance_criteria: ["test passes"],
  });
  assert.match(md, /^# Brief/);
  assert.match(md, /## Goal/);
  assert.match(md, /Goal text/);
  assert.match(md, /## Specific concerns\n- concern A\n- concern B/);
  assert.match(md, /## Acceptance criteria\n- \[ \] test passes/);
});

test("VALID_BACKENDS contains codex and pins schema version", () => {
  assert.ok(VALID_BACKENDS.has("codex"));
  assert.equal(BRIEF_SCHEMA_VERSION, "1.0");
});
