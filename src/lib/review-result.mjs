export const REVIEW_RESULT_SCHEMA_VERSION = "1.0";

const REVIEW_KINDS = new Set(["native", "adversarial"]);
const NORMALIZED_VERDICTS = new Set(["approved", "needs-attention", "must-fix"]);
const ADVERSARIAL_VERDICTS = new Set(["approve", "approved", "needs-attention", "must-fix"]);
const FINDING_SEVERITIES = new Set(["critical", "high", "medium", "low", "P0", "P1", "P2", "P3", "P4"]);

export function parseNativeReviewText(text) {
  const reviewText = typeof text === "string" ? text : String(text ?? "");
  const findings = parseNativeReviewFindings(reviewText).map((finding, index) =>
    validateReviewFinding(finding, index)
  );
  if (findings.length > 0) {
    return {
      verdict: "must-fix",
      summary: firstMeaningfulLine(reviewText, "Native review reported actionable findings."),
      findings,
      next_steps: ["Fix the reported findings, then rerun review."],
      raw_output: reviewText,
    };
  }

  const lower = reviewText.toLowerCase();
  const reviewTextWithoutNoIssuePhrases = lower
    .replace(/\bno\s+(?:actionable\s+)?(?:issues?|findings?|problems?|concerns?)\b/g, "")
    .replace(/\b(?:issues?|findings?|problems?|concerns?):\s*(?:none|n\/a)\b/g, "");
  const explicitAttention =
    lower.includes("needs-attention") ||
    /\bneeds attention\b/.test(lower) ||
    /\brequires attention\b/.test(lower);
  const hasIssues =
    explicitAttention ||
    /\b(?:findings?|issues?|problems?|concerns?|regressions?)\b/.test(reviewTextWithoutNoIssuePhrases);
  return {
    verdict: hasIssues ? "needs-attention" : "approved",
    summary: firstMeaningfulLine(
      reviewText,
      hasIssues ? "Native review reported attention without structured findings." : "Native review approved the target.",
    ),
    findings: [],
    next_steps: hasIssues ? ["Rerun review or inspect the raw output for unstructured concerns."] : [],
    raw_output: reviewText,
  };
}

export function normalizeNativeReviewResult(input) {
  const source = normalizeInputObject(input, "reviewText");
  const parsed = parseNativeReviewText(source.reviewText);
  return buildReviewResult({
    reviewKind: "native",
    parsed,
    source,
  });
}

export function normalizeAdversarialReviewResult(input) {
  const source = normalizeInputObject(input, "raw_output");
  const data = parseAdversarialPayload(source.payload);
  if (!ADVERSARIAL_VERDICTS.has(data.verdict)) {
    throw reviewResultTypeError(
      `adversarial review verdict must be one of approve | approved | needs-attention | must-fix (got ${JSON.stringify(data.verdict)})`,
      "verdict",
    );
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    throw reviewResultTypeError("adversarial review summary must be a non-empty string", "summary");
  }
  if (!Array.isArray(data.findings)) {
    throw reviewResultTypeError("adversarial review findings must be an array", "findings");
  }
  if (!Array.isArray(data.next_steps)) {
    throw reviewResultTypeError("adversarial review next_steps must be an array", "next_steps");
  }

  const findings = data.findings.map((finding, index) => validateReviewFinding(finding, index));
  const verdict = normalizeVerdict(data.verdict, findings);
  return buildReviewResult({
    reviewKind: "adversarial",
    parsed: {
      verdict,
      summary: data.summary.trim(),
      findings,
      next_steps: data.next_steps
        .filter((step) => typeof step === "string" && step.trim())
        .map((step) => step.trim()),
      raw_output: source.raw_output,
    },
    source,
  });
}

export function mapReviewVerdictToTaskVerdict(reviewResult) {
  const verdict = typeof reviewResult === "string" ? reviewResult : reviewResult?.verdict;
  if (verdict === "approve") return "approved";
  if (NORMALIZED_VERDICTS.has(verdict)) return verdict;
  throw reviewResultTypeError(`unknown review verdict: ${JSON.stringify(verdict)}`, "verdict");
}

export function validateReviewFinding(finding, index = 0) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    throw reviewResultTypeError(`finding[${index}] must be an object`, `findings.${index}`);
  }

  const severity = normalizeRequiredString(finding.severity, `finding[${index}].severity`, `findings.${index}.severity`);
  if (!FINDING_SEVERITIES.has(severity)) {
    throw reviewResultTypeError(
      `finding[${index}].severity must be one of ${Array.from(FINDING_SEVERITIES).join(" | ")} (got ${JSON.stringify(finding.severity)})`,
      `findings.${index}.severity`,
    );
  }
  const title = normalizeRequiredString(finding.title, `finding[${index}].title`, `findings.${index}.title`);
  const file = normalizeRequiredString(finding.file, `finding[${index}].file`, `findings.${index}.file`);
  const lineStart = normalizePositiveInteger(finding.line_start, `finding[${index}].line_start`, `findings.${index}.line_start`);
  const lineEnd = normalizePositiveInteger(
    finding.line_end ?? finding.line_start,
    `finding[${index}].line_end`,
    `findings.${index}.line_end`,
  );
  if (lineEnd < lineStart) {
    throw reviewResultTypeError(
      `finding[${index}].line_end must be greater than or equal to line_start`,
      `findings.${index}.line_end`,
    );
  }

  const recommendation = typeof finding.recommendation === "string" ? finding.recommendation.trim() : "";
  const body = typeof finding.body === "string" && finding.body.trim()
    ? finding.body.trim()
    : recommendation || title;
  const confidence = finding.confidence == null ? 1 : finding.confidence;
  if (typeof confidence !== "number" || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    throw reviewResultTypeError(
      `finding[${index}].confidence must be a number between 0 and 1`,
      `findings.${index}.confidence`,
    );
  }

  return {
    severity,
    title,
    body,
    file,
    line_start: lineStart,
    line_end: lineEnd,
    confidence,
    recommendation,
  };
}

function buildReviewResult({ reviewKind, parsed, source }) {
  if (!REVIEW_KINDS.has(reviewKind)) {
    throw reviewResultTypeError(`review_kind must be native or adversarial (got ${JSON.stringify(reviewKind)})`, "review_kind");
  }
  const verdict = mapReviewVerdictToTaskVerdict(parsed.verdict);
  const result = {
    schema_version: REVIEW_RESULT_SCHEMA_VERSION,
    review_kind: reviewKind,
    verdict,
    summary: typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : `${reviewKind} review completed.`,
    findings: Array.isArray(parsed.findings)
      ? parsed.findings.map((finding, index) => validateReviewFinding(finding, index))
      : [],
    next_steps: Array.isArray(parsed.next_steps)
      ? parsed.next_steps.filter((step) => typeof step === "string" && step.trim()).map((step) => step.trim())
      : [],
    target: source.target ?? null,
    task_id: source.task_id ?? source.taskId ?? null,
    reviewed_branch_head_sha: source.reviewed_branch_head_sha ?? source.reviewedBranchHeadSha ?? null,
    raw_output: parsed.raw_output ?? source.raw_output ?? null,
  };
  if (!NORMALIZED_VERDICTS.has(result.verdict)) {
    throw reviewResultTypeError(`normalized verdict is invalid: ${JSON.stringify(result.verdict)}`, "verdict");
  }
  return result;
}

function normalizeInputObject(input, textField) {
  if (typeof input === "string") {
    return {
      payload: input,
      [textField]: input,
      raw_output: input,
    };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw reviewResultTypeError("review result input must be an object or string", "input");
  }
  const payload = input.parsed ?? input.result ?? input.payload ?? input.review_result ?? input;
  const rawOutput = input.raw_output ?? input.rawOutput ?? input.reviewText ?? input.finalMessage ?? payload;
  return {
    ...input,
    payload,
    reviewText: input.reviewText ?? input.review_text ?? input.raw_output ?? input.rawOutput ?? "",
    raw_output: rawOutput,
  };
}

function parseAdversarialPayload(payload) {
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch (error) {
      throw reviewResultTypeError(`adversarial review output must be valid JSON: ${error.message}`, "raw_output");
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw reviewResultTypeError("adversarial review output must be a JSON object", "raw_output");
  }
  return payload;
}

function normalizeVerdict(verdict, findings) {
  if (verdict === "approve" || verdict === "approved") {
    return findings.length > 0 ? "must-fix" : "approved";
  }
  if (verdict === "must-fix") return "must-fix";
  if (verdict === "needs-attention") {
    return findings.length > 0 ? "must-fix" : "needs-attention";
  }
  throw reviewResultTypeError(`unknown review verdict: ${JSON.stringify(verdict)}`, "verdict");
}

function parseNativeReviewFindings(reviewText) {
  const lines = reviewText.split(/\r?\n/);
  const findings = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const recommendation = current.body
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n");
    findings.push({
      severity: current.severity,
      title: current.title,
      body: recommendation || current.title,
      file: current.file,
      line_start: current.lineStart,
      line_end: current.lineEnd,
      confidence: 1,
      recommendation,
    });
    current = null;
  };

  for (const line of lines) {
    const header = parseNativeFindingHeader(line);
    if (header) {
      flush();
      current = { ...header, body: [] };
      continue;
    }

    if (current && (/^(?:\s{2,}|\t+)\S/.test(line) || line.trim() === "")) {
      current.body.push(line);
    }
  }

  flush();
  return findings;
}

function parseNativeFindingHeader(line) {
  const match = line.match(/^\s*[-*]\s+\[(P\d+)\]\s+(.+?)\s+(?:\u2014|\u2013|--|-)\s+(.+?):(\d+)(?:-(\d+))?\s*$/i);
  if (!match) return null;

  const lineStart = Number.parseInt(match[4], 10);
  if (!Number.isInteger(lineStart) || lineStart < 1) return null;

  const parsedLineEnd = match[5] ? Number.parseInt(match[5], 10) : lineStart;
  const lineEnd = Number.isInteger(parsedLineEnd) && parsedLineEnd >= lineStart
    ? parsedLineEnd
    : lineStart;

  return {
    severity: match[1].toUpperCase(),
    title: match[2].trim(),
    file: match[3].trim(),
    lineStart,
    lineEnd,
  };
}

function normalizeRequiredString(value, messageField, errorField = messageField) {
  if (typeof value !== "string" || !value.trim()) {
    throw reviewResultTypeError(`${messageField} must be a non-empty string`, errorField);
  }
  return value.trim();
}

function normalizePositiveInteger(value, messageField, errorField = messageField) {
  if (!Number.isInteger(value) || value < 1) {
    throw reviewResultTypeError(`${messageField} must be a positive integer`, errorField);
  }
  return value;
}

function firstMeaningfulLine(text, fallback) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? fallback;
}

function reviewResultTypeError(message, field) {
  const error = new TypeError(message);
  error.code = "INVALID_REVIEW_RESULT";
  error.field = field;
  return error;
}
