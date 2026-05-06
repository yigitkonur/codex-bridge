import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const directiveHeading = "Halt on missing input";

test("developer instruction templates include missing input halt directive", () => {
  for (const templatePath of [
    "../src/templates/execute-instructions.md",
    "../src/templates/plan-enforcement.md",
  ]) {
    const template = fs.readFileSync(new URL(templatePath, import.meta.url), "utf8");
    assert.match(template, new RegExp(`## ${directiveHeading}`), `${templatePath} is missing directive heading`);
  }
});
