import fs from "node:fs";

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

export function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") return;
  fs.appendFileSync(
    process.env.CLAUDE_ENV_FILE,
    `export ${name}=${shellEscape(value)}\n`,
    "utf8",
  );
}

export function appendEnvVars(vars) {
  for (const [name, value] of Object.entries(vars)) {
    appendEnvVar(name, value);
  }
}
