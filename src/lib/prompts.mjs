import fs from "node:fs";
import path from "node:path";

export function loadPromptTemplate(rootDir, name) {
  const promptPath = path.join(rootDir, "prompts", `${name}.md`);
  return fs.readFileSync(promptPath, "utf8");
}

export function interpolateTemplate(template, variables, options = {}) {
  const requiredKeys = options?.requiredKeys ?? null;
  if (requiredKeys) {
    const iterable = requiredKeys instanceof Set ? requiredKeys : new Set(requiredKeys);
    for (const key of iterable) {
      if (!Object.prototype.hasOwnProperty.call(variables, key)) {
        throw new Error(`interpolateTemplate: missing required key '${key}'`);
      }
    }
  }
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : "";
  });
}

const PROMPT_VALUE_MAX_LEN = 200;

export function sanitizePromptValue(value, options = {}) {
  if (typeof value !== "string") {
    return "";
  }
  const requestedMaxLength = options?.maxLength;
  const maxLength =
    Number.isInteger(requestedMaxLength) && requestedMaxLength >= 0
      ? requestedMaxLength
      : PROMPT_VALUE_MAX_LEN;
  const stripped = value.replace(/[\n\r<>]/g, " ");
  const collapsed = stripped.replace(/\s+/g, " ");
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return collapsed.slice(0, maxLength);
}
