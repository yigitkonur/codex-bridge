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

test("broker direct invocation detection uses platform-safe file URLs", () => {
  assert.match(broker, /pathToFileURL\(process\.argv\[1\]\)\.href/);
  assert.doesNotMatch(broker, /new URL\(`file:\/\/\$\{process\.argv\[1\]\}`\)/);
});

test("wait terminal matching is anchored to event headers", () => {
  assert.match(bridge, /const TERMINAL = TERMINAL_TAG_REGEX/);
  assert.match(bridge, /TERMINAL_TAG_REGEX/);
  assert.match(bridge, /async function handleWaitAny/);
  assert.match(bridge, /mode: "any"/);
  assert.match(bridge, /case "\$line" in "\[DONE\]"\*\|"\[ERROR\]"\*\|"\[INCOMPLETE\]"\*\|"\[PLAN\]"\*/);
  assert.doesNotMatch(bridge, /\*"\[DONE\]"\*\|\*"\[ERROR\]"\*\|\*"\[INCOMPLETE\]"\*\|\*"\[PLAN\]"\*/);
});

test("task retry binds same-thread retry to the failed thread id", () => {
  assert.doesNotMatch(bridge, /const retryResult = await executeTaskRun\(bridgeRequest\);/);
  assert.match(bridge, /resumeThreadId: result\.threadId/);
});

test("resume task chooses default continue prompt before prompt decorators", () => {
  const task = bridge.match(/async function runBridgeTask[\s\S]*?const activeMode = isPlanMode \? "plan" : "default";/)?.[0] ?? "";
  const defaultPromptIndex = task.indexOf("const baseTaskPrompt = request.resumeLast && !String(request.prompt ?? \"\").trim()");
  const footerIndex = task.indexOf("const promptWithFooter = config.prompt_footer");
  assert.notEqual(defaultPromptIndex, -1);
  assert.notEqual(footerIndex, -1);
  assert.ok(defaultPromptIndex < footerIndex);
  assert.match(task, /\? DEFAULT_CONTINUE_PROMPT\s+: \(request\.prompt \?\? ""\);/);
  assert.match(task, /const taskPrompt = appendRenderedBriefToPrompt\(baseTaskPrompt, request\.brief \?\? null\);/);
  assert.match(task, /\$\{metaSkillsPrefix\}\$\{taskPrompt\}\\n\\n\$\{config\.prompt_footer\}/);
  assert.match(task, /\$\{metaSkillsPrefix\}\$\{taskPrompt\}/);
  assert.doesNotMatch(task, /\$\{metaSkillsPrefix\}\$\{request\.prompt\}/);
});

test("task brief is delivered into effective worker prompt", () => {
  assert.match(bridge, /function appendRenderedBriefToPrompt\(prompt, brief\)/);
  assert.match(bridge, /CODEX-BRIDGE STRUCTURED BRIEF/);
  assert.match(bridge, /renderBriefAsMarkdown\(brief\)/);
  assert.match(bridge, /brief: brief \?\? null/);
  assert.match(bridge, /brief,\n\s+write,/);
});

test("task rejects thread-only resume with automatic worktree creation", () => {
  const handleTask = bridge.match(/async function handleTask\(argv\)[\s\S]*?async function handleTaskWorker/)?.[0] ?? "";
  assert.match(handleTask, /resumeLast && options\["worktree-auto"\]/);
  assert.match(handleTask, /RESUME_WORKTREE_CONFLICT/);
  assert.match(handleTask, /codex-bridge iterate <task_id>/);
});

test("brief schema violations preserve details and a fix suggestion", () => {
  const handleTask = bridge.match(/if \(options\.brief\) \{[\s\S]*?const model = normalizeRequestedModel/)?.[0] ?? "";
  assert.match(handleTask, /details: result\.details/);
  assert.match(handleTask, /BRIEF_SCHEMA_VIOLATION/);
  assert.match(handleTask, /valid top-level keys/);
});

test("respond and summary resolve cwd before loading config", () => {
  const respond = bridge.match(/async function handleRespond[\s\S]*?async function handleSummary/)?.[0] ?? "";
  const summary = bridge.match(/async function handleSummary[\s\S]*?async function main/)?.[0] ?? "";
  assert.match(respond, /const cwd = resolveCommandCwd\(options\);/);
  assert.match(summary, /const cwd = resolveCommandCwd\(options\);/);
});

test("session directories resolve relative to canonical workspace roots", () => {
  const callSites = [...bridge.matchAll(/resolveSessionDir\(config\.session_dir, resolveWorkspaceRoot\(cwd\)\)/g)];
  assert.ok(callSites.length >= 6, "interactive commands should pass workspace root as session_dir base");
  assert.match(bridge, /resolveSessionDir\(config\.session_dir, workspaceRoot\)/);
  assert.match(bridge, /resolveSessionDir\(reviewConfig\.session_dir, resolveWorkspaceRoot\(request\.cwd\)\)/);
  assert.match(bridge, /resolveSessionDir\(getBridgeConfig\(cwd \?\? null, job\.workspaceRoot\)\.session_dir, job\.workspaceRoot\)/);
});

test("v2.2 ergonomics hooks are wired into runtime surfaces", () => {
  assert.match(bridge, /validateConfigLayers\(ROOT_DIR, cwd, workspaceRoot\)/);
  assert.match(bridge, /function cleanupTerminalJobs/);
  assert.match(bridge, /retention-days/);
  assert.match(bridge, /prepareRuntimeSession/);
  assert.match(bridge, /writeSessionAliases\(session, jobId\)/);
  assert.match(bridge, /assistantPreview: checkpointState\.lastAssistantMessage/);
  assert.match(bridge, /update_check:/);
  assert.match(bridge, /apply:/);
});

test("auto-apply stays inert for help and json discovery paths", () => {
  const autoApply = bridge.match(/function maybeTriggerAutoApply[\s\S]*?function spawnDetachedAutoApply/)?.[0] ?? "";
  assert.match(autoApply, /detectJsonFlag\(rawArgv\)/);
  assert.match(autoApply, /detectHelpFlag\(rawArgv\)/);
  assert.match(autoApply, /subcommand === "version" \|\| subcommand === "update"/);
});

test("explicit update apply has a bounded installer timeout", () => {
  const apply = bridge.match(/function runSkillsAddForApply[\s\S]*?function renderUpdateFailureHint/)?.[0] ?? "";
  assert.match(apply, /const timeoutMs = 600_000/);
  assert.match(apply, /timeout: timeoutMs/);
  assert.match(apply, /skills installer timed out/);
});

test("recovery-sensitive commands emit structured recovery payloads", () => {
  const awaitArtifact = bridge.match(/async function handleAwaitArtifact[\s\S]*?function pruneOrphanedJobs/)?.[0] ?? "";
  const prune = bridge.match(/function pruneOrphanedJobs[\s\S]*?function finalizeOrphan/)?.[0] ?? "";
  const cancel = bridge.match(/async function handleCancel[\s\S]*?function resolvePromptInput/)?.[0] ?? "";
  const respond = bridge.match(/async function handleRespond[\s\S]*?async function handleSummary/)?.[0] ?? "";

  assert.match(awaitArtifact, /recovery: buildRecovery\(/);
  assert.match(awaitArtifact, /reason: "timeout"/);
  assert.match(awaitArtifact, /expectedArtifactPath: resolvedPath/);
  assert.match(prune, /recovery: buildRecovery\(/);
  assert.match(prune, /reason: reaped\.length > 0 \? "orphans-reaped" : "state-clean"/);
  assert.match(cancel, /recovery: buildRecovery\(/);
  assert.match(cancel, /reason: "cancelled-by-user"/);
  assert.match(respond, /respond --json-payload must be valid JSON/);
  assert.match(respond, /catch \(error\)/);
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
  assert.match(bridge, /buildErrorEnvelope\(classifyError\(errLike\), \{ command, partial, handoff, origin, nextAction \}\)/);
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

test("task failures attach cause-aware next action to the error object", () => {
  const errorBranch = bridge.match(/if \(result\.exitStatus !== 0 && result\.error\) \{[\s\S]*?return \{ \.\.\.result, session \};/)?.[0] ?? "";
  assert.match(bridge, /function buildTurnErrorNextAction/);
  assert.match(errorBranch, /const nextAction = buildTurnErrorNextAction/);
  assert.match(errorBranch, /result\.error\.origin = origin/);
  assert.match(errorBranch, /result\.error\.nextAction = nextAction/);
});

test("background task enqueue persists queued record before spawning worker", () => {
  const enqueue = bridge.match(/function enqueueBackgroundTask[\s\S]*?async function handleReviewCommand/)?.[0] ?? "";
  const writeQueued = enqueue.indexOf("writeJobFile(job.workspaceRoot, job.id, queuedRecord);");
  const upsertQueued = enqueue.indexOf("upsertJob(job.workspaceRoot, queuedRecord);");
  const spawnWorker = enqueue.indexOf("spawnDetachedTaskWorker(cwd, job.workspaceRoot, job.id, logFile);");
  assert.notEqual(writeQueued, -1);
  assert.notEqual(upsertQueued, -1);
  assert.notEqual(spawnWorker, -1);
  assert.ok(writeQueued < spawnWorker);
  assert.ok(upsertQueued < spawnWorker);
  assert.match(enqueue, /pid: null,\n\s+logFile,\n\s+request/);
  assert.match(enqueue, /const existingRecord = readStoredJob\(job\.workspaceRoot, job\.id\) \?\? queuedRecord;/);
  assert.match(enqueue, /if \(existingRecord\.status === "queued"\) \{/);
  assert.match(enqueue, /pid: spawnedPid/);
  assert.match(enqueue, /monitor: buildMonitorHint\(\{ eventsPath: null, jobId: job\.id, threadId: null, cwd: request\.stateCwd \?\? job\.workspaceRoot \}\)/);
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

test("task pipeline envelope preserves partial-completion proof fields", () => {
  const taskPipeline = bridge.match(/const pipelineResult = await runAutoPipeline[\s\S]*?return \{ \.\.\.result, session, pipeline: pipelineResult \};/)?.[0] ?? "";
  assert.match(taskPipeline, /pipelineResult\.failing_stage/);
  assert.match(taskPipeline, /setPhase\("incomplete"[\s\S]*\{ pipeline: pipelineResult, monitor \}/);
  assert.match(taskPipeline, /setPhase\("done"[\s\S]*\{ pipeline: pipelineResult, monitor \}/);
  assert.match(taskPipeline, /return \{ \.\.\.result, session, pipeline: pipelineResult \};/);

  for (const field of [
    "partial",
    "failing_stage",
    "stageTimeoutMs",
    "totalTimeoutMs",
    "reviewVerdict",
    "reviewFindingCount",
    "fixFilesTouched",
    "completion",
    "missingItems",
    "completionSummary",
  ]) {
    assert.match(autoPipeline, new RegExp(`${field}(?:\\s*:|\\s*,)`), `pipeline result should expose ${field}`);
  }
});

test("auto-pipeline final diff is task-base aware and check events include missing items", () => {
  assert.match(autoPipeline, /import \{ readMeta \} from "\.\.\/\.\.\/lib\/registry\.mjs";/);
  assert.match(autoPipeline, /const taskMeta = jobId \? readMeta\(jobId\) : null;/);
  assert.match(autoPipeline, /const captureTaskDiff = \(\) =>/);
  assert.match(autoPipeline, /const finalDiff = captureTaskDiff\(\);/);
  assert.match(autoPipeline, /missing_items=\$\{JSON\.stringify\(completionResult\.missing_items\)\}/);
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
  assert.match(version, /const adapter = await resolveCommandAdapter/);
  assert.match(version, /active_backend:\s*adapter\.name/);
  assert.match(version, /adapter_capabilities:\s*adapter\.capabilities\(\)/);
});

test("setup json exposes backend adapter capability contract", () => {
  const setupReport = bridge.match(/async function buildSetupReport[\s\S]*?async function handleSetup/)?.[0] ?? "";
  assert.match(setupReport, /const adapter = await resolveCommandAdapter/);
  assert.match(setupReport, /active_backend:\s*adapter\.name/);
  assert.match(setupReport, /adapter_capabilities:\s*adapter\.capabilities\(\)/);
});

test("task execution routes through backend adapter dispatch", () => {
  const executeTask = bridge.match(/async function executeTaskRun[\s\S]*?function buildReviewJobMetadata/)?.[0] ?? "";
  assert.match(executeTask, /const adapter = request\.adapter \?\? await resolveCommandAdapter/);
  assert.match(executeTask, /adapter\.dispatch\(request\.prompt/);
  assert.match(executeTask, /rawResult/);
});

test("resume, questions, steering, and cancel use adapter lifecycle methods", () => {
  const send = bridge.match(/async function handleSend[\s\S]*?async function handleSteer/)?.[0] ?? "";
  assert.match(send, /guardCapability\(adapter, "supports_resume"\)/);
  assert.match(send, /adapter\.resume\(threadId, prompt/);
  assert.doesNotMatch(send, /runAppServerTurn\(cwd, turnOptions\)/);

  const steer = bridge.match(/async function handleSteer[\s\S]*?async function handleRespond/)?.[0] ?? "";
  assert.match(steer, /guardCapability\(adapter, "supports_steering"\)/);
  assert.match(steer, /adapter\.steer\(threadId, turnId, prompt/);
  assert.doesNotMatch(steer, /withAppServer\(cwd/);

  const respond = bridge.match(/async function handleRespond[\s\S]*?async function handleSummary/)?.[0] ?? "";
  assert.match(respond, /guardCapability\(adapter, "supports_questions"\)/);
  assert.match(respond, /adapter\.respond\(pending\.threadId, requestId, payload/);
  assert.doesNotMatch(respond, /writeResponseFile/);

  const cancel = bridge.match(/async function handleCancel[\s\S]*?function resolvePromptInput/)?.[0] ?? "";
  assert.match(cancel, /adapter\.cancel\(job\.id/);
});

test("result command asks the selected adapter for normalized result", () => {
  const result = bridge.match(/async function handleResult[\s\S]*?function waitForTerminalEvent/)?.[0] ?? "";
  assert.match(result, /const adapter = await resolveCommandAdapter/);
  assert.match(result, /adapter\.getResult\(job\.id, \{ cwd \}\)/);
  assert.match(result, /adapterResult/);
});

test("background task writes job record before spawning worker", () => {
  const enqueue = bridge.match(/function enqueueBackgroundTask[\s\S]*?async function handleReviewCommand/)?.[0] ?? "";
  const writeIdx = enqueue.indexOf("writeJobFile(job.workspaceRoot, job.id, queuedRecord)");
  const spawnIdx = enqueue.indexOf("spawnDetachedTaskWorker(cwd, job.workspaceRoot, job.id, logFile)");
  assert.ok(writeIdx >= 0, "queued job record must be written");
  assert.ok(spawnIdx >= 0, "worker spawn must remain in enqueueBackgroundTask");
  assert.ok(writeIdx < spawnIdx, "job record must be persisted before worker spawn");
  assert.match(enqueue, /status:\s*"failed"/);
  assert.match(enqueue, /errorMessage/);
});

test("resume-last task prompt avoids undefined template output", () => {
  const runBridgeTask = bridge.match(/async function runBridgeTask[\s\S]*?function extractPlanSteps/)?.[0] ?? "";
  assert.match(runBridgeTask, /const baseTaskPrompt = request\.resumeLast && !String\(request\.prompt \?\? ""\)\.trim\(\)/);
  assert.match(runBridgeTask, /const taskPrompt = appendRenderedBriefToPrompt\(baseTaskPrompt, request\.brief \?\? null\)/);
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

test("worktree-auto keeps job state anchored to the launch workspace", () => {
  const task = bridge.match(/async function handleTask[\s\S]*?async function handleTaskWorker/)?.[0] ?? "";
  assert.match(task, /const stateCwd = cwd;/);
  assert.match(task, /const job = buildTaskJob\(workspaceRoot, taskMetadata, write, \{/);
});

test("background task-worker receives the original workspace root", () => {
  assert.match(bridge, /function spawnDetachedTaskWorker\(cwd, workspaceRoot, jobId, logFile = null\)/);
});

test("background task-worker reads queued jobs from original workspace root", () => {
  const worker = bridge.match(/async function handleTaskWorker[\s\S]*?async function handleStatus/)?.[0] ?? "";
  assert.match(worker, /const workspaceRoot = options\["workspace-root"\]/);
  assert.match(worker, /readStoredJob\(workspaceRoot, options\["job-id"\]\)/);
});

test("worktree-auto exposes the returned task id as the registry id", () => {
  const task = bridge.match(/async function handleTask[\s\S]*?async function handleTaskWorker/)?.[0] ?? "";
  const enqueue = bridge.match(/function enqueueBackgroundTask[\s\S]*?async function handleReviewCommand/)?.[0] ?? "";
  assert.match(task, /job\.registryTaskId = job\.id;/);
  assert.match(enqueue, /registryTaskId: job\.registryTaskId \?\? null/);
});
