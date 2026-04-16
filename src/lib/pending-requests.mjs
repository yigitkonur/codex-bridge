import fs from "node:fs";
import path from "node:path";

const DEFAULT_QUESTION_TIMEOUT_MS = 300_000; // 5 minutes
const POLL_INTERVAL_MS = 500;

/**
 * Disk-persisted pending request store.
 *
 * The worker process (which holds the app-server connection) writes pending
 * requests to disk. The `respond` CLI command (a separate process) writes
 * a response file. The worker polls for response files and sends them on
 * its own connection.
 *
 * File layout in sessionDir:
 *   {threadId}.pending.json   — current pending request (one at a time)
 *   {threadId}.response.json  — response written by `respond` CLI
 */

export function writePendingRequest(sessionDir, threadId, entry) {
  const filePath = path.join(sessionDir, `${threadId}.pending.json`);
  fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));
  return filePath;
}

export function readPendingRequest(sessionDir, threadId) {
  const filePath = path.join(sessionDir, `${threadId}.pending.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function readPendingRequestById(sessionDir, requestId) {
  // Scan all .pending.json files for matching requestId
  try {
    const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".pending.json"));
    for (const file of files) {
      const content = JSON.parse(fs.readFileSync(path.join(sessionDir, file), "utf8"));
      if (content.internalId === requestId) {
        return content;
      }
    }
  } catch {
    // Directory doesn't exist or read error
  }
  return null;
}

export function clearPendingRequest(sessionDir, threadId) {
  const filePath = path.join(sessionDir, `${threadId}.pending.json`);
  try { fs.unlinkSync(filePath); } catch { /* ignore */ }
}

export function writeResponseFile(sessionDir, threadId, payload) {
  const filePath = path.join(sessionDir, `${threadId}.response.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

export function readResponseFile(sessionDir, threadId) {
  const filePath = path.join(sessionDir, `${threadId}.response.json`);
  try {
    const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    fs.unlinkSync(filePath); // consume it
    return content;
  } catch {
    return null;
  }
}

/**
 * Wait for a response file to appear (called by the worker process).
 * Returns the response payload, or null on timeout.
 */
export function waitForResponse(sessionDir, threadId, timeoutMs = DEFAULT_QUESTION_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const response = readResponseFile(sessionDir, threadId);
      if (response) {
        resolve(response);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(null); // timeout
        return;
      }
      setTimeout(check, POLL_INTERVAL_MS);
    };
    check();
  });
}
