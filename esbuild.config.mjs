import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

// Bundle both entry points. The broker is spawned separately by
// `broker-lifecycle.mjs` via `new URL("../app-server-broker.mjs", import.meta.url)`,
// so after bundling it must live adjacent to the main CLI at the same relative
// depth (`skill/scripts/` contains both → `../` resolves to `skill/`).
// Instead we emit the broker to `skill/app-server-broker.mjs`.
await build({
  entryPoints: ["src/codex-bridge.mjs"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "skill/scripts/codex-bridge.mjs",
  external: [],
  minify: false,
  sourcemap: false,
  logLevel: "info",
});

await build({
  entryPoints: ["src/adapters/codex/broker.mjs"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "skill/app-server-broker.mjs",
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
