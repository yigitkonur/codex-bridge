// UUID v1–v8 canonical form: 8-4-4-4-12 hex characters.
// Codex app-server uses UUID v7 for thread ids; we accept any hex UUID
// here because pre-v7 resumable threads (upgrade path) are still valid.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isThreadId(value) {
  return typeof value === "string" && UUID_RE.test(value.trim());
}
