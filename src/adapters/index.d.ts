// Canonical type contract for codex-bridge backend adapters.
//
// v2.0 ships only the codex adapter; this contract is the seam for
// future adapters (gemini, aider, claude-cli, ollama, ...).
//
// See ./index.mjs for the registry implementation.
// See ./_interface/INTERFACE.md for the prose contract.
// See ./_interface/EVENT_VOCABULARY.md for canonical tag glossary.
// See ./_interface/CAPABILITIES.md for capability flags + resolution order.
// See ./_interface/BRIEF.md for the brief schema and rendering rules.

export interface BackendAdapter {
  name: string;
  displayName: string;
  capabilities(): CapabilitiesObject;
  validateConfig(config: Record<string, unknown>): { valid: boolean; errors: string[] };

  dispatch(prompt: string | RenderedBrief, options: DispatchOptions): Promise<DispatchResult>;
  streamEvents(jobId: string, signal?: AbortSignal): AsyncIterable<NormalizedEvent>;
  getResult(jobId: string): Promise<NormalizedResult>;
  cancel(jobId: string): Promise<{ ok: boolean; reason?: string }>;

  // Optional verbs gated by capability flags.
  respond?(jobId: string, requestId: string, answer: unknown): Promise<{ ok: boolean }>;
  steer?(jobId: string, turnId: string, prompt: string): Promise<{ ok: boolean }>;
  resume?(jobId: string, prompt: string, options: DispatchOptions): Promise<DispatchResult>;
  setup?(): Promise<SetupReport>;
  authStatus?(): Promise<AuthStatus>;
}

export interface DispatchOptions {
  cwd?: string;
  mode?: "default" | "plan" | "read-only";
  model?: string;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  timeoutMs?: number;
  background?: boolean;
  worktreePath?: string;
  baseSha?: string;
  briefHash?: string;
  parentTaskId?: string;
  iterationIndex?: number;
  signal?: AbortSignal;
  adapterOptions?: Record<string, unknown>;
}

export interface DispatchResult {
  jobId: string;
  threadId: string;
  sessionDir: string;
  capabilities: CapabilitiesObject;
}

export interface NormalizedEvent {
  ts: string;
  tag: CanonicalTag | AdapterTag;
  origin: "adapter" | "bridge";
  data: Record<string, unknown>;
  raw?: unknown;
}

export type CanonicalTag =
  | "DONE" | "ERROR" | "INCOMPLETE"
  | "PLAN" | "QUESTION" | "CONFIRMED"
  | "CHECKPOINT" | "HEARTBEAT"
  | "PIPELINE:diff" | "PIPELINE:plan" | "PIPELINE:execute" | "PIPELINE:review" | "PIPELINE:fix" | "PIPELINE:check"
  | "PIPELINE:diff:done" | "PIPELINE:plan:done" | "PIPELINE:execute:done" | "PIPELINE:review:done" | "PIPELINE:fix:done" | "PIPELINE:check:done"
  | "PIPELINE:review:failed" | "PIPELINE:check:failed"
  | "PIPELINE:done" | "PIPELINE:failed"
  | "RETRYING" | "PARTIAL" | "HANDOFF" | "WARNING"
  | "DIRECTIVES";

export type AdapterTag = `ADAPTER:${string}:${string}`;

export interface NormalizedResult {
  jobId: string;
  threadId: string;
  phase:
    | "queued"
    | "running"
    | "plan-pending"
    | "done"
    | "incomplete"
    | "workspace-dirty"
    | "error"
    | "cancelled";
  exitCode: number;
  terminalTag: CanonicalTag | AdapterTag | null;
  summary?: string;
  artifacts?: { diff?: string; plan?: string; review?: string; verdict?: string };
  durationMs?: number;
}

export interface CapabilitiesObject {
  supports_plan_mode: boolean;
  supports_questions: boolean;
  supports_streaming: boolean;
  supports_resume: boolean;
  supports_steering: boolean;
  supports_background: boolean;
  supports_auto_pipeline: boolean;
  supports_adversarial_review: boolean;
  supports_worktree: boolean;
  supports_artifact_registry: boolean;
  input_modalities: ("text" | "image" | "files")[];
  output_modalities: ("text" | "diff" | "structured")[];
  max_prompt_chars: number;
  billing_model: "subscription" | "metered" | "local";
  auth_strategy: "oauth-cli" | "api-key" | "none" | "ssh-key";
  transport: string;
  // Adapters MAY add extra capability keys; consumers must tolerate unknown keys.
  [key: string]: unknown;
}

export type BooleanCapability =
  | "supports_plan_mode"
  | "supports_questions"
  | "supports_streaming"
  | "supports_resume"
  | "supports_steering"
  | "supports_background"
  | "supports_auto_pipeline"
  | "supports_adversarial_review"
  | "supports_worktree"
  | "supports_artifact_registry";

export interface RenderedBrief {
  promptText: string;
  briefHash: string;
  goal: string;
  workerAssignment: string;
}

export interface SetupReport {
  ok: boolean;
  installed: boolean;
  authenticated: boolean;
  detail: string;
}

export interface AuthStatus {
  ok: boolean;
  authenticated: boolean;
  identity?: string;
  detail: string;
}

export interface SelectAdapterOptions {
  backend?: string;
  envBackend?: string;
  metaBackend?: string;
  subagentType?: string;
  workspaceConfig?: Record<string, unknown>;
  cwdConfig?: Record<string, unknown>;
  userConfig?: Record<string, unknown>;
  defaultBackend?: string;
}

export function loadAdapter(name: string): Promise<BackendAdapter>;
export function selectAdapter(options?: SelectAdapterOptions): Promise<BackendAdapter>;
export function guardCapability(
  adapter: BackendAdapter,
  capability: BooleanCapability,
): void;
export function registerErrorMapper(
  adapterName: string,
  mapper: (error: unknown) => { code: string; class: string; details?: unknown },
): void;
export function getErrorMapper(
  adapterName: string,
): ((error: unknown) => { code: string; class: string; details?: unknown }) | undefined;

export class AdapterError extends Error {
  class: "validation";
  code: string;
  retryable: false;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown);
}
