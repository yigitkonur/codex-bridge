import assert from "node:assert/strict";
import test from "node:test";

import {
  REVIEW_RESULT_SCHEMA_VERSION,
  mapReviewVerdictToTaskVerdict,
  normalizeAdversarialReviewResult,
  normalizeNativeReviewResult,
  parseNativeReviewText,
  validateReviewFinding,
} from "../src/lib/review-result.mjs";

const NORMALIZED_KEYS = [
  "schema_version",
  "review_kind",
  "verdict",
  "summary",
  "findings",
  "next_steps",
  "target",
  "task_id",
  "reviewed_branch_head_sha",
  "raw_output",
];

test("normalizeNativeReviewResult maps clean native output to normalized review result", () => {
  const result = normalizeNativeReviewResult({
    reviewText: "No issues found. Looks good overall.",
    target: { scope: "working-tree" },
  });

  assert.deepEqual(Object.keys(result), NORMALIZED_KEYS);
  assert.equal(result.schema_version, REVIEW_RESULT_SCHEMA_VERSION);
  assert.equal(result.review_kind, "native");
  assert.equal(result.verdict, "approved");
  assert.equal(result.summary, "No issues found. Looks good overall.");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.next_steps, []);
  assert.deepEqual(result.target, { scope: "working-tree" });
  assert.equal(result.task_id, null);
  assert.equal(result.reviewed_branch_head_sha, null);
  assert.equal(result.raw_output, "No issues found. Looks good overall.");
});

test("parseNativeReviewText treats qualified no-issue phrases as approved", () => {
  for (const reviewText of [
    "No major issues found.",
    "No material findings.",
    "No significant concerns.",
    "No actionable regressions detected.",
    "No blocking problems remain.",
  ]) {
    const parsed = parseNativeReviewText(reviewText);
    assert.equal(parsed.verdict, "approved", reviewText);
    assert.deepEqual(parsed.findings, []);
  }
});

test("parseNativeReviewText preserves actionable native findings for pipeline fixes", () => {
  const parsed = parseNativeReviewText([
    "Review findings:",
    "- [P1] Preserve actionable native review findings \\u2014 src/lib/auto-pipeline.mjs:123-124",
    "  The native review identified a real issue that must be fixed.",
  ].join("\n").replace("\\u2014", "\u2014"));

  assert.equal(parsed.verdict, "must-fix");
  assert.equal(parsed.findings.length, 1);
  assert.deepEqual(parsed.findings[0], {
    severity: "P1",
    title: "Preserve actionable native review findings",
    body: "The native review identified a real issue that must be fixed.",
    file: "src/lib/auto-pipeline.mjs",
    line_start: 123,
    line_end: 124,
    confidence: 1,
    recommendation: "The native review identified a real issue that must be fixed.",
  });
});

test("normalizeAdversarialReviewResult maps valid adversarial JSON to the same top-level keys", () => {
  const nativeResult = normalizeNativeReviewResult("No issues found.");
  const adversarialResult = normalizeAdversarialReviewResult({
    payload: {
      verdict: "needs-attention",
      summary: "Do not ship until the auth regression is fixed.",
      findings: [
        {
          severity: "high",
          title: "Auth regression",
          body: "The new path skips the auth guard.",
          file: "src/auth.mjs",
          line_start: 42,
          line_end: 44,
          confidence: 0.9,
          recommendation: "Call requireAuth before reading tenant data.",
        },
      ],
      next_steps: ["Fix the auth guard.", "Rerun review."],
    },
    target: { scope: "branch", base: "main" },
    task_id: "task-review",
    reviewed_branch_head_sha: "0123456789abcdef0123456789abcdef01234567",
  });

  assert.deepEqual(Object.keys(adversarialResult), Object.keys(nativeResult));
  assert.equal(adversarialResult.review_kind, "adversarial");
  assert.equal(adversarialResult.verdict, "must-fix");
  assert.equal(adversarialResult.task_id, "task-review");
  assert.equal(adversarialResult.reviewed_branch_head_sha, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(adversarialResult.findings[0].severity, "high");
});

test("normalizeAdversarialReviewResult defaults missing task target fields to null", () => {
  const result = normalizeAdversarialReviewResult(JSON.stringify({
    verdict: "approve",
    summary: "No material findings.",
    findings: [],
    next_steps: [],
  }));

  assert.equal(result.verdict, "approved");
  assert.equal(result.target, null);
  assert.equal(result.task_id, null);
  assert.equal(result.reviewed_branch_head_sha, null);
  assert.equal(typeof result.raw_output, "string");
});

test("validateReviewFinding rejects invalid finding shapes with structured TypeError", () => {
  assert.throws(
    () => validateReviewFinding({ severity: "high", title: "Missing file" }),
    (error) => {
      assert.equal(error.name, "TypeError");
      assert.equal(error.code, "INVALID_REVIEW_RESULT");
      assert.equal(error.field, "findings.0.file");
      assert.match(error.message, /file/);
      return true;
    },
  );
});

test("mapReviewVerdictToTaskVerdict maps review verdict spellings to task verdicts", () => {
  assert.equal(mapReviewVerdictToTaskVerdict("approve"), "approved");
  assert.equal(mapReviewVerdictToTaskVerdict({ verdict: "approved" }), "approved");
  assert.equal(mapReviewVerdictToTaskVerdict({ verdict: "needs-attention" }), "needs-attention");
  assert.equal(mapReviewVerdictToTaskVerdict({ verdict: "must-fix" }), "must-fix");
  assert.throws(() => mapReviewVerdictToTaskVerdict({ verdict: "ship-it" }), /unknown review verdict/);
});
