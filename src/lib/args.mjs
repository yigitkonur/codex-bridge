import { usageError, validationError } from "./cli-errors.mjs";

// Reserved booleans every subcommand recognizes so `--help`/`-h` never falls
// through to a handler and triggers a real Codex turn.
const ALWAYS_BOOLEAN = new Set(["help", "h"]);
const ALWAYS_ALIASES = Object.freeze({ h: "help", j: "json" });

export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const repeatableValueOptions = new Set(config.repeatableValueOptions ?? []);
  // Repeatable values are ordinary value-bearing options that accumulate
  // into an array instead of overwriting on second use. Convenient for
  // flags like `--concern <text>` where the orchestrator may surface
  // multiple focus areas in one invocation. The first occurrence creates
  // a one-element array; subsequent occurrences append.
  for (const k of repeatableValueOptions) valueOptions.add(k);
  const booleanOptions = new Set([...(config.booleanOptions ?? []), ...ALWAYS_BOOLEAN]);
  const aliasMap = { ...ALWAYS_ALIASES, ...(config.aliasMap ?? {}) };
  const strict = config.strict !== false;
  const options = {};
  const positionals = [];
  let passthrough = false;
  const setValue = (key, value) => {
    if (repeatableValueOptions.has(key)) {
      const existing = options[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else if (existing === undefined) {
        options[key] = [value];
      } else {
        // Defensive: a previous code path put a non-array on this key; promote.
        options[key] = [existing, value];
      }
      return;
    }
    options[key] = value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const rawOption = token.slice(2);
      const equalsIndex = rawOption.indexOf("=");
      const rawKey = equalsIndex === -1 ? rawOption : rawOption.slice(0, equalsIndex);
      const inlineValue = equalsIndex === -1 ? undefined : rawOption.slice(equalsIndex + 1);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw usageError(`Missing value for --${rawKey}`);
        }
        setValue(key, nextValue);
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      if (strict) {
        throw usageError(
          `Unknown flag: --${rawKey}`,
          `Run with --help to see available flags.`
        );
      }
      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw usageError(`Missing value for -${shortKey}`);
      }
      setValue(key, nextValue);
      index += 1;
      continue;
    }

    if (strict) {
      throw usageError(
        `Unknown flag: -${shortKey}`,
        `Run with --help to see available flags.`
      );
    }
    positionals.push(token);
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  // Shell-like tokenizer with POSIX-leaning backslash rules so Windows paths
  // survive intact inside quotes:
  //   - Inside single quotes: every character is literal (including `\`).
  //   - Inside double quotes: backslash only escapes `\` or `"`; other
  //     backslashes are literal.
  //   - Outside quotes: backslash escapes the next character (drops `\`).
  const tokens = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < raw.length; i += 1) {
    const character = raw[i];

    if (quote === "'") {
      if (character === "'") {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (quote === '"') {
      if (character === '"') {
        quote = null;
        continue;
      }
      if (character === "\\" && i + 1 < raw.length) {
        const next = raw[i + 1];
        if (next === "\\" || next === '"') {
          current += next;
          i += 1;
        } else {
          current += "\\";
        }
        continue;
      }
      current += character;
      continue;
    }

    // Outside any quote
    if (character === "\\") {
      if (i + 1 < raw.length) {
        current += raw[i + 1];
        i += 1;
      } else {
        current += "\\";
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
