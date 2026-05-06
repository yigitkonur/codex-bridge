#!/usr/bin/env node
import { uninstallSandboxEnforcement } from "../src/lib/sandbox-enforcement.mjs";

const result = uninstallSandboxEnforcement();
process.stdout.write(
  `Removed ${result.removed} Codex Bridge sandbox enforcement rule${result.removed === 1 ? "" : "s"} from ${result.status.settingsPath}.\n`,
);
