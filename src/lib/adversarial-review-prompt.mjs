import { loadPromptTemplate, interpolateTemplate, sanitizePromptValue } from "./prompts.mjs";

// {{OPUS_CONCERNS}} carries orchestrator-supplied focus labels into the
// adversarial review. The labels may include user-controlled text, so render
// each value as quoted data and let the prompt define how to use it.
export const OPUS_CONCERN_MAX_LEN = 1000;

export function formatOpusConcerns(concerns) {
  const list = Array.isArray(concerns)
    ? concerns
        .map((c) =>
          typeof c === "string"
            ? sanitizePromptValue(c.trim(), { maxLength: OPUS_CONCERN_MAX_LEN }).trim()
            : "",
        )
        .filter((c) => c.length > 0)
    : [];
  if (list.length === 0) {
    return "(No orchestrator-supplied concerns. Run the review with --brief @<path>.json or --concern \"...\" to surface focus areas.)";
  }
  return list
    .map((c) => `- concern_data: ${JSON.stringify(c)}`)
    .join("\n");
}

export function buildAdversarialReviewPrompt(rootDir, context, focusText, opusConcerns = []) {
  const template = loadPromptTemplate(rootDir, "adversarial-review");
  return interpolateTemplate(
    template,
    {
      TARGET_LABEL: sanitizePromptValue(context.target.label),
      USER_FOCUS: sanitizePromptValue(focusText) || "No extra focus provided.",
      REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
      OPUS_CONCERNS: formatOpusConcerns(opusConcerns),
      REVIEW_INPUT: context.content
    },
    {
      requiredKeys: new Set([
        "TARGET_LABEL",
        "USER_FOCUS",
        "REVIEW_COLLECTION_GUIDANCE",
        "OPUS_CONCERNS",
        "REVIEW_INPUT"
      ])
    }
  );
}
