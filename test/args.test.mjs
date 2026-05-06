import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../src/lib/args.mjs";

test("inline long value options preserve additional equals signs", () => {
  assert.deepEqual(
    parseArgs(["req-1", "--answer=FOO=bar=baz"], {
      valueOptions: ["answer"]
    }),
    {
      options: { answer: "FOO=bar=baz" },
      positionals: ["req-1"]
    }
  );
});

test("separated long value options are unchanged", () => {
  assert.deepEqual(
    parseArgs(["req-1", "--answer", "FOO=bar=baz", "extra"], {
      valueOptions: ["answer"]
    }),
    {
      options: { answer: "FOO=bar=baz" },
      positionals: ["req-1", "extra"]
    }
  );
});

test("boolean inline values are unchanged", () => {
  assert.deepEqual(
    parseArgs(["--json=false", "--help"], {
      booleanOptions: ["json"]
    }),
    {
      options: { json: false, help: true },
      positionals: []
    }
  );
});

test("no-prefixed long booleans set the positive option false", () => {
  assert.deepEqual(
    parseArgs(["--no-worktree-auto", "--no-json"], {
      booleanOptions: ["worktree-auto", "json"]
    }),
    {
      options: { "worktree-auto": false, json: false },
      positionals: []
    }
  );
});

test("unknown inline long options stay rejected in strict mode", () => {
  assert.throws(
    () => parseArgs(["--answer=FOO=bar=baz"], {}),
    /Unknown flag: --answer/
  );
});
