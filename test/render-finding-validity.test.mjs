import assert from "node:assert/strict";
import test from "node:test";

import { renderReviewResult, validateReviewResultShape } from "../src/lib/render.mjs";

function buildValidFinding(overrides = {}) {
  return {
    severity: "high",
    title: "Possible null deref",
    body: "Pointer is read before guard.",
    file: "src/foo.mjs",
    line_start: 10,
    line_end: 20,
    confidence: 0.85,
    recommendation: "Add an explicit guard.",
    ...overrides
  };
}

function buildResult(findings) {
  return {
    verdict: "needs-attention",
    summary: "One finding identified.",
    findings,
    next_steps: ["Review the guard order."]
  };
}

test("validateReviewResultShape accepts a finding with confidence and renderer surfaces conf= label", () => {
  const data = buildResult([buildValidFinding()]);

  assert.equal(validateReviewResultShape(data), null);

  const rendered = renderReviewResult(
    {
      parsed: data,
      rawOutput: JSON.stringify(data),
      parseError: null,
      reasoningSummary: []
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "feature/x",
      reasoningSummary: []
    }
  );

  assert.match(rendered, /conf=0\.85/);
  assert.match(rendered, /\[high · conf=0\.85\]/);
});

test("validateReviewResultShape flags a finding missing confidence", () => {
  const finding = buildValidFinding();
  delete finding.confidence;
  const data = buildResult([finding]);

  const error = validateReviewResultShape(data);

  assert.notEqual(error, null);
  assert.equal(typeof error, "string");
  assert.match(error, /finding\[0\]/);
  assert.match(error, /confidence/);
});

test("validateReviewResultShape rejects a finding with confidence out of [0,1] range", () => {
  const data = buildResult([buildValidFinding({ confidence: 1.5 })]);

  const error = validateReviewResultShape(data);

  assert.notEqual(error, null);
  assert.equal(typeof error, "string");
  assert.match(error, /finding\[0\]/);
  assert.match(error, /confidence/);
});
