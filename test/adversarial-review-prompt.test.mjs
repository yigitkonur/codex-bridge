// Coverage for {{OPUS_CONCERNS}} — the orchestrator's privileged channel
// added in T26. Keeps four invariants honest:
//   1. The placeholder is reachable by the prompt template.
//   2. The renderer emits a sentinel string when no concerns are provided
//      (so the prompt always says something defensible).
//   3. Brief concerns and --concern flags merge with stable ordering and
//      de-duplication.
//   4. Concern text is sanitized so a malicious string can't smuggle a
//      fake </orchestrator_concerns> wrapper into the prompt.
//
// We test by reading the source file with regex (the standard approach in
// prompts-strict.test.mjs) and by importing parseArgs to verify the
// repeatable-value-options surface.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { parseArgs } from "../src/lib/args.mjs";

const BRIDGE_SRC = fs.readFileSync(
  new URL("../src/codex-bridge.mjs", import.meta.url),
  "utf8",
);
const PROMPT_SRC = fs.readFileSync(
  new URL("../src/prompts/adversarial-review.md", import.meta.url),
  "utf8",
);
const PLUGIN_PROMPT_SRC = fs.readFileSync(
  new URL("../plugin/prompts/adversarial-review.md", import.meta.url),
  "utf8",
);

test("adversarial-review prompt declares OPUS_CONCERNS placeholder (src + plugin copies in sync)", () => {
  assert.match(PROMPT_SRC, /\{\{OPUS_CONCERNS\}\}/);
  assert.match(PROMPT_SRC, /<orchestrator_concerns>/);
  assert.match(PLUGIN_PROMPT_SRC, /\{\{OPUS_CONCERNS\}\}/);
  assert.match(PLUGIN_PROMPT_SRC, /<orchestrator_concerns>/);
  // The two copies must share identical placeholder semantics — esbuild
  // copies src/ → plugin/ at build time, so divergence is a build bug.
  assert.equal(PROMPT_SRC, PLUGIN_PROMPT_SRC);
});

test("buildAdversarialReviewPrompt passes OPUS_CONCERNS at the call site", () => {
  const callBlock =
    BRIDGE_SRC.match(/function buildAdversarialReviewPrompt[\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.ok(callBlock.length > 0);
  assert.match(callBlock, /OPUS_CONCERNS:/);
  assert.match(callBlock, /requiredKeys:[\s\S]*?"OPUS_CONCERNS"/);
});

test("formatOpusConcerns renders bullet list when concerns are provided", () => {
  const block = BRIDGE_SRC.match(/function formatOpusConcerns[\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.ok(block.length > 0);
  // The bullet rendering uses `- ${...}\n` joins — keep that contract.
  assert.match(block, /\.join\("\\n"\)/);
  // sanitizePromptValue must run on each concern so a malicious string
  // cannot inject a fake </orchestrator_concerns> wrapper.
  assert.match(block, /sanitizePromptValue\(c\)/);
});

test("formatOpusConcerns falls back to a sentinel when no concerns are provided", () => {
  const block = BRIDGE_SRC.match(/function formatOpusConcerns[\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.match(block, /No orchestrator-supplied concerns/);
});

test("executeReviewRun merges brief.specific_concerns + --concern flags with order + dedup", () => {
  const block =
    BRIDGE_SRC.match(/const briefConcerns =[\s\S]*?const prompt = buildAdversarialReviewPrompt/)?.[0] ?? "";
  assert.ok(block.length > 0, "expected the merge block in executeReviewRun");
  // Brief items first, then flag items.
  assert.match(block, /\[\.\.\.briefConcerns, \.\.\.flagConcerns\]/);
  // De-dup via a Set of trimmed keys.
  assert.match(block, /new Set\(\)/);
  assert.match(block, /seen\.has\(key\)/);
});

test("validateNativeReviewRequest rejects --brief and --concern (review.md → adversarial-review redirect)", () => {
  const block =
    BRIDGE_SRC.match(/function validateNativeReviewRequest[\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.ok(block.length > 0);
  assert.match(block, /REVIEW_BRIEF_UNSUPPORTED/);
  assert.match(block, /REVIEW_CONCERN_UNSUPPORTED/);
  assert.match(block, /adversarial-review --brief/);
  assert.match(block, /adversarial-review --concern/);
});

test("parseArgs --concern is repeatable and accumulates into an array", () => {
  const { options } = parseArgs(
    [
      "--concern",
      "first",
      "--concern",
      "second",
      "--concern=third",
    ],
    {
      repeatableValueOptions: ["concern"],
    },
  );
  assert.deepEqual(options.concern, ["first", "second", "third"]);
});

test("parseArgs single --concern still produces an array (one-element)", () => {
  const { options } = parseArgs(["--concern", "alone"], {
    repeatableValueOptions: ["concern"],
  });
  assert.deepEqual(options.concern, ["alone"]);
});

test("parseArgs non-repeatable valueOptions still last-write-wins (regression: existing flags)", () => {
  const { options } = parseArgs(["--model", "spark", "--model", "fast"], {
    valueOptions: ["model"],
  });
  assert.equal(options.model, "fast");
});

test("handleReviewCommand declares brief + repeatable concern in its parseCommandInput config", () => {
  const block =
    BRIDGE_SRC.match(/async function handleReviewCommand[\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.ok(block.length > 0);
  assert.match(block, /valueOptions:\s*\[[^\]]*"brief"/);
  assert.match(block, /repeatableValueOptions:\s*\["concern"\]/);
  // The handler must forward brief + opusConcerns into executeReviewRun.
  assert.match(block, /brief,/);
  assert.match(block, /opusConcerns,/);
});
