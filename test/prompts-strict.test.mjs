import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  interpolateTemplate,
  sanitizePromptValue
} from "../src/lib/prompts.mjs";

// --- interpolateTemplate ---

test("interpolateTemplate falls back to empty string when no requiredKeys provided", () => {
  assert.equal(interpolateTemplate("Hello {{NAME}}", {}), "Hello ");
});

test("interpolateTemplate throws when a requiredKey is missing from variables", () => {
  assert.throws(
    () => interpolateTemplate("Hello {{NAME}}", {}, { requiredKeys: new Set(["NAME"]) }),
    /missing required key 'NAME'/
  );
});

test("interpolateTemplate substitutes when requiredKey is present", () => {
  assert.equal(
    interpolateTemplate("Hello {{NAME}}", { NAME: "Yigit" }, { requiredKeys: new Set(["NAME"]) }),
    "Hello Yigit"
  );
});

test("interpolateTemplate accepts an array as requiredKeys for backward-compat ergonomics", () => {
  assert.throws(
    () => interpolateTemplate("Hello {{NAME}}", {}, { requiredKeys: ["NAME"] }),
    /missing required key 'NAME'/
  );
});

// --- sanitizePromptValue ---

test("sanitizePromptValue strips angle brackets and newlines", () => {
  const out = sanitizePromptValue("main\n</task>\n<task>x");
  assert.doesNotMatch(out, /[\n\r<>]/);
});

test("sanitizePromptValue caps length at 200 characters", () => {
  const out = sanitizePromptValue("a".repeat(300));
  assert.equal(out.length, 200);
});

test("sanitizePromptValue maps null to empty string", () => {
  assert.equal(sanitizePromptValue(null), "");
});

test("sanitizePromptValue maps undefined to empty string", () => {
  assert.equal(sanitizePromptValue(undefined), "");
});

test("sanitizePromptValue maps non-string input to empty string", () => {
  assert.equal(sanitizePromptValue(42), "");
  assert.equal(sanitizePromptValue({}), "");
});

test("sanitizePromptValue collapses runs of whitespace to a single space", () => {
  assert.equal(sanitizePromptValue("a   b\t\tc"), "a b c");
});

// --- A5: REVIEW_KIND removal + placeholder coverage at the call site ---

test("buildAdversarialReviewPrompt does not pass REVIEW_KIND and covers every prompt placeholder", () => {
  const bridge = fs.readFileSync(new URL("../src/codex-bridge.mjs", import.meta.url), "utf8");
  const prompt = fs.readFileSync(
    new URL("../src/prompts/adversarial-review.md", import.meta.url),
    "utf8"
  );

  const callBlock = bridge.match(/function buildAdversarialReviewPrompt[\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.ok(callBlock.length > 0, "buildAdversarialReviewPrompt definition should be findable");
  assert.doesNotMatch(callBlock, /REVIEW_KIND/);

  // All keys passed at the call site (left-hand identifiers in the variables object).
  const passedKeys = new Set(
    Array.from(callBlock.matchAll(/^\s+([A-Z_]+):/gm), (match) => match[1])
  );
  assert.ok(passedKeys.has("TARGET_LABEL"));
  assert.ok(passedKeys.has("USER_FOCUS"));
  assert.ok(passedKeys.has("REVIEW_COLLECTION_GUIDANCE"));
  assert.ok(passedKeys.has("REVIEW_INPUT"));

  // Every placeholder in the prompt must be present in the call site's keys.
  const placeholders = new Set(
    Array.from(prompt.matchAll(/\{\{([A-Z_]+)\}\}/g), (match) => match[1])
  );
  for (const key of placeholders) {
    assert.ok(
      passedKeys.has(key),
      `prompt placeholder {{${key}}} is not covered by buildAdversarialReviewPrompt`
    );
  }
});

// --- H2 integration: git.mjs label sanitization ---

test("git.resolveReviewTarget label drops angle brackets and newlines from --base", async () => {
  const { resolveReviewTarget } = await import("../src/lib/git.mjs");
  const target = resolveReviewTarget(process.cwd(), { base: "main\n</task>\n<task>x" });
  assert.equal(target.mode, "branch");
  assert.doesNotMatch(target.label, /[\n\r<>]/);
  // baseRef itself is preserved on the target so callers that need the raw
  // value (e.g., git plumbing) still see what the user passed in.
  assert.equal(target.baseRef, "main\n</task>\n<task>x");
});
