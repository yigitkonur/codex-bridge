import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const bridge = fs.readFileSync(new URL("../src/codex-bridge.mjs", import.meta.url), "utf8");
const broker = fs.readFileSync(new URL("../src/adapters/codex/broker.mjs", import.meta.url), "utf8");
const autoPipeline = fs.readFileSync(new URL("../src/adapters/codex/pipeline.mjs", import.meta.url), "utf8");
const adapterTypes = fs.readFileSync(new URL("../src/adapters/index.d.ts", import.meta.url), "utf8");
const adapterEventVocabulary = fs.readFileSync(
  new URL("../src/adapters/_interface/EVENT_VOCABULARY.md", import.meta.url),
  "utf8"
);

test("broker forwards server requests and tracks downstream responses", () => {
  assert.match(broker, /setServerRequestHandler\(routeServerRequest\)/);
  assert.match(broker, /pendingServerRequests/);
  assert.match(broker, /resolveServerRequest/);
  assert.match(broker, /rejectServerRequest/);
});

test("broker handles upstream app-server exit", () => {
  assert.match(broker, /appClient\.on\?\.\("exit", handleUpstreamExit\)/);
  assert.match(broker, /clearAllOwnership\(\)/);
  assert.match(broker, /closeDownstreamSockets\(error\)/);
});

test("broker clears resolved server requests and preserves orphaned upstream ownership", () => {
  assert.match(broker, /message\.method === "serverRequest\/resolved"/);
  assert.match(broker, /pendingServerRequests\.delete\(key\)/);
  assert.match(broker, /cleanupDisconnectedSocket\(socket, activeRequestSocket, streamTracker, pendingServerRequests\)/);
  assert.match(broker, /A downstream socket closing is not upstream settlement/);
  assert.match(broker, /activeRequestToken/);
});

test("wait terminal matching is anchored to event headers", () => {
  assert.match(bridge, /const TERMINAL = \/\^\\\[\(DONE\|ERROR\|INCOMPLETE\)\\\]\//);
  assert.match(bridge, /case "\$line" in "\[DONE\]"\*\|"\[ERROR\]"\*\|"\[INCOMPLETE\]"\*/);
  assert.doesNotMatch(bridge, /\*"\[DONE\]"\*\|\*"\[ERROR\]"\*\|\*"\[INCOMPLETE\]"\*/);
});

test("task retry binds same-thread retry to the failed thread id", () => {
  assert.doesNotMatch(bridge, /const retryResult = await executeTaskRun\(bridgeRequest\);/);
  assert.match(bridge, /resumeThreadId: result\.threadId/);
});

test("resume task chooses default continue prompt before prompt decorators", () => {
  const task = bridge.match(/async function runBridgeTask[\s\S]*?const activeMode = isPlanMode \? "plan" : "default";/)?.[0] ?? "";
  const defaultPromptIndex = task.indexOf("const taskPrompt = request.resumeLast && !String(request.prompt ?? \"\").trim()");
  const footerIndex = task.indexOf("const promptWithFooter = config.prompt_footer");
  assert.notEqual(defaultPromptIndex, -1);
  assert.notEqual(footerIndex, -1);
  assert.ok(defaultPromptIndex < footerIndex);
  assert.match(task, /\? DEFAULT_CONTINUE_PROMPT\s+: \(request\.prompt \?\? ""\);/);
  assert.match(task, /\$\{metaSkillsPrefix\}\$\{taskPrompt\}\\n\\n\$\{config\.prompt_footer\}/);
  assert.match(task, /\$\{metaSkillsPrefix\}\$\{taskPrompt\}/);
  assert.doesNotMatch(task, /\$\{metaSkillsPrefix\}\$\{request\.prompt\}/);
});

test("respond and summary resolve cwd before loading config", () => {
  const respond = bridge.match(/async function handleRespond[\s\S]*?async function handleSummary/)?.[0] ?? "";
  const summary = bridge.match(/async function handleSummary[\s\S]*?async function main/)?.[0] ?? "";
  assert.match(respond, /const cwd = resolveCommandCwd\(options\);/);
  assert.match(summary, /const cwd = resolveCommandCwd\(options\);/);
});

test("send emits plan event instead of terminal done for plan results", () => {
  const send = bridge.match(/async function handleSend[\s\S]*?async function handleSteer/)?.[0] ?? "";
  assert.match(send, /if \(result\.planDetected && result\.planText\)/);
  assert.ok(send.indexOf("formatPlanEvent") < send.indexOf("formatDoneEvent"));
});

test("task plan-pending path marks terminal emission before returning", () => {
  const task = bridge.match(/async function runBridgeTask[\s\S]*?function extractPlanSteps/)?.[0] ?? "";
  const planBranch = task.match(
    /if \(result\.planDetected && result\.planText\) \{[\s\S]*?return \{ \.\.\.result, session, planPath \};/
  )?.[0] ?? "";
  assert.match(planBranch, /formatPlanEvent/);
  assert.match(planBranch, /markTerminalEmitted\(\);/);
  assert.ok(planBranch.indexOf("formatPlanEvent") < planBranch.indexOf("markTerminalEmitted();"));
  assert.ok(planBranch.indexOf("markTerminalEmitted();") < planBranch.indexOf("return { ...result, session, planPath };"));
});

test("sandbox workspace-dirty returns before terminal error emission", () => {
  const task = bridge.match(/async function runBridgeTask[\s\S]*?function extractPlanSteps/)?.[0] ?? "";
  const errorStart = task.indexOf("if (result.exitStatus !== 0 && result.error) {");
  const planStart = task.indexOf("// If plan was detected");
  assert.notEqual(errorStart, -1);
  assert.notEqual(planStart, -1);

  const errorBranch = task.slice(errorStart, planStart);
  const workspaceBranch = errorBranch.match(
    /if \(codexErrorInfo\?\.code === "SandboxError" && touchedFiles\.length > 0\) \{[\s\S]*?return \{ \.\.\.result, session, exitStatus: 0, error: null \};\n\s+\}/
  )?.[0] ?? "";
  assert.match(workspaceBranch, /setPhase\("workspace-dirty"/);
  assert.match(workspaceBranch, /touchedFiles/);
  assert.match(workspaceBranch, /markTerminalEmitted\(\);/);
  assert.doesNotMatch(workspaceBranch, /formatErrorEvent|logNdjson\(session, "ERROR"/);

  const workspaceIndex = errorBranch.indexOf('setPhase("workspace-dirty"');
  const formatErrorIndex = errorBranch.indexOf("formatErrorEvent(session");
  const logErrorIndex = errorBranch.indexOf('logNdjson(session, "ERROR"');
  const terminalErrorMarkIndex = errorBranch.indexOf("markTerminalEmitted();", logErrorIndex);
  assert.notEqual(workspaceIndex, -1);
  assert.notEqual(formatErrorIndex, -1);
  assert.notEqual(logErrorIndex, -1);
  assert.notEqual(terminalErrorMarkIndex, -1);
  assert.ok(workspaceIndex < formatErrorIndex);
  assert.ok(workspaceIndex < logErrorIndex);
  assert.ok(workspaceIndex < terminalErrorMarkIndex);
});

test("tracked failed task results persist handoff error envelope", () => {
  assert.match(bridge, /buildErrorEnvelope\(classifyError\(errLike\), \{ command, partial, handoff \}\)/);
  assert.match(bridge, /payload:\s*\{\s*\.\.\.payload,\s*error\s*\}/);

  const foreground = bridge.match(/async function runForegroundCommand[\s\S]*?function spawnDetachedTaskWorker/)?.[0] ?? "";
  assert.match(
    foreground,
    /async \(\) => persistFailureErrorInPayload\(await runner\(progress\), command\)/
  );

  const worker = bridge.match(/async function handleTaskWorker[\s\S]*?async function handleStatus/)?.[0] ?? "";
  assert.match(
    worker,
    /persistFailureErrorInPayload\(\s*await runBridgeTask\(\{[\s\S]*?onProgress: progress[\s\S]*?\}\),\s*"task"\s*\)/
  );
});

test("background task enqueue persists queued record before spawning worker", () => {
  const enqueue = bridge.match(/function enqueueBackgroundTask[\s\S]*?async function handleReviewCommand/)?.[0] ?? "";
  const writeQueued = enqueue.indexOf("writeJobFile(job.workspaceRoot, job.id, queuedRecord);");
  const upsertQueued = enqueue.indexOf("upsertJob(job.workspaceRoot, queuedRecord);");
  const spawnWorker = enqueue.indexOf("spawnDetachedTaskWorker(cwd, job.id, logFile);");
  assert.notEqual(writeQueued, -1);
  assert.notEqual(upsertQueued, -1);
  assert.notEqual(spawnWorker, -1);
  assert.ok(writeQueued < spawnWorker);
  assert.ok(upsertQueued < spawnWorker);
  assert.match(enqueue, /pid: null,\n\s+logFile,\n\s+request/);
  assert.match(enqueue, /const existingRecord = readStoredJob\(job\.workspaceRoot, job\.id\) \?\? queuedRecord;/);
  assert.match(enqueue, /if \(existingRecord\.status === "queued"\) \{/);
  assert.match(enqueue, /pid: spawnedPid/);
  assert.match(enqueue, /monitor: buildMonitorHint\(\{ eventsPath: null, jobId: job\.id, threadId: null, cwd \}\)/);
});

test("review sessions emit terminal events", () => {
  const review = bridge.match(/async function executeReviewRun[\s\S]*?async function executeTaskRun/)?.[0] ?? "";
  assert.match(review, /logReviewTerminalEvent/);
  assert.match(review, /formatDoneEvent/);
  assert.match(review, /formatErrorEvent/);
});

test("adapter canonical tag contract includes live auto-pipeline stages", () => {
  const emittedStages = new Set(
    Array.from(
      autoPipeline.matchAll(/logNdjson\(session,\s*"PIPELINE_STAGE"[\s\S]*?\{\s*stage:\s*"([^"]+)"/g),
      (match) => match[1]
    )
  );
  assert.deepEqual([...emittedStages].sort(), ["check", "diff", "fix", "review"]);

  for (const stage of emittedStages) {
    assert.match(adapterTypes, new RegExp(`"PIPELINE:${stage}"`));
    assert.match(adapterTypes, new RegExp(`"PIPELINE:${stage}:done"`));
    assert.match(adapterEventVocabulary, new RegExp(`\\b${stage}\\b`));
  }
});

test("working-tree review empty check includes untracked files", () => {
  const review = bridge.match(/async function executeReviewRun[\s\S]*?async function executeTaskRun/)?.[0] ?? "";
  const workingTreeCheck = review.match(
    /if \(target\.mode === "working-tree"\) \{[\s\S]*?throw new CliError\("No working-tree changes to review\."/,
  )?.[0] ?? "";
  assert.match(workingTreeCheck, /git", \["diff", "--quiet"\]/);
  assert.match(workingTreeCheck, /git", \["diff", "--cached", "--quiet"\]/);
  assert.match(workingTreeCheck, /git", \["ls-files", "--others", "--exclude-standard"\]/);
  assert.match(workingTreeCheck, /untrackedCheck\.status === 0/);
  assert.match(workingTreeCheck, /untrackedCheck\.stdout\.trim\(\) === ""/);
  assert.ok(workingTreeCheck.indexOf("untrackedCheck") < workingTreeCheck.indexOf("throw new CliError"));
});

test("version json exposes backend adapter capability contract", () => {
  const version = bridge.match(/async function handleVersion[\s\S]*?emitSuccess\("version"/)?.[0] ?? "";
  assert.match(bridge, /"backend-adapter"/);
  assert.match(version, /active_backend:\s*codexAdapter\.name/);
  assert.match(version, /adapter_capabilities:\s*codexAdapter\.capabilities\(\)/);
});

test("background task writes job record before spawning worker", () => {
  const enqueue = bridge.match(/function enqueueBackgroundTask[\s\S]*?async function handleReviewCommand/)?.[0] ?? "";
  const writeIdx = enqueue.indexOf("writeJobFile(job.workspaceRoot, job.id, queuedRecord)");
  const spawnIdx = enqueue.indexOf("spawnDetachedTaskWorker(cwd, job.id, logFile)");
  assert.ok(writeIdx >= 0, "queued job record must be written");
  assert.ok(spawnIdx >= 0, "worker spawn must remain in enqueueBackgroundTask");
  assert.ok(writeIdx < spawnIdx, "job record must be persisted before worker spawn");
  assert.match(enqueue, /status:\s*"failed"/);
  assert.match(enqueue, /errorMessage/);
});

test("resume-last task prompt avoids undefined template output", () => {
  const runBridgeTask = bridge.match(/async function runBridgeTask[\s\S]*?function extractPlanSteps/)?.[0] ?? "";
  assert.match(runBridgeTask, /const taskPrompt = request\.resumeLast && !String\(request\.prompt \?\? ""\)\.trim\(\)/);
  assert.match(runBridgeTask, /DEFAULT_CONTINUE_PROMPT/);
  assert.doesNotMatch(runBridgeTask, /\$\{metaSkillsPrefix\}\$\{request\.prompt\}/);
});

test("workspace-dirty recovery emits incomplete before generic error handling", () => {
  const errorBranch = bridge.match(/if \(result\.exitStatus !== 0 && result\.error\) \{[\s\S]*?setPhase\("error"/)?.[0] ?? "";
  const workspaceDirtyIdx = errorBranch.indexOf('codexErrorInfo?.code === "SandboxError"');
  const errorEventIdx = errorBranch.indexOf("formatErrorEvent(session");
  assert.ok(workspaceDirtyIdx >= 0, "workspace-dirty recovery branch must exist");
  assert.ok(errorEventIdx >= 0, "generic error terminal branch must exist");
  assert.ok(workspaceDirtyIdx < errorEventIdx, "sandbox recovery must run before generic ERROR terminal emission");
  assert.match(errorBranch, /formatIncompleteEvent\(session/);
  assert.match(errorBranch, /markTerminalEmitted\(\);\s*return \{ \.\.\.result, session, exitStatus: 0, error: null \};/);
});
