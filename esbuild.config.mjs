import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

await build({
  entryPoints: ["src/codex-bridge.mjs"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "skill/scripts/codex-bridge.mjs",
  // No shebang — invoked via `node codex-bridge.mjs`, not as executable
  external: [],
  minify: false,
  sourcemap: false,
  logLevel: "info",
});

// Copy static assets to skill output
const copies = [
  ["src/prompts/adversarial-review.md", "skill/prompts/adversarial-review.md"],
  ["src/schemas/review-output.schema.json", "skill/schemas/review-output.schema.json"],
  ["src/templates/execute-instructions.md", "skill/templates/execute-instructions.md"],
  ["src/templates/plan-enforcement.md", "skill/templates/plan-enforcement.md"],
];

for (const [src, dest] of copies) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

console.log("Build complete. Output: skill/scripts/codex-bridge.mjs");
