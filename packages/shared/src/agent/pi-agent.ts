import { protectApplicationCommand, SpawnSessionInputError } from '@craft-agent/session-tools-core';
/**
 * Pi Backend (Subprocess RPC Client)
 *
 * Thin subprocess client for the Pi coding agent. Spawns a pi-agent-server
 * subprocess and communicates via JSONL over stdin/stdout.
 *
 * The subprocess runs the Pi SDK (@earendil-works/pi-coding-agent) in-process,
 * handles tool wrapping, permission enforcement, and LLM queries.
 * This file manages subprocess lifecycle, JSONL protocol, event forwarding,
 * and proxy tool routing for MCP/API sources.
 *
 * Auth is API key based. Keys are retrieved from the credential manager
 * and passed to the subprocess during initialization.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { AgentEvent } from '@craft-agent/core/types';
import type { FileAttachment } from '../utils/files.ts';
import { i18n } from '../i18n/index.ts';
import { getProxyEnvVars } from '../config/proxy-env.ts';
import {
  buildRestrictedSubprocessEnvironment,
  registerLongRunningProcess,
  type LongRunningProcessHandle,
} from '../processes/index.ts';

import type {
  BackendConfig,
  BackendRuntimeUpdate,
  ChatOptions,
  SdkMcpServerConfig,
} from './backend/types.ts';
import { AbortReason, ProviderDispatchRejectedError, ToolAdmissionRecoveryError } from './backend/types.ts';
import { getBackendRuntime } from './backend/internal/driver-types.ts';
import { SourceActivationDrainController } from './source-activation-drain.ts';

import type { PermissionMode } from './mode-manager.ts';
import type { ThinkingLevel } from './thinking-levels.ts';

// Import models from centralized registry
import { getModelById } from '../config/models.ts';

// BaseAgent provides common functionality
import { BaseAgent } from './base-agent.ts';
import type { Workspace } from '../config/storage.ts';

// Event adapter
import { PiEventAdapter } from './backend/pi/event-adapter.ts';
import { EventQueue } from './backend/event-queue.ts';

// System prompt for Craft Agent context
import { getSystemPromptAsync } from '../prompts/system.ts';
import { getCoAuthorPreference } from '../config/preferences.ts';
import { loadProjectById, getProjectAssetsPath, listProjectAssets, getProjectMemoryPath, loadProjectMemory } from '../projects/storage.ts';
import type { ProjectPromptContext } from '../projects/types.ts';
import { ROBINSWOOD_BACKEND_NAME } from '../robinswood-branding.ts';

// Credential manager for token storage
import { getCredentialManager } from '../credentials/manager.ts';

// ChatGPT OAuth token refresh (used when Pi routes ChatGPT auth)
import { refreshChatGptTokens } from '../auth/chatgpt-oauth.ts';

// Session-scoped tool callbacks (for SubmitPlan, source auth, etc.)
import {
  registerSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  setLastPlanFilePath,
  getSessionScopedToolCallbacks,
} from './session-scoped-tools.ts';
import { attachSessionSelfManagementBindings } from './session-self-management-bindings.ts';

// Session tool proxy definitions (for registering with subprocess)
import { getSessionToolProxyDefs, SESSION_TOOL_NAMES } from './backend/pi/session-tool-defs.ts';

// Session tool registry (for executing proxy tool calls)
import {
  SESSION_BACKEND_TOOL_NAMES,
  SESSION_TOOL_REGISTRY,
  type ToolResult as SessionToolResult,
} from '@craft-agent/session-tools-core';
import { createClaudeContext, type SessionToolContext } from './claude-context.ts';
import { getPermissionModeDiagnostics } from './mode-manager.ts';

// call_llm pre-execution pipeline

// McpClientPool for source tool proxying (centralized pool from main process)
import type { McpClientPool, McpToolResult } from '../mcp/mcp-pool.ts';

// Path utilities
import { join } from 'path';
import { homedir } from 'os';

// Session storage (plans folder path)
import { getSessionDataPath, getSessionPath, getSessionPlansPath } from '../sessions/storage.ts';

// Error typing
import { parseError, type AgentError } from './errors.ts';
import { assertExistingWorkingDirectory, InvalidWorkingDirectoryError } from './spawn-helpers.ts';

// Centralized PreToolUse pipeline
import {
  beginContextualGmailHostExecution,
  confirmContextualGmailRuntimeTeardown,
  hasContextualGmailInFlightForRuntime,
  invalidateContextualGmailSessionState,
  recordContextualGmailToolResult,
  resolveContextualGmailPromptReservation,
  runPreToolUseChecks,
  settleContextualGmailHostExecution,
  type PreToolUseCheckResult,
} from './core/pre-tool-use.ts';
import { getRtkPath } from './core/rtk-detector.ts';
import { getRtkEnabled, getBrowserToolEnabled } from '../config/storage.ts';
import type { RtkContext } from './core/rtk-rewrite.ts';

// Workspace slug extraction for skill qualification
import { extractWorkspaceSlug } from '../utils/workspace.ts';

// LLM tool types
import { LLM_QUERY_TIMEOUT_MS, type LLMQueryRequest, type LLMQueryResult } from './llm-tool.ts';
import { executeBrowserToolCommand } from './browser-tool-runtime.ts';
import { saveBinaryResponse } from '../utils/binary-detection.ts';
import { parseCompactCommand } from './compact-command.ts';
import { redactSecretLikeMaterial } from '../utils/redaction.ts';

const RUNTIME_DIAGNOSTIC_MAX_CHARS = 4_000;
const DEFAULT_SUBPROCESS_STARTUP_TIMEOUT_MS = 20_000;
const MAX_SUBPROCESS_STARTUP_TIMEOUT_MS = 120_000;
export const PI_SUBPROCESS_FORCE_KILL_DELAY_MS = 2_000;

interface PiSubprocessRuntimeContext {
  runtimeId: string;
  sessionId: string;
}

type PiRuntimeInterruptionCode = Extract<AgentEvent, { type: 'runtime_interrupted' }>['code'];

class PiRuntimeInterruptedError extends Error {
  readonly interruptionCode: PiRuntimeInterruptionCode;

  constructor(message: string, interruptionCode: PiRuntimeInterruptionCode) {
    super(message);
    this.name = 'PiRuntimeInterruptedError';
    this.interruptionCode = interruptionCode;
  }
}

export function resolvePiSubprocessStartupTimeoutMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SUBPROCESS_STARTUP_TIMEOUT_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), MAX_SUBPROCESS_STARTUP_TIMEOUT_MS)
    : DEFAULT_SUBPROCESS_STARTUP_TIMEOUT_MS;
}

/** Inputs intentionally granted to one Pi subprocess generation. */
export interface PiSubprocessEnvironmentOptions {
  proxyEnv?: Record<string, string>;
  envOverrides?: Record<string, string>;
  providerEnv?: Record<string, string>;
  awsEnv?: Record<string, string>;
  sessionDir?: string;
  debugEnabled: boolean;
}

/**
 * Build Pi's child environment without inheriting unrelated host credentials.
 * Provider credentials and per-session values must arrive through an explicit
 * input map, making the privilege boundary reviewable at the call site.
 */
export function buildPiSubprocessEnvironment(
  options: PiSubprocessEnvironmentOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return buildRestrictedSubprocessEnvironment(
    {
      ...options.proxyEnv,
      ...options.envOverrides,
      ...options.providerEnv,
      ...options.awsEnv,
      ...(options.sessionDir ? { CRAFT_SESSION_DIR: options.sessionDir } : {}),
      CRAFT_DEBUG: options.debugEnabled ? '1' : '0',
    },
    baseEnv,
  );
}

const BEDROCK_ENVIRONMENT_AUTH_KEYS = [
  // Static/session credentials. These are copied only when the user selected
  // the Bedrock environment credential chain for this connection.
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',

  // Profile, region and shared credential/config file routing.
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_SDK_LOAD_CONFIG',
  'AWS_CA_BUNDLE',

  // Workload identity / container / instance role credential chain.
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_EC2_METADATA_DISABLED',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT',
  'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',

  // Explicit Bedrock endpoint/runtime controls.
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_BEDROCK',
  'AWS_BEDROCK_FORCE_HTTP1',
] as const;

function pickExplicitEnvironment(
  keys: readonly string[],
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = baseEnv[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

const PROVIDER_CONTRACT_ENVIRONMENT_KEYS = [
  'ROBB_DISABLE_UNSTABLE_PROVIDERS',
  'ROBB_DISABLE_CHATGPT_CODEX_BACKEND',
  'ROBB_DISABLE_GITHUB_COPILOT_PROXY',
  'ROBB_DISABLE_GOOGLE_CODE_ASSIST_V1INTERNAL',
] as const;

/**
 * Grant only non-secret bootstrap and emergency contract controls to Pi.
 * Scoped switches are limited to the selected provider; the master switch is
 * intentionally common to every Pi subprocess.
 */
export function buildPiProviderEnvironment(
  piAuthProvider: string | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  googleCloudProject?: string,
): Record<string, string> {
  const keys: string[] = [PROVIDER_CONTRACT_ENVIRONMENT_KEYS[0]];
  if (piAuthProvider === 'openai-codex') keys.push(PROVIDER_CONTRACT_ENVIRONMENT_KEYS[1]);
  if (piAuthProvider === 'github-copilot') keys.push(PROVIDER_CONTRACT_ENVIRONMENT_KEYS[2]);
  if (piAuthProvider === 'google-gemini-code-assist') {
    keys.push(
      PROVIDER_CONTRACT_ENVIRONMENT_KEYS[3],
      'GOOGLE_CLOUD_PROJECT',
      'GOOGLE_CLOUD_PROJECT_ID',
    );
  }
  if (piAuthProvider === 'mistral-vibe') keys.push('ROBB_VIBE_ACP_COMMAND');
  if (piAuthProvider === 'google-antigravity') keys.push('ROBB_ANTIGRAVITY_COMMAND');
  const environment = pickExplicitEnvironment(keys, baseEnv);
  if (piAuthProvider === 'google-gemini-code-assist' && googleCloudProject?.trim()) {
    environment.GOOGLE_CLOUD_PROJECT = googleCloudProject.trim();
    delete environment.GOOGLE_CLOUD_PROJECT_ID;
  }
  return environment;
}

type PiAuthPayload = {
  provider: string;
  credential:
    | { type: 'api_key'; key: string }
    | { type: 'oauth'; access: string; refresh: string; expires: number }
    | { type: 'iam'; accessKeyId: string; secretAccessKey: string; region?: string; sessionToken?: string };
};

type TokenRefreshOutcome =
  | { refreshed: false }
  | { refreshed: true; piAuth: PiAuthPayload; bindingId?: string };

const PREEMPTIVE_PI_OAUTH_PROVIDERS = new Set([
  'openai-codex',
  'github-copilot',
  'google-gemini-code-assist',
]);

/**
 * Decide whether a cold Pi runtime must join/start OAuth refresh before it
 * reads credentials. Joining an in-flight refresh closes the race where an
 * auth-failed runtime is disposed while its replacement still sees the stale
 * token.
 */
export function shouldRefreshPiOAuthBeforeSpawn(input: {
  authType?: string;
  piAuthProvider?: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshInFlight: boolean;
  nowMs?: number;
}): boolean {
  if (input.authType !== 'oauth') return false;
  if (!input.piAuthProvider || !PREEMPTIVE_PI_OAUTH_PROVIDERS.has(input.piAuthProvider)) {
    return false;
  }
  if (input.refreshInFlight) return true;
  if (!input.refreshToken) return false;

  const nowMs = input.nowMs ?? Date.now();
  return !input.expiresAt || input.expiresAt < nowMs + 5 * 60_000;
}

// Supplement the shared free-text redactor with credential formats that can
// appear in Pi/provider stderr without an `Authorization: Bearer` prefix.
// Keep this narrow: stderr remains useful, while known credential material is
// removed before it reaches either onDebug or a user-facing connection error.
function redactRuntimeDiagnosticText(value: string): string {
  const sensitiveKey = [
    'authorization',
    'proxy[_-]?authorization',
    'api[_-]?key',
    'access[_-]?token',
    'refresh[_-]?token',
    'session[_-]?token',
    'password',
    'passwd',
    'passphrase',
    'client[_-]?secret',
    'secret[_-]?access[_-]?key',
    'aws[_-]?secret[_-]?access[_-]?key',
    'private[_-]?key',
    'signing[_-]?key',
  ].join('|');

  return redactSecretLikeMaterial(value)
    // Quoted JSON/logfmt keys and values.
    .replace(
      new RegExp(`(["'](?:${sensitiveKey})["']\\s*:\\s*)["'][^"'\\r\\n]*["']`, 'gi'),
      '$1"[REDACTED]"',
    )
    // Environment variables and unquoted logfmt values.
    .replace(
      new RegExp(`(\\b(?:${sensitiveKey})\\b\\s*[=:]\\s*)[^\\s,;]+`, 'gi'),
      '$1[REDACTED]',
    )
    // Common opaque credential formats when stderr prints only the value.
    .replace(/\bsk-(?:(?:proj|ant(?:-api\d+)?)-)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}

// ============================================================
// PiAgent Implementation
// ============================================================

/** Backend-executed session tools currently supported by PiAgent. */
export const PI_BACKEND_SESSION_TOOL_NAMES = new Set<string>([
  'call_llm',
  'spawn_session',
  'browser_tool',
]);

/**
 * Map a transport `err.code` to an agent-facing string for `browser_tool` failures.
 * Returns null for unknown codes so callers can fall back to the raw `err.message`.
 *
 * Receiver-side check: keyed on `err.code === 'X'`, never `instanceof CodedError` —
 * the transport reconstructs a plain `Error` with `.code` attached.
 */
function mapBrowserToolErrorCode(code: string): string | null {
  switch (code) {
    case 'BROWSER_NO_CAPABLE_CLIENT':
    case 'CAPABILITY_UNAVAILABLE':
      return 'No connected desktop client supports browser tools, or no client is currently connected. ' +
        'Ask the user to open this workspace from the Robb Agents desktop app.';
    case 'CLIENT_DISCONNECTED':
      return 'The desktop client that owned this browser session disconnected. ' +
        'Ask the user to reconnect and retry.';
    case 'CLIENT_REQUEST_TIMEOUT':
      return 'Browser operation timed out (>30s). The desktop client may be unresponsive.';
    case 'BROWSER_INSTANCE_NOT_OWNED':
      return 'That browser instance ID doesn\'t belong to this session. ' +
        'Use `windows` to list owned instances, or `open` to create a new one.';
    case 'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED':
      return 'File upload from a remote agent is not supported. ' +
        'Ask the user to attach the file to the session.';
    case 'BROWSER_REMOTE_EVALUATE_BLOCKED':
      return 'JavaScript evaluation is disabled on this desktop client. ' +
        'Ask the user to enable it in settings.';
    default:
      return null;
  }
}

/**
 * Backend implementation using the Pi coding agent SDK via subprocess.
 *
 * Spawns a pi-agent-server subprocess and communicates via JSONL protocol.
 * Extends BaseAgent for common functionality (permission mode, source management,
 * planning heuristics, config watching, usage tracking).
 */
export class PiAgent extends BaseAgent {
  protected backendName = 'Robb Agents Backend';

  // ============================================================
  // Subprocess State
  // ============================================================

  // Subprocess process handle
  private subprocess: ChildProcess | null = null;
  /** Exact host runtime generation owning the current subprocess. */
  private subprocessRuntimeContext: PiSubprocessRuntimeContext | null = null;
  /** Retains the generation identity until a late, confirmed child exit arrives. */
  private subprocessRuntimeContexts = new WeakMap<ChildProcess, PiSubprocessRuntimeContext>();
  /** Diagnostic retained until exit/close proves that the matching child stopped. */
  private subprocessErrorsAwaitingExit = new WeakMap<ChildProcess, Error>();
  private subprocessSupervisorHandle: LongRunningProcessHandle | null = null;
  /** Deduplicates concurrent cold-start callers into one process generation. */
  private subprocessSpawnInFlight: Promise<void> | null = null;
  /** Child processes whose next exit is owner-requested, not a runtime failure. */
  private expectedSubprocessExits = new WeakSet<ChildProcess>();
  /** One bounded SIGKILL escalation per retiring subprocess generation. */
  private subprocessForceKillTimers = new WeakMap<ChildProcess, ReturnType<typeof setTimeout>>();
  private readline: ReadlineInterface | null = null;
  private subprocessReady: Promise<void> | null = null;
  private subprocessReadyResolve: (() => void) | null = null;
  private subprocessReadyReject: ((error: Error) => void) | null = null;
  private subprocessReadyTimer: ReturnType<typeof setTimeout> | null = null;

  // Pi session ID (managed by subprocess, reported back)
  private piSessionId: string | null = null;

  // Callback server port (managed by subprocess)
  private callbackPort: number = 0;

  // State
  private _isProcessing: boolean = false;
  private abortReason?: AbortReason;
  private promptPreparationRevision = 0;

  // Event adapter
  private adapter: PiEventAdapter;

  // Event queue for streaming (AsyncGenerator pattern over subprocess JSONL)
  private eventQueue = new EventQueue();

  /** Provider-start acknowledgements keyed by the exact child prompt id. */
  private pendingProviderHandoffs = new Map<string, () => void>();
  private pendingProviderDispatchRejections = new Map<string, () => void>();

  // Error deduplication — suppress identical consecutive errors after a threshold
  // to prevent a broken subprocess from flooding the user's session.
  private lastSubprocessError: string | null = null;
  private subprocessErrorRepeatCount = 0;
  private static readonly MAX_IDENTICAL_SUBPROCESS_ERRORS = 3;

  /**
   * Look up the bound project (if any) and return a snapshot for system-prompt injection.
   * Mirrors ClaudeAgent.resolveProjectContext — safe to call on every turn since the
   * project config file is small.
   */
  private resolveProjectContext(): ProjectPromptContext | null {
    const projectId = this.config.session?.projectId;
    if (!projectId) return null;

    try {
      const root = this.config.workspace.rootPath;
      const project = loadProjectById(root, projectId);
      if (!project) return null;
      const slug = project.config.slug;
      return {
        name: project.config.name,
        description: project.config.description,
        details: project.config.details,
        assetsPath: getProjectAssetsPath(root, slug),
        assets: listProjectAssets(root, slug).map((a) => ({
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
        })),
        memoryPath: getProjectMemoryPath(root, slug),
        memoryContent: loadProjectMemory(root, slug, 5000, { includeStructured: false }) ?? undefined,
      };
    } catch (error) {
      this.debug(`[resolveProjectContext] Failed to load project ${projectId}: ${error instanceof Error ? error.message : error}`);
      return null;
    }
  }

  private resetSubprocessErrorDedup(): void {
    this.lastSubprocessError = null;
    this.subprocessErrorRepeatCount = 0;
  }

  // Ring buffer of recent subprocess stderr. Always on (independent of CRAFT_DEBUG)
  // so that connection-test and other failures can surface what the subprocess
  // actually said, instead of a bare "timed out" with no context.
  private stderrBuffer: string[] = [];
  private stderrBufferBytes = 0;
  private static readonly STDERR_BUFFER_MAX_BYTES = 8 * 1024;

  private recordStderr(chunk: string): void {
    if (!chunk) return;
    // If a single chunk is larger than the cap, keep only its tail so the
    // buffer always holds the most-recent output even in pathological cases.
    const effective = chunk.length > PiAgent.STDERR_BUFFER_MAX_BYTES
      ? chunk.slice(chunk.length - PiAgent.STDERR_BUFFER_MAX_BYTES)
      : chunk;
    this.stderrBuffer.push(effective);
    this.stderrBufferBytes += effective.length;
    // Drop oldest chunks until we're back under the cap, but always keep at
    // least one entry so a single-chunk tail survives.
    while (this.stderrBufferBytes > PiAgent.STDERR_BUFFER_MAX_BYTES && this.stderrBuffer.length > 1) {
      const dropped = this.stderrBuffer.shift()!;
      this.stderrBufferBytes -= dropped.length;
    }
  }

  /** Returns redacted recent subprocess stderr (up to ~8KB). Empty string if nothing captured. */
  getRecentStderr(): string {
    return redactRuntimeDiagnosticText(this.stderrBuffer.join(''));
  }

  // Pending permission requests (used by handlePreToolUseRequest for ask-mode prompting)
  private pendingPermissions: Map<string, {
    resolve: (allowed: boolean) => void;
    toolName: string;
  }> = new Map();

  // Pending tool executions (correlation map for subprocess tool_execute_request -> main process -> tool_execute_response)
  private pendingToolExecutions: Map<string, {
    resolve: (result: { content: string; isError: boolean }) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Pending mini completions (correlation map for subprocess mini_completion_result)
  private pendingMiniCompletions: Map<string, {
    resolve: (text: string | null) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Pending llm_query calls (correlation map for subprocess llm_query_result).
  // Separate from pendingMiniCompletions because the payload shape differs:
  // queryLlm returns a full LLMQueryResult, not just text.
  private pendingLlmQueries: Map<string, {
    resolve: (result: LLMQueryResult) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Pending ensure_session_ready requests (branch preflight handshake)
  private pendingEnsureSessionReady: Map<string, {
    resolve: (sessionId: string | null) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Pending compact requests (manual compaction RPC)
  private pendingCompactions: Map<string, {
    resolve: (result: { summary: string; firstKeptEntryId: string; tokensBefore: number; estimatedTokensAfter?: number; compactionModel?: string } | null) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Pending auto-compaction toggle requests
  private pendingAutoCompactionToggles: Map<string, {
    resolve: (enabled: boolean) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Pending runtime config updates (custom endpoint model capability refresh)
  private pendingRuntimeConfigUpdates: Map<string, {
    resolve: (updated: boolean) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Metadata captured before PreToolUse stripping, keyed by toolCallId.
  // This provides a deterministic bridge when side-channel metadata store misses.
  private preToolMetadataByCallId: Map<string, {
    intent?: string;
    displayName?: string;
    capturedAt: number;
  }> = new Map();

  // Current user message (for context in summarization)
  private currentUserMessage: string = '';

  // Pool reference for convenience (from this.config.mcpPool)
  private get mcpPool(): McpClientPool | undefined { return this.config.mcpPool; }

  // Cached session tool context (lazy-created on first session tool call)
  private _sessionToolContext: SessionToolContext | null = null;

  // RPC request counter for unique IDs
  private rpcIdCounter: number = 0;

  // OAuth token refresh (ChatGPT Plus)
  /**
   * @deprecated Use onBackendAuthRequired (inherited from BaseAgent) instead.
   * Kept as a getter/setter alias for backward compatibility.
   */
  get onChatGptAuthRequired(): ((reason: string) => void) | null {
    return this.onBackendAuthRequired;
  }
  set onChatGptAuthRequired(cb: ((reason: string) => void) | null) {
    this.onBackendAuthRequired = cb;
  }
  private tokenRefreshInProgress: Promise<TokenRefreshOutcome> | null = null;

  // Global mutex: keyed by connectionSlug so multiple PiAgent instances
  // sharing the same connection don't race concurrent token refreshes.
  private static globalRefreshMutex: Map<string, Promise<TokenRefreshOutcome>> = new Map();

  // ============================================================
  // Constructor
  // ============================================================

  constructor(config: BackendConfig) {
    const resolvedModel = config.model || '';
    const modelDef = getModelById(resolvedModel);
    super(config, resolvedModel, modelDef?.contextWindow);

    this._supportsBranching = true;

    this.piSessionId = config.session?.sdkSessionId || null;
    this.adapter = new PiEventAdapter();
    if (modelDef?.contextWindow) {
      this.adapter.setContextWindow(modelDef.contextWindow);
    }
    this.adapter.setCallLlmModel(this.getModel());

    // Set session dir on adapter for concurrent-safe toolMetadataStore lookups
    if (config.session?.id && config.workspace.rootPath) {
      this.adapter.setSessionDir(join(config.workspace.rootPath, 'sessions', config.session.id));
    }

    // Wire the adapter's async overflow fallback into the event queue. The
    // fallback fires when the SDK doesn't emit a compaction_start after a
    // held overflow agent_end (e.g. _overflowRecoveryAttempted was already
    // true). It runs outside adaptEvent() so it can't yield through the
    // generator — instead, it calls these callbacks to enqueue the buffered
    // error and terminate the iterator.
    this.adapter.setOverflowFallbackHandlers(
      (event) => this.eventQueue.enqueue(event),
      () => this.eventQueue.complete(),
      () => this.requestOverflowRecovery(),
    );

    if (!config.isHeadless) {
      this.startConfigWatcher();
    }
  }

  /**
   * Guardrail: ensure every backend-mode session tool from core is implemented here.
   * This fails fast in development/CI instead of surfacing as runtime "Unknown session tool".
   */
  private assertBackendSessionToolParity(): void {
    const missing = [...SESSION_BACKEND_TOOL_NAMES].filter(
      (name) => !PI_BACKEND_SESSION_TOOL_NAMES.has(name),
    );

    if (missing.length > 0) {
      throw new Error(
        `PiAgent missing backend session tool implementations: ${missing.join(', ')}`,
      );
    }
  }

  // ============================================================
  // Subprocess Management
  // ============================================================

  /**
   * Ensure the subprocess is spawned and ready.
   * Lazy initialization -- spawns on first use.
   */
  private async ensureSubprocess(): Promise<void> {
    if (this.subprocess && this.subprocessReady) {
      await this.subprocessReady;
      return;
    }

    if (this.subprocessSpawnInFlight) {
      await this.subprocessSpawnInFlight;
      return;
    }

    const spawnAttempt = this.spawnSubprocess();
    this.subprocessSpawnInFlight = spawnAttempt;
    try {
      await spawnAttempt;
    } finally {
      if (this.subprocessSpawnInFlight === spawnAttempt) {
        this.subprocessSpawnInFlight = null;
      }
    }
  }

  /**
   * Spawn the pi-agent-server subprocess and set up JSONL communication.
   */
  private async spawnSubprocess(): Promise<void> {
    // Diagnostics belong to one subprocess generation. Do not attribute a
    // previous runtime's stderr tail to a later failure after recreation.
    this.stderrBuffer = [];
    this.stderrBufferBytes = 0;

    const runtime = getBackendRuntime(this.config);
    const piServerPath = runtime.paths?.piServer;
    if (!piServerPath) {
      throw new Error('piServerPath not configured. Cannot spawn Pi subprocess.');
    }

    const nodePath = runtime.paths?.node || process.execPath;
    const cwd = this.resolvedCwd();
    // Node reports spawn(command) ENOENT for an invalid cwd, even when the
    // protected runtime executable exists. Surface the directory issue first.
    await assertExistingWorkingDirectory(cwd);

    this.debug(`Spawning Pi subprocess: ${nodePath} ${piServerPath}`);
    this.resetSubprocessErrorDedup();

    // Build session ID and session dir path upfront (used for spawn env + init command)
    const sessionId = this.config.session?.id || `agent-${Date.now()}`;
    const subprocessRuntimeContext: PiSubprocessRuntimeContext = {
      runtimeId: `pi-${randomUUID()}`,
      sessionId,
    };
    const sessionDir = this.config.session
      ? join(this.config.workspace.rootPath, 'sessions', sessionId)
      : undefined;

    // Build spawn args — optionally preload the network interceptor
    // for tool metadata injection/capture across all API formats.
    const args = [piServerPath];
    const interceptorPath = runtime.paths?.interceptor;
    if (interceptorPath) {
      args.unshift('--require', interceptorPath);
    }

    // Resolve credentials before spawning so we can derive AWS env vars
    // from the same fetch that produces piAuth (single source of truth).

    // For OAuth providers with short-lived access tokens: preemptively refresh
    // before fetching credentials, so getPiAuth() picks up a fresh token. Also
    // join a refresh started by the auth-failed runtime being replaced.
    // refreshAndPushTokens guards this.subprocess internally — safe to call pre-spawn.
    if (this.config.authType === 'oauth' && runtime.piAuthProvider) {
      const slug = this.config.connectionSlug || 'pi';
      const expectedBindingId = this.config.expectedLlmCredentialBindingId;
      const stored = await getCredentialManager().getLlmOAuth(slug, expectedBindingId);
      if (shouldRefreshPiOAuthBeforeSpawn({
        authType: this.config.authType,
        piAuthProvider: runtime.piAuthProvider,
        refreshToken: stored?.refreshToken,
        expiresAt: stored?.expiresAt,
        refreshInFlight: PiAgent.globalRefreshMutex.has(
          `${slug}\u0000${expectedBindingId ?? 'unsealed'}`,
        ),
      })) {
        this.debug(`${runtime.piAuthProvider} token expired or expiring soon — refreshing before session start`);
        await this.refreshAndPushTokens();
      }
    }

    // Retrieve auth credentials for the subprocess.
    // Custom endpoint mode must NOT fall back to global API keys — keyless local endpoints
    // are valid, and non-local endpoints should fail explicitly instead of using unrelated creds.
    const piAuth = await this.getPiAuth();
    const isCustomEndpointMode = !!runtime.customEndpoint;
    const legacyApiKey = (!piAuth && !isCustomEndpointMode) ? await this.getApiKey() : undefined;
    if (isCustomEndpointMode && !piAuth) {
      this.debug('Custom endpoint mode: no provider credential configured, sending empty API key');
    }

    // Derive AWS env vars from the piAuth credential (single fetch, no race).
    const awsEnv = this.buildAwsEnv(piAuth, runtime);
    const providerEnv = this.buildProviderEnv(runtime);

    // Set up the handshake only after all pre-spawn async work succeeded. This
    // avoids leaving an unreachable pending promise when credential resolution
    // fails before a child process exists.
    this.subprocessReady = new Promise<void>((resolve, reject) => {
      this.subprocessReadyResolve = resolve;
      this.subprocessReadyReject = reject;
    });

    // Spawn the subprocess
    let child: ChildProcess;
    try {
      const protectedCommand = protectApplicationCommand(nodePath, args);
      child = spawn(protectedCommand.command, protectedCommand.args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildPiSubprocessEnvironment({
          proxyEnv: getProxyEnvVars(),
          envOverrides: this.config.envOverrides,
          providerEnv,
          awsEnv,
          // Pass session dir for cross-process toolMetadataStore.
          sessionDir,
          // Propagate debug mode without inheriting the rest of process.env.
          debugEnabled: process.argv.includes('--debug') || process.env.CRAFT_DEBUG === '1',
        }),
      });
    } catch (error) {
      // No consumer can be awaiting the private ready promise yet; discard it
      // and let spawnSubprocess's own rejection reach every deduplicated caller.
      this.subprocessReady = null;
      this.subprocessReadyResolve = null;
      this.subprocessReadyReject = null;
      throw error;
    }

    this.subprocess = child;
    this.subprocessRuntimeContext = subprocessRuntimeContext;
    this.subprocessRuntimeContexts.set(child, subprocessRuntimeContext);
    const configuredIdleMs = Number(process.env.CRAFT_AGENT_PROCESS_IDLE_TIMEOUT_MS);
    this.subprocessSupervisorHandle = registerLongRunningProcess(child, {
      id: `pi-agent:${sessionId}:${child.pid ?? Date.now()}`,
      kind: 'agent-runtime',
      ownerId: sessionId,
      maxIdleMs: Number.isFinite(configuredIdleMs) && configuredIdleMs > 0
        ? configuredIdleMs
        : 30 * 60 * 1000,
      isBusy: () => this.hasPendingSubprocessWork(),
      metadata: {
        ...(this.config.providerType ? { provider: this.config.providerType } : {}),
        workspaceId: this.config.workspace.id,
      },
    });

    // Set up readline for JSONL parsing from stdout
    this.readline = createInterface({
      input: child.stdout!,
      crlfDelay: Infinity,
    });

    this.readline.on('line', (line: string) => {
      this.handleLine(line, child, subprocessRuntimeContext);
    });

    // Always capture stderr into a bounded ring buffer so callers (e.g. the
    // connection-test timeout path in factory.ts) can surface it on failure.
    // Keep the CRAFT_DEBUG-gated log for interactive dev work. Production
    // diagnostics are emitted once, on unexpected exit, from the bounded tail.
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.recordStderr(text);
      const trimmed = text.trim();
      const debugEnabled = process.argv.includes('--debug') || process.env.CRAFT_DEBUG === '1';
      if (trimmed && debugEnabled) {
        const safeTail = redactRuntimeDiagnosticText(trimmed).slice(-RUNTIME_DIAGNOSTIC_MAX_CHARS);
        this.debug(`[subprocess stderr] ${safeTail}`);
      }
    });

    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      this.debug(`Pi subprocess stdin closed while sending command: ${error.code || error.message}`);
    });

    // `error` does not prove process termination and Node may emit `close`
    // without `exit` after a spawn failure. Converge both terminal signals
    // exactly once while preserving the diagnostic captured below.
    let terminationHandled = false;
    const handleConfirmedTermination = (code: number | null, signal: NodeJS.Signals | null) => {
      if (terminationHandled) return;
      terminationHandled = true;
      this.handleSubprocessExit(code, signal, child, undefined, subprocessRuntimeContext);
    };
    child.on('exit', handleConfirmedTermination);
    child.on('close', handleConfirmedTermination);

    child.on('error', (error) => {
      this.handleSubprocessError(error, child, subprocessRuntimeContext);
    });

    const startupTimeoutMs = resolvePiSubprocessStartupTimeoutMs(
      process.env.CRAFT_AGENT_PROCESS_STARTUP_TIMEOUT_MS,
    );
    this.subprocessReadyTimer = setTimeout(() => {
      if (this.subprocess !== child || !this.subprocessReadyReject) return;
      const error = new PiRuntimeInterruptedError(
        `Pi subprocess did not become ready within ${startupTimeoutMs} ms`,
        'startup_timeout',
      );
      this.debug(error.message);
      this.rejectSubprocessReady(error);
      this.expectedSubprocessExits.add(child);
      if (this.subprocessSupervisorHandle) {
        this.subprocessSupervisorHandle.terminate('Pi agent startup timeout');
      } else {
        child.kill('SIGTERM');
      }
      this.scheduleSubprocessForceKill(child, subprocessRuntimeContext);
    }, startupTimeoutMs);
    this.subprocessReadyTimer.unref?.();

    const sessionPath = this.config.session
      ? getSessionPath(this.config.workspace.rootPath, sessionId)
      : '';
    const plansFolderPath = getSessionPlansPath(this.config.workspace.rootPath, sessionId);
    const workingDirectory = this.config.session?.workingDirectory || cwd;

    // Send init command (flat structure matching subprocess InboundMessage type)
    this.send({
      type: 'init',
      apiKey: legacyApiKey || '',
      model: this._model,
      modelRoutePinned: this.modelRoutePinned(),
      cwd,
      thinkingLevel: this._thinkingLevel,
      workspaceRootPath: this.config.workspace.rootPath,
      sessionId,
      // Provider session IDs are persisted conversation metadata, never auth
      // credentials. ACP-backed providers such as Mistral Vibe use this only
      // when they advertise official session restoration support.
      sdkSessionId: this.piSessionId,
      sessionPath,
      workingDirectory,
      plansFolderPath,
      miniModel: this.config.miniModel,
      providerType: this.config.providerType,
      authType: this.config.authType,
      workspaceId: this.config.workspace.id,
      piAuth,
      baseUrl: runtime.baseUrl,
      customEndpoint: runtime.customEndpoint,
      customModels: runtime.customModels,
      // Branch params for Pi SDK session fork
      branchFromSdkSessionId: this.config.session?.branchFromSdkSessionId,
      branchFromSessionPath: this.config.session?.branchFromSessionPath,
      branchFromSdkTurnId: this.config.session?.branchFromSdkTurnId,
    });

    // Wait for subprocess to report ready
    await this.subprocessReady;
    this.debug('Pi subprocess is ready');

    // Ensure auto-compaction is explicitly enabled for embedded sessions.
    // PI defaults this to enabled, but we set it proactively for clarity and resilience.
    try {
      const enabled = await this.requestSetAutoCompaction(true);
      this.debug(`PI auto-compaction enabled: ${enabled}`);
    } catch (error) {
      this.debug(`Failed to configure PI auto-compaction (continuing): ${error instanceof Error ? error.message : String(error)}`);
    }

    // Register session-scoped tools as proxy tools in the subprocess.
    // These tools (SubmitPlan, config_validate, source auth, call_llm, etc.)
    // are executed in the main process when the LLM calls them.
    this.assertBackendSessionToolParity();
    let sessionToolDefs = getSessionToolProxyDefs();

    // Mirror Claude's gate: hide `browser_tool` when the user has disabled
    // the built-in browser tool. Without this filter, Pi would still advertise
    // `mcp__session__browser_tool` while Claude doesn't — sessions would behave
    // inconsistently depending on backend.
    if (!getBrowserToolEnabled()) {
      sessionToolDefs = sessionToolDefs.filter(d => d.name !== 'mcp__session__browser_tool');
    }

    this.send({
      type: 'register_tools',
      tools: sessionToolDefs,
    });
    this.debug(`Registered ${sessionToolDefs.length} session tools with subprocess`);

    // If pool has source tools, register them with the subprocess.
    this.registerPoolToolsWithSubprocess();
  }

  /**
   * Send pool's proxy tool defs to subprocess for model visibility.
   */
  private registerPoolToolsWithSubprocess(): void {
    if (!this.mcpPool) return;
    const proxyDefs = this.mcpPool.getProxyToolDefs();
    if (proxyDefs.length > 0) {
      this.send({
        type: 'register_tools',
        tools: proxyDefs,
      });
      this.debug(`Registered ${proxyDefs.length} MCP source tools from pool with subprocess`);
    }
  }

  /**
   * Build structured Pi auth from connection config.
   * Returns a provider-aware credential object for the subprocess,
   * or null if no piAuthProvider is configured (falls back to legacy getApiKey).
   *
   * OAuth tokens from Craft (Claude Max, ChatGPT Plus, Copilot) are passed as
   * api_key type because they function as bearer tokens that the Pi SDK's provider
   * modules use directly. The OAuth exchange happens on the Craft side; by the time
   * it reaches Pi, it's just an access token.
   */
  private async getPiAuth(): Promise<PiAuthPayload | null> {
    const piAuthProvider = getBackendRuntime(this.config).piAuthProvider;
    if (!piAuthProvider) return null;

    try {
      const credentialManager = getCredentialManager();
      const slug = this.config.connectionSlug || 'pi';

      if (this.config.authType === 'oauth') {
        const oauth = await credentialManager.getLlmOAuth(
          slug,
          this.config.expectedLlmCredentialBindingId,
        );
        if (oauth?.accessToken) {
          // Copilot and OpenAI Codex: pass full OAuth credential so the Pi SDK can derive the
          // correct API endpoint and perform native token refresh.
          if ((piAuthProvider === 'github-copilot' || piAuthProvider === 'openai-codex') && oauth.refreshToken) {
            this.debug(`Retrieved ${piAuthProvider} OAuth credential for Pi provider`);
            return {
              provider: piAuthProvider,
              credential: {
                type: 'oauth',
                access: oauth.accessToken,
                refresh: oauth.refreshToken,
                expires: oauth.expiresAt ?? 0,
              },
            };
          }
          // Other OAuth providers: pass as api_key (bearer token)
          this.debug(`Retrieved OAuth access token for Pi provider: ${piAuthProvider}`);
          return {
            provider: piAuthProvider,
            credential: { type: 'api_key', key: oauth.accessToken },
          };
        }
      } else if (this.config.authType === 'iam_credentials') {
        // AWS IAM credentials — pass structured fields so the subprocess can
        // identify the credential type. Actual AWS env var injection happens
        // at spawn time (see spawnSubprocess) for proper process isolation.
        const iam = await credentialManager.getLlmIamCredentials(
          slug,
          this.config.expectedLlmCredentialBindingId,
        );
        if (iam) {
          this.debug(`Retrieved IAM credentials for Pi provider: ${piAuthProvider}`);
          return {
            provider: piAuthProvider,
            credential: {
              type: 'iam',
              accessKeyId: iam.accessKeyId,
              secretAccessKey: iam.secretAccessKey,
              region: iam.region,
              sessionToken: iam.sessionToken,
            },
          };
        }
      } else {
        // API key-based connections.
        // NOTE: authType === 'environment' (e.g. Bedrock with ~/.aws/credentials)
        // intentionally falls through here, finds no API key, and returns null.
        // buildAwsEnv() grants the AWS credential chain only to the selected
        // Bedrock subprocess; it is not part of generic process.env inheritance.
        const apiKey = await credentialManager.getLlmApiKey(
          slug,
          this.config.expectedLlmCredentialBindingId,
        );
        if (apiKey) {
          this.debug(`Retrieved API key credential for Pi provider: ${piAuthProvider}`);
          return {
            provider: piAuthProvider,
            credential: { type: 'api_key', key: apiKey },
          };
        }
      }

      this.debug(`No credentials found for Pi provider: ${piAuthProvider}`);
      return null;
    } catch (error) {
      this.debug(`Failed to retrieve Pi auth: ${error}`);
      return null;
    }
  }

  /**
   * Build AWS environment variables from piAuth credentials for the subprocess.
   *
   * The Pi SDK's Bedrock provider reads from the AWS default credential chain
   * (env vars), not from Pi AuthStorage. We inject at spawn time so credentials
   * are scoped to the subprocess and don't leak to the main process.
   *
   * NOTE: IAM credentials (especially STS session tokens) are immutable after
   * spawn — they cannot be refreshed in a running subprocess. Long sessions
   * with temporary credentials (~1h STS tokens) will fail on expiry.
   */
  private buildAwsEnv(
    piAuth: Awaited<ReturnType<PiAgent['getPiAuth']>>,
    runtime: { piAuthProvider?: string },
  ): Record<string, string> {
    if (runtime.piAuthProvider !== 'amazon-bedrock') return {};

    // Environment auth is an explicit user choice for this one Bedrock
    // connection. Preserve the AWS default credential chain without exposing
    // cloud credentials to any other Pi provider.
    const env: Record<string, string> = this.config.authType === 'environment'
      ? pickExplicitEnvironment(BEDROCK_ENVIRONMENT_AUTH_KEYS)
      : {};

    if (piAuth?.credential.type === 'iam') {
      env.AWS_ACCESS_KEY_ID = piAuth.credential.accessKeyId;
      env.AWS_SECRET_ACCESS_KEY = piAuth.credential.secretAccessKey;
      if (piAuth.credential.region) env.AWS_REGION = piAuth.credential.region;
      if (piAuth.credential.sessionToken) env.AWS_SESSION_TOKEN = piAuth.credential.sessionToken;
      this.debug('Injecting IAM credentials into subprocess env for AWS SDK');
    }

    // Defensive: force HTTP/1.1 for Bedrock. AWS SDK v3 defaults to HTTP/2
    // (NodeHttp2Handler) which can be incompatible with Bun/Electron runtimes.
    env.AWS_BEDROCK_FORCE_HTTP1 = process.env.AWS_BEDROCK_FORCE_HTTP1
      || env.AWS_BEDROCK_FORCE_HTTP1
      || '1';

    return env;
  }

  /**
   * Preserve non-secret provider bootstrap values only for the provider that
   * consumes them. They are deliberately not part of the generic host env.
   */
  private buildProviderEnv(runtime: { piAuthProvider?: string; googleCloudProject?: string }): Record<string, string> {
    return buildPiProviderEnvironment(runtime.piAuthProvider, process.env, runtime.googleCloudProject);
  }

  /**
   * Refresh OAuth tokens and push updated credentials to the running subprocess.
   * Handles both Copilot (Pi SDK) and ChatGPT Plus token refresh.
   */
  private async refreshAndPushTokens(): Promise<void> {
    if (this.config.authType !== 'oauth') return;

    const slug = this.config.connectionSlug || 'pi';
    const expectedBindingId = this.config.expectedLlmCredentialBindingId;
    const refreshKey = `${slug}\u0000${expectedBindingId ?? 'unsealed'}`;

    // Global mutex — if another PiAgent instance on the same connection slug
    // is already refreshing, just wait for that to finish and push the
    // (now-fresh) credentials to our subprocess.
    const existing = PiAgent.globalRefreshMutex.get(refreshKey);
    if (existing) {
      this.debug(`Waiting on existing refresh for slug "${slug}"`);
      const outcome = await existing;
      // Reuse the credential returned by the successful owner. Re-reading the
      // store after a failed refresh could return and push the expired token.
      if (outcome.refreshed
        && outcome.bindingId === expectedBindingId
        && this.subprocess) {
        this.send({ type: 'token_update', piAuth: outcome.piAuth });
        this.debug('Pushed credentials refreshed by sibling instance');
      }
      return;
    }

    const refreshPromise: Promise<TokenRefreshOutcome> = (async () => {
      const piAuthProvider = getBackendRuntime(this.config).piAuthProvider;
      const credentialManager = getCredentialManager();
      const stored = await credentialManager.getLlmOAuth(slug, expectedBindingId);

      if (!stored?.refreshToken) {
        this.debug('No refresh token available — re-auth required');
        this.onBackendAuthRequired?.('No refresh token — please sign in again');
        return { refreshed: false };
      }

      try {
        if (piAuthProvider === 'github-copilot') {
          // Copilot: refresh the short-lived Copilot token using the GitHub access token
          const { refreshGitHubCopilotToken } = await import('@earendil-works/pi-ai/oauth');
          const newCreds = await refreshGitHubCopilotToken(stored.refreshToken);
          await credentialManager.refreshLlmOAuth(slug, {
            accessToken: newCreds.access,
            refreshToken: newCreds.refresh,
            expiresAt: newCreds.expires,
          }, expectedBindingId);
        } else if (piAuthProvider === 'google-gemini-code-assist') {
          const { refreshGoogleGeminiTokens } = await import('@craft-agent/shared/auth');
          const newTokens = await refreshGoogleGeminiTokens(stored.refreshToken);
          await credentialManager.refreshLlmOAuth(slug, {
            accessToken: newTokens.accessToken,
            idToken: newTokens.idToken,
            refreshToken: newTokens.refreshToken ?? stored.refreshToken,
            expiresAt: newTokens.expiresAt,
          }, expectedBindingId);
        } else {
          // ChatGPT Plus: use existing refresh utility
          const newTokens = await refreshChatGptTokens(stored.refreshToken);
          await credentialManager.refreshLlmOAuth(slug, {
            accessToken: newTokens.accessToken,
            idToken: newTokens.idToken,
            refreshToken: newTokens.refreshToken,
            expiresAt: newTokens.expiresAt,
          }, expectedBindingId);
        }
        this.debug('Token refresh successful');

        // Read only after the credential write completed. The resulting
        // payload is also handed to sibling waiters so none re-read stale data.
        const piAuth = await this.getPiAuth();
        if (!piAuth) {
          this.debug('Token refresh completed but no fresh credential was available');
          this.onBackendAuthRequired?.('Token refresh completed without a usable credential — please sign in again');
          return { refreshed: false };
        }

        if (this.subprocess) {
          this.send({ type: 'token_update', piAuth });
          this.debug('Pushed refreshed credentials to subprocess');
        }
        return { refreshed: true, piAuth, bindingId: expectedBindingId };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.debug(`Token refresh failed: ${msg}`);
        this.onBackendAuthRequired?.(`Token refresh failed: ${msg}`);
        return { refreshed: false };
      }
    })();

    // Store in both instance and global mutex
    this.tokenRefreshInProgress = refreshPromise;
    PiAgent.globalRefreshMutex.set(refreshKey, refreshPromise);

    try {
      await refreshPromise;
    } finally {
      this.tokenRefreshInProgress = null;
      // Only clear global if it's still our promise (no newer refresh started)
      if (PiAgent.globalRefreshMutex.get(refreshKey) === refreshPromise) {
        PiAgent.globalRefreshMutex.delete(refreshKey);
      }
    }
  }

  /**
   * Retrieve API key from the credential manager for subprocess injection.
   * Legacy fallback when piAuthProvider is not set.
   * The subprocess expects a single API key string (passed via init.apiKey).
   */
  private async getApiKey(): Promise<string | null> {
    try {
      const credentialManager = getCredentialManager();
      const slug = this.config.connectionSlug || 'pi';

      // Try LLM OAuth first (for OAuth-based connections)
      const oauth = await credentialManager.getLlmOAuth(
        slug,
        this.config.expectedLlmCredentialBindingId,
      );
      if (oauth?.accessToken) {
        this.debug('Retrieved API key from LLM OAuth');
        return oauth.accessToken;
      }

      // Try Anthropic API key
      const apiKey = this.config.expectedLlmCredentialBindingId
        ? await credentialManager.getLlmApiKey(slug, this.config.expectedLlmCredentialBindingId)
        : await credentialManager.getApiKey();
      if (apiKey) {
        this.debug('Retrieved Anthropic API key');
        return apiKey;
      }

      this.debug('No API keys found for Pi agent');
      return null;
    } catch (error) {
      this.debug(`Failed to retrieve API key: ${error}`);
      return null;
    }
  }

  /**
   * Send a JSONL command to the subprocess stdin.
   */
  private send(cmd: Record<string, unknown>): boolean {
    if (!this.subprocess?.stdin?.writable) {
      this.debug('Cannot send to subprocess: stdin not writable');
      return false;
    }
    const line = JSON.stringify(cmd);
    this.subprocessSupervisorHandle?.touch();
    try {
      this.subprocess.stdin.write(line + '\n');
      return true;
    } catch (error) {
      this.debug(`Cannot send to subprocess: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** Never deliver an older generation's delayed response to a replacement subprocess. */
  private sendForRuntime(
    cmd: Record<string, unknown>,
    runtimeContext?: PiSubprocessRuntimeContext,
  ): boolean {
    if (runtimeContext
      && this.subprocessRuntimeContext?.runtimeId !== runtimeContext.runtimeId) {
      this.debug(`Dropping delayed Pi response for stale runtime ${runtimeContext.runtimeId}`);
      return false;
    }
    this.send(cmd);
    return true;
  }

  private isRuntimeCurrent(runtimeContext?: PiSubprocessRuntimeContext): boolean {
    return !runtimeContext
      || this.subprocessRuntimeContext?.runtimeId === runtimeContext.runtimeId;
  }

  /**
   * Parse a JSONL line from subprocess stdout and dispatch by type.
   */
  private handleLine(
    line: string,
    child?: ChildProcess,
    runtimeContext?: PiSubprocessRuntimeContext,
  ): void {
    if (!line.trim()) return;
    if (child && (this.subprocess !== child || !this.isRuntimeCurrent(runtimeContext))) {
      this.debug('Ignoring output from stale Pi subprocess generation');
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.debug(`Invalid JSONL from subprocess: ${line.slice(0, 200)}`);
      return;
    }

    const type = msg.type as string;

    if (type !== 'error') {
      this.resetSubprocessErrorDedup();
    }

    switch (type) {
      case 'ready':
        // Subprocess initialized, callback server listening
        this.callbackPort = (msg.callbackPort as number) || 0;
        if (msg.sessionId) {
          this.piSessionId = msg.sessionId as string;
          this.config.onSdkSessionIdUpdate?.(this.piSessionId!);
        }
        this.resolveSubprocessReady();
        break;

      case 'provider_handoff': {
        const id = typeof msg.id === 'string' ? msg.id : undefined;
        const acknowledge = id ? this.pendingProviderHandoffs.get(id) : undefined;
        if (id && acknowledge) {
          this.pendingProviderHandoffs.delete(id);
          this.pendingProviderDispatchRejections.delete(id);
          acknowledge();
        } else {
          this.debug(`Ignoring unmatched provider handoff acknowledgement: ${id ?? 'missing id'}`);
        }
        break;
      }

      case 'event':
        // Pi SDK event -- forward through PiEventAdapter
        this.handleSubprocessEvent(msg.event as Record<string, unknown>);
        break;

      case 'pre_tool_use_request':
        // Subprocess needs permission check + transforms before tool execution
        void this.handlePreToolUseRequest(msg as {
          requestId: string;
          toolName: string;
          toolCallId?: string;
          input: Record<string, unknown>;
        }, runtimeContext ?? this.subprocessRuntimeContext ?? undefined);
        break;

      case 'tool_execute_request':
        // Subprocess wants main process to execute a proxy tool (MCP/API/session)
        void this.handleToolExecuteRequest(msg as {
          requestId: string;
          toolName: string;
          toolCallId?: string;
          args: Record<string, unknown>;
        }, runtimeContext ?? this.subprocessRuntimeContext ?? undefined);
        break;

      case 'session_tool_completed':
        // Session MCP tool completed -- fire callbacks (SubmitPlan, auth, etc.)
        this.handleSessionToolCompleted(msg);
        break;

      case 'mini_completion_result':
        // Response to a mini_completion request
        this.handleMiniCompletionResult(msg);
        break;

      case 'llm_query_result': {
        // Response to an llm_query request
        const id = msg.id as string;
        const pending = this.pendingLlmQueries.get(id);
        if (pending) {
          this.pendingLlmQueries.delete(id);
          const result = msg.result as LLMQueryResult | null;
          if (result) {
            pending.resolve(result);
          } else {
            const errorMessage = typeof msg.errorMessage === 'string' ? msg.errorMessage : 'llm_query failed';
            pending.reject(new Error(errorMessage));
          }
        }
        break;
      }

      case 'ensure_session_ready_result':
        // Response to an ensure_session_ready request
        this.handleEnsureSessionReadyResult(msg);
        break;

      case 'compact_result':
        // Response to a compact request
        this.handleCompactResult(msg);
        break;

      case 'set_auto_compaction_result':
        // Response to an auto-compaction toggle request
        this.handleSetAutoCompactionResult(msg);
        break;

      case 'update_runtime_config_result':
        // Response to a runtime config refresh request
        this.handleRuntimeConfigUpdateResult(msg);
        break;

      case 'session_id_update':
        // Pi session ID changed
        if (msg.sessionId) {
          this.piSessionId = msg.sessionId as string;
          this.config.onSdkSessionIdUpdate?.(this.piSessionId!);
        }
        break;

      case 'error': {
        const errorCode = typeof msg.code === 'string' ? msg.code : undefined;
        const rawMessage = String(msg.message || 'Unknown subprocess error');

        if (errorCode === 'prompt_error' && typeof msg.id === 'string') {
          this.pendingProviderHandoffs.delete(msg.id);
          const reject = this.pendingProviderDispatchRejections.get(msg.id);
          this.pendingProviderDispatchRejections.delete(msg.id);
          reject?.();
        }

        this.debug(`Subprocess error${errorCode ? ` (${errorCode})` : ''}: ${rawMessage}`);
        const errorMsg = rawMessage.toLowerCase();

        // Detect auth errors and attempt token refresh for OAuth connections
        if (this.config.authType === 'oauth' && (
          errorMsg.includes('401') ||
          errorMsg.includes('421') ||
          errorMsg.includes('unauthorized') ||
          errorMsg.includes('misdirected') ||
          (errorMsg.includes('token') && errorMsg.includes('expired')) ||
          errorMsg.includes('authentication')
        )) {
          this.debug('Auth error detected from subprocess, attempting token refresh');
          this.refreshAndPushTokens().catch(err => {
            this.debug(`Token refresh after auth error failed: ${err}`);
          });
        }

        // Reject any pending mini completions so errors propagate immediately.
        // mini_completion_error is an internal utility-path failure (title/summarization)
        // and should not surface as a user-visible chat error.
        for (const [id, pending] of this.pendingMiniCompletions) {
          pending.reject(new Error(rawMessage));
          this.pendingMiniCompletions.delete(id);
        }

        // Same treatment for pending llm_query calls. llm_query_error is also an
        // internal utility-path code (call_llm): the dual-emit from the subprocess
        // means a targeted `llm_query_result` is sent alongside this generic `error`
        // to reject the specific pending promise — this loop is the defensive cleanup
        // for queries that never got a targeted result (subprocess crash, etc.).
        for (const [id, pending] of this.pendingLlmQueries) {
          pending.reject(new Error(rawMessage));
          this.pendingLlmQueries.delete(id);
        }

        if (errorCode === 'mini_completion_error' || errorCode === 'llm_query_error') {
          this.debug(`Ignoring ${errorCode} subprocess error in chat stream`);
          break;
        }

        // Reject pending ensure_session_ready requests (used by branch preflight)
        for (const [id, pending] of this.pendingEnsureSessionReady) {
          pending.reject(new Error(rawMessage));
          this.pendingEnsureSessionReady.delete(id);
        }

        // Reject pending compact/toggle requests
        for (const [id, pending] of this.pendingCompactions) {
          pending.reject(new Error(rawMessage));
          this.pendingCompactions.delete(id);
        }
        for (const [id, pending] of this.pendingAutoCompactionToggles) {
          pending.reject(new Error(rawMessage));
          this.pendingAutoCompactionToggles.delete(id);
        }
        for (const [id, pending] of this.pendingRuntimeConfigUpdates) {
          pending.reject(new Error(rawMessage));
          this.pendingRuntimeConfigUpdates.delete(id);
        }

        // Suppress repeated identical errors to prevent a broken subprocess
        // from flooding the user's session (e.g. EFAULT loop).
        if (rawMessage === this.lastSubprocessError) {
          this.subprocessErrorRepeatCount++;
          if (this.subprocessErrorRepeatCount > PiAgent.MAX_IDENTICAL_SUBPROCESS_ERRORS) {
            this.debug(`Suppressing repeated subprocess error (${this.subprocessErrorRepeatCount}x): ${rawMessage}`);
            break;
          }
        } else {
          this.lastSubprocessError = rawMessage;
          this.subprocessErrorRepeatCount = 1;
        }

        const parsed = parseError(new Error(rawMessage));
        if (parsed.code !== 'unknown_error') {
          this.eventQueue.enqueue({ type: 'typed_error', error: parsed });
        } else {
          this.eventQueue.enqueue({
            type: 'error',
            message: `Pi subprocess error: ${rawMessage}`,
          });
        }

        // Note: The subprocess should follow this with a synthetic agent_end event
        // which will call eventQueue.complete(). If it doesn't, handleSubprocessExit()
        // will complete the queue when the process exits.
        break;
      }

      default:
        this.debug(`Unknown subprocess message type: ${type}`);
    }
  }

  /**
   * Forward a Pi SDK event from the subprocess through the event adapter.
   */
  private handleSubprocessEvent(event: Record<string, unknown>): void {
    // The subprocess sends Pi SDK AgentSessionEvent objects serialized as JSON.
    // Feed them through PiEventAdapter to convert to Craft AgentEvents.

    // Detect session MCP tool completions (same pattern as in-process version)
    const eventType = event.type as string;
    let adaptedEvent = event;

    if (eventType === 'tool_execution_start') {
      const toolName = event.toolName as string;
      if (toolName?.startsWith('session__') || toolName?.startsWith('mcp__session__')) {
        // Session tool tracking is handled by the subprocess; it sends
        // session_tool_completed events when appropriate.
      }

      // Deterministic metadata bridge: if subprocess event lacks toolMetadata,
      // inject metadata captured from pre_tool_use_request before stripping.
      const toolCallId = event.toolCallId as string | undefined;
      const existingMeta = event.toolMetadata as { intent?: string; displayName?: string } | undefined;
      if (toolCallId && !existingMeta) {
        const cached = this.preToolMetadataByCallId.get(toolCallId);
        if (cached && (cached.intent || cached.displayName)) {
          adaptedEvent = {
            ...event,
            toolMetadata: {
              intent: cached.intent,
              displayName: cached.displayName,
              source: 'interceptor',
            },
          };
          this.debug(`Injected pre-tool metadata for ${toolName} (${toolCallId}) from bridge cache`);
        }
      }
    }

    if (eventType === 'tool_execution_end') {
      const toolCallId = event.toolCallId as string | undefined;
      if (toolCallId) {
        this.settleAdmittedToolExecution(toolCallId);
        this.preToolMetadataByCallId.delete(toolCallId);
      }
    }

    // Adapt event to CraftAgentEvents
    // The event adapter expects typed PiAgentEvent/AgentSessionEvent objects,
    // but since we're receiving plain JSON, we cast through unknown.
    for (const agentEvent of this.adapter.adaptEvent(adaptedEvent as any)) {
      if (
        agentEvent.type === 'typed_error' &&
        this.config.authType === 'oauth' &&
        (agentEvent.error.code === 'expired_oauth_token' || agentEvent.error.code === 'invalid_api_key')
      ) {
        // Provider message_end failures do not necessarily arrive through the
        // generic subprocess `error` envelope. Start refresh here as well so
        // SessionManager's replacement runtime can join the same global mutex.
        void this.refreshAndPushTokens().catch(error => {
          this.debug(`Token refresh from typed auth error failed: ${error}`);
        });
      }

      // Correlate the successful result with its acquisition input; start alone earns no credit.
      if (agentEvent.type === 'tool_start') {
        this.prerequisiteManager.trackToolStart(agentEvent.toolUseId, agentEvent.toolName, agentEvent.input);
      }
      if (agentEvent.type === 'tool_result') {
        this.prerequisiteManager.trackToolCompletion(agentEvent.toolUseId,
          agentEvent.result, agentEvent.isError, agentEvent.executed !== false);
        const currentRequest = this.getCurrentTurnUserMessage() ?? undefined;
        const currentAuthority = this.config.getObjectiveMutationAuthority?.(currentRequest);
        recordContextualGmailToolResult({
          sessionId: this.config.session?.id || this._sessionId,
          toolUseId: agentEvent.toolUseId,
          toolName: agentEvent.toolName,
          toolInput: agentEvent.input,
          result: agentEvent.result,
          isError: agentEvent.isError,
          executed: agentEvent.executed,
          objectiveAuthorizationSegments: typeof currentAuthority === 'object'
            ? currentAuthority.authorizationSegments
            : currentRequest ? [currentRequest] : [],
        });
      }
      // Reset prerequisite state on compaction (LLM loses guide content)
      if (agentEvent.type === 'info' && typeof agentEvent.message === 'string' && agentEvent.message.startsWith('Compacted')) {
        this.resetPrerequisiteState();
      }

      // Fire PostToolUse / PostToolUseFailure hook events (fire-and-forget)
      if (agentEvent.type === 'tool_result') {
        const hookEvent = agentEvent.isError ? 'PostToolUseFailure' : 'PostToolUse';
        this.emitAutomationEvent(hookEvent, {
          hook_event_name: hookEvent,
          tool_name: agentEvent.toolName ?? (event.toolName as string) ?? 'unknown',
          tool_input: agentEvent.input,
          ...(agentEvent.isError
            ? { error: typeof agentEvent.result === 'string' ? agentEvent.result : undefined }
            : { tool_response: typeof agentEvent.result === 'string' ? agentEvent.result : undefined }),
        });
      }

      this.eventQueue.enqueue(agentEvent);
    }

    // Turn-completion is now adapter-driven so overflow recovery can hold the
    // queue open across the SDK's compaction → agent.continue() sequence
    // (see PiEventAdapter overflow state machine). The adapter returns true
    // when the queue should terminate — either on a normal agent_end with no
    // recovery in flight, or on a compaction_end failure that drains a held
    // overflow.
    if (this.adapter.shouldCompleteQueue(eventType === 'agent_end')) {
      this.eventQueue.complete();
    }
  }

  /**
   * Handle a pre_tool_use_request from the subprocess.
   * Runs the centralized permission pipeline and sends the decision back.
   */
  private async handlePreToolUseRequest(req: {
    requestId: string;
    toolName: string;
    toolCallId?: string;
    input: Record<string, unknown>;
  }, runtimeContext?: PiSubprocessRuntimeContext): Promise<void> {
    const { requestId, toolName, toolCallId, input } = req;
    const authorizationEpoch = this.promptPreparationRevision;
    const debugSessionId = runtimeContext?.sessionId
      ?? this.config.session?.id
      ?? this._sessionId;
    const respond = (message: Record<string, unknown>) => {
      this.sendPreToolUseDecision({
        requestId,
        toolName,
        toolCallId,
        originalInput: input,
        runtimeContext,
        authorizationEpoch,
      }, message);
    };
    this.debug(`PreToolUse request from subprocess: ${toolName} (${requestId}, sessionId=${debugSessionId})`);

    // Capture metadata BEFORE centralized checks strip it out.
    // This bridge is deterministic and avoids relying solely on side-channel store lookups.
    const preIntent = typeof input._intent === 'string' ? input._intent : undefined;
    const preDisplayName = typeof input._displayName === 'string' ? input._displayName : undefined;
    if (toolCallId && (preIntent || preDisplayName)) {
      this.preToolMetadataByCallId.set(toolCallId, {
        intent: preIntent,
        displayName: preDisplayName,
        capturedAt: Date.now(),
      });
      this.debug(`Captured pre-tool metadata for ${toolName} (${toolCallId}, sessionId=${debugSessionId}): intent=${!!preIntent}, displayName=${!!preDisplayName}`);
    }

    // Fire PreToolUse automation event — await so automations run before tool executes
    await this.emitAutomationEvent('PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: input,
    });
    if (!this.isRuntimeCurrent(runtimeContext)) return;

    const rootPath = this.config.workspace.rootPath ?? this.workingDirectory;
    const workspaceSlug = extractWorkspaceSlug(rootPath, this.config.workspace.id);
    const sessionId = runtimeContext?.sessionId
      ?? this.config.session?.id
      ?? this._sessionId;
    const plansFolderPath = sessionId
      ? getSessionPlansPath(rootPath, sessionId)
      : undefined;
    const dataFolderPath = sessionId
      ? getSessionDataPath(rootPath, sessionId)
      : undefined;

    // Build RTK context fresh per call so toggling the preference takes
    // effect without restart. `getRtkPath()` is cached per process.
    const rtkContext: RtkContext | undefined = getRtkEnabled()
      ? { enabled: true, path: getRtkPath(), exclude: [] }
      : undefined;

    const currentUserRequest = this.getCurrentTurnUserMessage() ?? undefined;
    const objectiveAuthority = this.config.getObjectiveMutationAuthority?.(currentUserRequest);
    try {
      await getSessionScopedToolCallbacks(sessionId)?.validateMissionCapabilitiesFn?.(toolName, input);
    } catch (error) {
      respond({
        type: 'pre_tool_use_response',
        requestId,
        action: 'block',
        reason: `Specialized Mission capability lease rejected this tool: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    const checkResult = runPreToolUseChecks({
      toolName,
      input,
      sessionId,
      toolUseId: toolCallId,
      runtimeId: runtimeContext?.runtimeId,
      permissionMode: this.permissionManager.getPermissionMode(),
      workspaceRootPath: rootPath,
      workspaceId: workspaceSlug,
      plansFolderPath,
      dataFolderPath,
      workingDirectory: this.config.session?.workingDirectory,
      executionIsolation: this.config.session?.executionIsolation,
      missionCapabilityLock: this.config.missionCapabilityLock,
      activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
      allSourceSlugs: this.sourceManager.getAllSources().map(s => s.config.slug),
      hasSourceActivation: !!this.onSourceActivationRequest,
      permissionManager: this.permissionManager,
      prerequisiteManager: this.prerequisiteManager,
      preloadedSourceGuidePaths: this.sourceManager.getPreloadedSourceGuidePaths(),
      currentUserRequest,
      declaredToolCapabilities: this.mcpPool?.getProxyToolCapabilities(toolName),
      externalActionPolicy: this.config.externalActionPolicy,
      humanInputAllowed: this.config.getHumanInputAllowed?.(),
      objectiveMutationAuthorized: typeof objectiveAuthority === 'boolean'
        ? objectiveAuthority : objectiveAuthority?.authorized,
      objectiveSensitiveActionAuthorized: typeof objectiveAuthority === 'object'
        ? objectiveAuthority.sensitiveActionAuthorized : objectiveAuthority,
      objectiveAuthorizationSegments: typeof objectiveAuthority === 'object'
        ? objectiveAuthority.authorizationSegments : undefined,
      authenticatedUserAuthorizationSegments: typeof objectiveAuthority === 'object'
        ? objectiveAuthority.authenticatedUserAuthorizationSegments : undefined,
      objectiveTerminalReconciliationPolicy: typeof objectiveAuthority === 'object'
        ? objectiveAuthority.terminalReconciliationPolicy : undefined,
      rtkContext,
      onDebug: (msg) => this.debug(`PreToolUse(sessionId=${sessionId}): ${msg}`),
    });

    switch (checkResult.type) {
      case 'allow':
        respond({ type: 'pre_tool_use_response', requestId, action: 'allow' });
        return;

      case 'modify':
        respond({ type: 'pre_tool_use_response', requestId, action: 'modify', input: checkResult.input });
        return;

      case 'block': {
        const diagnostics = getPermissionModeDiagnostics(sessionId);
        this.debug(`__PERMISSION_BLOCK__${JSON.stringify({
          sessionId,
          toolName,
          effectiveMode: diagnostics.permissionMode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
          reason: checkResult.reason,
        })}`);
        respond({ type: 'pre_tool_use_response', requestId, action: 'block', reason: checkResult.reason });
        return;
      }

      case 'source_activation_needed': {
        const { sourceSlug, sourceExists } = checkResult;
        this.debug(`PreToolUse(sessionId=${sessionId}): Source "${sourceSlug}" not active, attempting activation...`);

        if (!this.onSourceActivationRequest) {
          respond({
            type: 'pre_tool_use_response',
            requestId,
            action: 'block',
            reason: `Source "${sourceSlug}" is not active and no host activation handler is available. The tool was not executed.`,
          });
          return;
        }

        if (this.onSourceActivationRequest) {
          try {
            const activated = await this.onSourceActivationRequest(sourceSlug);
            if (!this.isRuntimeCurrent(runtimeContext)) return;
            if (!activated) {
              const reason = sourceExists
                ? `Source "${sourceSlug}" is not active. Activate it by @mentioning it in your message or via the source icon at the bottom of the input field.`
                : `Source "${sourceSlug}" is not available yet. It needs to be created and configured first.`;
              respond({ type: 'pre_tool_use_response', requestId, action: 'block', reason });
              return;
            }
            this.debug(`PreToolUse(sessionId=${sessionId}): Source "${sourceSlug}" activated successfully`);
            this.eventQueue.enqueue({
              type: 'source_activated' as const,
              sourceSlug,
              originalMessage: this.getCurrentTurnUserMessage() ?? '',
            });
          } catch (err) {
            const reason = sourceExists
              ? `Source "${sourceSlug}" could not be activated: ${err}`
              : `Source "${sourceSlug}" is not available yet. It needs to be created and configured first.`;
            respond({ type: 'pre_tool_use_response', requestId, action: 'block', reason });
            return;
          }
        }

        // Re-run pipeline after activation
        const postCurrentUserRequest = this.getCurrentTurnUserMessage() ?? undefined;
        const postObjectiveAuthority = this.config.getObjectiveMutationAuthority?.(postCurrentUserRequest);
        const postResult = runPreToolUseChecks({
          toolName,
          input,
          sessionId,
          toolUseId: toolCallId,
          runtimeId: runtimeContext?.runtimeId,
          sourceActivationReentry: true,
          permissionMode: this.permissionManager.getPermissionMode(),
          workspaceRootPath: rootPath,
          workspaceId: workspaceSlug,
          plansFolderPath,
          dataFolderPath,
          workingDirectory: this.config.session?.workingDirectory,
          executionIsolation: this.config.session?.executionIsolation,
          missionCapabilityLock: this.config.missionCapabilityLock,
          activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
          allSourceSlugs: this.sourceManager.getAllSources().map(s => s.config.slug),
          hasSourceActivation: !!this.onSourceActivationRequest,
          permissionManager: this.permissionManager,
          prerequisiteManager: this.prerequisiteManager,
          preloadedSourceGuidePaths: this.sourceManager.getPreloadedSourceGuidePaths(),
          currentUserRequest: postCurrentUserRequest,
          declaredToolCapabilities: this.mcpPool?.getProxyToolCapabilities(toolName),
          externalActionPolicy: this.config.externalActionPolicy,
          humanInputAllowed: this.config.getHumanInputAllowed?.(),
          objectiveMutationAuthorized: typeof postObjectiveAuthority === 'boolean'
            ? postObjectiveAuthority : postObjectiveAuthority?.authorized,
          objectiveSensitiveActionAuthorized: typeof postObjectiveAuthority === 'object'
            ? postObjectiveAuthority.sensitiveActionAuthorized : postObjectiveAuthority,
          objectiveAuthorizationSegments: typeof postObjectiveAuthority === 'object'
            ? postObjectiveAuthority.authorizationSegments : undefined,
          authenticatedUserAuthorizationSegments: typeof postObjectiveAuthority === 'object'
            ? postObjectiveAuthority.authenticatedUserAuthorizationSegments : undefined,
          objectiveTerminalReconciliationPolicy: typeof postObjectiveAuthority === 'object'
            ? postObjectiveAuthority.terminalReconciliationPolicy : undefined,
          rtkContext,
          onDebug: (msg) => this.debug(`PreToolUse(sessionId=${sessionId}): ${msg}`),
        });

        switch (postResult.type) {
          case 'allow':
            respond({ type: 'pre_tool_use_response', requestId, action: 'allow' });
            break;
          case 'modify':
            respond({ type: 'pre_tool_use_response', requestId, action: 'modify', input: postResult.input });
            break;
          case 'block':
            respond({ type: 'pre_tool_use_response', requestId, action: 'block', reason: postResult.reason });
            break;
          case 'prompt':
            await this.handlePreToolUsePrompt(
              requestId,
              toolName,
              input,
              sessionId,
              postResult,
              toolCallId,
              runtimeContext,
              authorizationEpoch,
            );
            break;
          case 'source_activation_needed':
            respond({
              type: 'pre_tool_use_response',
              requestId,
              action: 'block',
              reason: `Source "${postResult.sourceSlug}" is still inactive after the activation attempt. The tool was not executed; retry only after the host reports the source active.`,
            });
            break;
          case 'call_llm_intercept': {
            const constrainedInput = { ...postResult.input, model: this.getModel() };
            respond({
              type: 'pre_tool_use_response',
              requestId,
              action: constrainedInput === postResult.input ? 'allow' : 'modify',
              ...(constrainedInput === postResult.input ? {} : { input: constrainedInput }),
            });
            break;
          }
          case 'spawn_session_intercept':
            respond({ type: 'pre_tool_use_response', requestId, action: 'modify', input: postResult.input });
            break;
        }
        return;
      }

      case 'call_llm_intercept': {
        // Re-read the live pin after every permission/automation await. The
        // subprocess receives the authoritative active model when Manual won.
        const constrainedInput = { ...checkResult.input, model: this.getModel() };
        respond({
          type: 'pre_tool_use_response',
          requestId,
          action: constrainedInput === checkResult.input ? 'allow' : 'modify',
          ...(constrainedInput === checkResult.input ? {} : { input: constrainedInput }),
        });
        return;
      }

      case 'spawn_session_intercept':
        respond({ type: 'pre_tool_use_response', requestId, action: 'modify', input: checkResult.input });
        return;

      case 'prompt': {
        await this.handlePreToolUsePrompt(
          requestId,
          toolName,
          input,
          sessionId,
          checkResult,
          toolCallId,
          runtimeContext,
          authorizationEpoch,
        );
        return;
      }
    }
  }

  private async handlePreToolUsePrompt(
    requestId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    sessionId: string,
    checkResult: Extract<PreToolUseCheckResult, { type: 'prompt' }>,
    toolUseId?: string,
    runtimeContext?: PiSubprocessRuntimeContext,
    authorizationEpoch = this.promptPreparationRevision,
  ): Promise<void> {
    const respond = (message: Record<string, unknown>) => {
      this.sendPreToolUseDecision({
        requestId,
        toolName,
        toolCallId: toolUseId,
        originalInput: toolInput,
        runtimeContext,
        authorizationEpoch,
      }, message);
    };
    if (!this.onPermissionRequest) {
      const gmailDecision = this.resolveContextualGmailPromptDecision(
        sessionId,
        toolName,
        toolInput,
        toolUseId,
        false,
      );
      if (gmailDecision.applies) {
        respond({
          type: 'pre_tool_use_response',
          requestId,
          action: 'block',
          reason: 'Explicit host approval is unavailable for this reserved Gmail reply. No reply was executed; run a fresh canonical preflight before any later retry.',
        });
        return;
      }
      if (checkResult.requiresExplicitConfirmation) {
        respond({
          type: 'pre_tool_use_response',
          requestId,
          action: 'block',
          reason: 'Explicit confirmation is required for this sensitive external action, but no permission handler is available.',
        });
      } else if (checkResult.modifiedInput) {
        // Ordinary Ask prompts retain the established headless behavior. Only
        // explicitly sensitive actions and reserved Gmail replies require a
        // live host decision.
        respond({
          type: 'pre_tool_use_response',
          requestId,
          action: 'modify',
          input: checkResult.modifiedInput,
        });
      } else {
        respond({ type: 'pre_tool_use_response', requestId, action: 'allow' });
      }
      return;
    }

    const permRequestId = `pi-perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.debug(`PreToolUse(sessionId=${sessionId}): Prompting user for ${toolName} - ${checkResult.description}`);

    const permissionPromise = new Promise<boolean>((resolve) => {
      this.pendingPermissions.set(permRequestId, {
        resolve,
        toolName,
      });
    });

    this.onPermissionRequest({
      requestId: permRequestId,
      toolName,
      toolUseId,
      command: checkResult.command,
      description: checkResult.description,
      type: checkResult.promptType,
      appName: checkResult.appName,
      reason: checkResult.reason,
      impact: checkResult.impact,
      requiresSystemPrompt: checkResult.requiresSystemPrompt,
      rememberForMinutes: checkResult.rememberForMinutes,
      commandHash: checkResult.commandHash,
      approvalTtlSeconds: checkResult.approvalTtlSeconds,
      sensitiveActionCategory: checkResult.sensitiveActionCategory,
      sensitiveActionTargets: checkResult.sensitiveActionTargets,
      sensitiveActionOperationHash: checkResult.sensitiveActionOperationHash,
    });

    const allowed = await permissionPromise;
    this.pendingPermissions.delete(permRequestId);
    if (!this.isRuntimeCurrent(runtimeContext)) return;
    let approvedInput = checkResult.modifiedInput ?? toolInput;
    if (allowed) {
      const rootPath = this.config.workspace.rootPath ?? this.workingDirectory;
      const workspaceSlug = extractWorkspaceSlug(rootPath, this.config.workspace.id);
      const currentUserRequest = this.getCurrentTurnUserMessage() ?? undefined;
      const objectiveAuthority = this.config.getObjectiveMutationAuthority?.(currentUserRequest);
      const rtkContext: RtkContext | undefined = getRtkEnabled()
        ? { enabled: true, path: getRtkPath(), exclude: [] }
        : undefined;
      const approvalCheck = runPreToolUseChecks({
        toolName,
        input: approvedInput,
        sessionId,
        toolUseId,
        runtimeId: runtimeContext?.runtimeId,
        permissionApprovalReentry: true,
        permissionMode: this.permissionManager.getPermissionMode(),
        workspaceRootPath: rootPath,
        workspaceId: workspaceSlug,
        plansFolderPath: getSessionPlansPath(rootPath, sessionId),
        dataFolderPath: getSessionDataPath(rootPath, sessionId),
        workingDirectory: this.config.session?.workingDirectory,
        executionIsolation: this.config.session?.executionIsolation,
        missionCapabilityLock: this.config.missionCapabilityLock,
        activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
        allSourceSlugs: this.sourceManager.getAllSources().map(s => s.config.slug),
        hasSourceActivation: !!this.onSourceActivationRequest,
        permissionManager: this.permissionManager,
        prerequisiteManager: this.prerequisiteManager,
        preloadedSourceGuidePaths: this.sourceManager.getPreloadedSourceGuidePaths(),
        currentUserRequest,
        declaredToolCapabilities: this.mcpPool?.getProxyToolCapabilities(toolName),
        externalActionPolicy: this.config.externalActionPolicy,
        humanInputAllowed: this.config.getHumanInputAllowed?.(),
        objectiveMutationAuthorized: typeof objectiveAuthority === 'boolean'
          ? objectiveAuthority : objectiveAuthority?.authorized,
        objectiveSensitiveActionAuthorized: typeof objectiveAuthority === 'object'
          ? objectiveAuthority.sensitiveActionAuthorized : objectiveAuthority,
        objectiveAuthorizationSegments: typeof objectiveAuthority === 'object'
          ? objectiveAuthority.authorizationSegments : undefined,
        authenticatedUserAuthorizationSegments: typeof objectiveAuthority === 'object'
          ? objectiveAuthority.authenticatedUserAuthorizationSegments : undefined,
        objectiveTerminalReconciliationPolicy: typeof objectiveAuthority === 'object'
          ? objectiveAuthority.terminalReconciliationPolicy : undefined,
        rtkContext,
        onDebug: msg => this.debug(`PostPermissionPreToolUse(sessionId=${sessionId}): ${msg}`),
      });
      if (approvalCheck.type === 'block' || approvalCheck.type === 'source_activation_needed') {
        respond({
          type: 'pre_tool_use_response',
          requestId,
          action: 'block',
          reason: approvalCheck.type === 'block'
            ? approvalCheck.reason
            : `Source "${approvalCheck.sourceSlug}" changed while permission was pending. The approved tool was not executed.`,
        });
        return;
      }
      if (approvalCheck.type === 'modify') approvedInput = approvalCheck.input;
      else if (approvalCheck.type === 'prompt' && approvalCheck.modifiedInput) {
        approvedInput = approvalCheck.modifiedInput;
      }
    }
    const gmailDecision = this.resolveContextualGmailPromptDecision(
      sessionId,
      toolName,
      toolInput,
      toolUseId,
      allowed,
    );

    if (!allowed) {
      respond({ type: 'pre_tool_use_response', requestId, action: 'block', reason: 'Permission denied by user.' });
    } else if (gmailDecision.applies && !gmailDecision.allowed) {
      respond({
        type: 'pre_tool_use_response',
        requestId,
        action: 'block',
        reason: gmailDecision.reason,
      });
    } else if (approvedInput !== toolInput) {
      respond({ type: 'pre_tool_use_response', requestId, action: 'modify', input: approvedInput });
    } else {
      respond({ type: 'pre_tool_use_response', requestId, action: 'allow' });
    }
  }

  private resolveContextualGmailPromptDecision(
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string | undefined,
    approved: boolean,
  ) {
    const currentRequest = this.getCurrentTurnUserMessage() ?? undefined;
    const currentAuthority = this.config.getObjectiveMutationAuthority?.(currentRequest);
    return resolveContextualGmailPromptReservation({
      sessionId,
      toolUseId,
      toolName,
      toolInput,
      approved,
      permissionMode: getPermissionModeDiagnostics(sessionId).permissionMode,
      activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
      objectiveAuthorizationSegments: typeof currentAuthority === 'object'
        ? currentAuthority.authorizationSegments
        : currentRequest ? [currentRequest] : [],
    });
  }

  /**
   * Keep the PreToolUse admission entirely in host memory. No bearer value is
   * serialized into the provider input, transcript, result or diagnostics.
   */
  private sendPreToolUseDecision(
    request: {
      requestId: string;
      toolName: string;
      toolCallId?: string;
      originalInput: Record<string, unknown>;
      runtimeContext?: PiSubprocessRuntimeContext;
      authorizationEpoch: number;
    },
    decision: Record<string, unknown>,
  ): void {
    const action = decision.action;
    if (action === 'allow' || action === 'modify') {
      const approvedInput = action === 'modify'
        ? decision.input as Record<string, unknown> | undefined
        : request.originalInput;
      const sessionId = request.runtimeContext?.sessionId
        ?? this.config.session?.id
        ?? this._sessionId;
      const runtimeId = request.runtimeContext?.runtimeId
        ?? this.subprocessRuntimeContext?.runtimeId
        ?? '';
      const executionStillCurrent = () => request.authorizationEpoch === this.promptPreparationRevision
        && this.isRuntimeCurrent(request.runtimeContext)
        && sessionId.length > 0 && runtimeId.length > 0
        && !!approvedInput;
      const block = (reason: string) => {
        this.sendForRuntime({
          type: 'pre_tool_use_response',
          requestId: request.requestId,
          action: 'block',
          reason,
        }, request.runtimeContext);
      };
      const admitAndSend = () => {
        const admitted = executionStillCurrent() && this.admitToolExecution({
          toolUseId: request.toolCallId,
          toolName: request.toolName,
          toolInput: approvedInput!,
          sessionId,
          runtimeId,
          authorizationEpoch: request.authorizationEpoch,
        });
        if (!admitted) {
          block('The host could not bind this tool approval to one exact execution. The tool was not executed.');
          return;
        }
        this.sendForRuntime(decision, request.runtimeContext);
      };
      if (!executionStillCurrent()) {
        block('The host could not bind this tool approval to one exact execution. The tool was not executed.');
        return;
      }

      const durabilityBarrier = this.config.beforeToolExecution;
      if (durabilityBarrier) {
        void (async () => {
          try {
            await durabilityBarrier({
              toolUseId: request.toolCallId,
              toolName: request.toolName,
              toolInput: approvedInput!,
            });
          } catch (error) {
            block(error instanceof ToolAdmissionRecoveryError
              ? error.safeReason
              : 'The host could not durably record this tool admission. The tool was not executed.');
            return;
          }
          // Stop, steering, or runtime replacement may win while durability is
          // being established. Admission remains exact and fail-closed.
          admitAndSend();
        })();
        return;
      }
      admitAndSend();
      return;
    }
    this.sendForRuntime(decision, request.runtimeContext);
  }

  /**
   * Handle a tool_execute_request from the subprocess.
   * Routes proxy tool calls (MCP, API, session) to the appropriate handler.
   *
   * The subprocess expects responses in the format:
   *   { content: string; isError: boolean }
   */
  private async handleToolExecuteRequest(request: {
    requestId: string;
    toolName: string;
    toolCallId?: string;
    args: Record<string, unknown>;
  }, runtimeContext?: PiSubprocessRuntimeContext): Promise<void> {
    if (!this.isRuntimeCurrent(runtimeContext)) return;
    const respond = (message: Record<string, unknown>) => {
      this.sendForRuntime(message, runtimeContext);
    };
    const sessionId = runtimeContext?.sessionId
      ?? this.config.session?.id
      ?? this._sessionId;
    const runtimeId = runtimeContext?.runtimeId
      ?? this.subprocessRuntimeContext?.runtimeId
      ?? '';
    if (!this.beginAdmittedToolExecution({
      toolUseId: request.toolCallId,
      toolName: request.toolName,
      toolInput: request.args,
      sessionId,
      runtimeId,
      authorizationEpoch: this.promptPreparationRevision,
    })) {
      respond({
        type: 'tool_execute_response',
        requestId: request.requestId,
        result: {
          content: 'The host did not find one exact current PreToolUse admission for this execution. The tool was not executed.',
          isError: true,
        },
      });
      return;
    }
    // Claim a bound Gmail invocation before any local routing branch. Even if
    // prerequisites changed or the proxy disappeared after PreToolUse, the
    // exact reservation must reach a terminal state instead of remaining
    // locked forever.
    const hostGuard = this.beginContextualGmailHostExecution({
      sessionId,
      runtimeId,
      toolUseId: request.toolCallId,
      toolName: request.toolName,
      toolInput: request.args,
    });
    if (hostGuard.applies && !hostGuard.allowed) {
      this.settleAdmittedToolExecution(request.toolCallId);
      respond({
        type: 'tool_execute_response',
        requestId: request.requestId,
        result: { content: hostGuard.reason, isError: true },
      });
      return;
    }
    const ticket = hostGuard.applies && hostGuard.allowed
      ? hostGuard.ticket
      : undefined;

    try {
      // Prerequisite check: block source tools until guide.md is read
      const prereqResult = this.prerequisiteManager.checkPrerequisites(request.toolName);
      if (!prereqResult.allowed) {
        respond({
          type: 'tool_execute_response',
          requestId: request.requestId,
          result: { content: prereqResult.blockReason!, isError: true },
        });
        return;
      }
      const result = await this.routeToolCall(
        request.toolName,
        request.args,
        request.toolCallId,
        runtimeContext,
        hostGuard.applies,
      );
      respond({
        type: 'tool_execute_response',
        requestId: request.requestId,
        result,
      });
    } catch (error) {
      respond({
        type: 'tool_execute_response',
        requestId: request.requestId,
        result: {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        },
      });
    } finally {
      this.settleAdmittedToolExecution(request.toolCallId);
      if (ticket && !this.settleContextualGmailHostExecution(ticket)) {
        this.debug(`Gmail host execution ticket was already settled or invalid for ${request.toolName}`);
      }
    }
  }

  /**
   * Route a proxy tool call to the appropriate handler based on tool name.
   *
   * - Session tools (SubmitPlan, config_validate, etc.) -> session-tools-core handlers
   * - call_llm -> preExecuteCallLlm (BaseAgent)
   * - mcp__* tools -> MCP server proxy (TODO)
   * - api_* tools -> API source proxy (TODO)
   *
   * Returns { content: string; isError: boolean } matching subprocess protocol.
   */
  private async routeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    toolUseId?: string,
    runtimeContext?: PiSubprocessRuntimeContext,
    hostExecutionClaimed = false,
  ): Promise<McpToolResult> {
    // Session-scoped tools — strip mcp__session__ prefix added by the Pi SDK
    // registration (tools are registered as mcp__session__SubmitPlan, etc.)
    const strippedName = toolName.startsWith('mcp__session__')
      ? toolName.slice('mcp__session__'.length)
      : toolName;

    if (SESSION_TOOL_NAMES.has(strippedName)) {
      return this.executeSessionTool(strippedName, args);
    }

    // MCP source tools — route through centralized pool
    if (this.mcpPool?.isProxyTool(toolName)) {
      if (hostExecutionClaimed) {
        return this.mcpPool.callTool(toolName, args);
      }
      const sessionId = runtimeContext?.sessionId
        ?? this.config.session?.id
        ?? this._sessionId;
      const runtimeId = runtimeContext?.runtimeId
        ?? this.subprocessRuntimeContext?.runtimeId
        ?? '';
      const hostGuard = this.beginContextualGmailHostExecution({
        sessionId,
        runtimeId,
        toolUseId,
        toolName,
        toolInput: args,
      });
      if (hostGuard.applies && !hostGuard.allowed) {
        return {
          content: hostGuard.reason,
          isError: true,
        };
      }
      const ticket = hostGuard.applies && hostGuard.allowed
        ? hostGuard.ticket
        : undefined;
      try {
        return await this.mcpPool.callTool(toolName, args);
      } finally {
        if (ticket && !this.settleContextualGmailHostExecution(ticket)) {
          this.debug(`Gmail host execution ticket was already settled or invalid for ${toolName}`);
        }
      }
    }

    // Unknown tool
    return {
      content: `Unknown proxy tool: ${toolName}`,
      isError: true,
    };
  }

  /** Narrow seams keep the host lifecycle directly unit-testable without a subprocess. */
  private beginContextualGmailHostExecution(
    input: Parameters<typeof beginContextualGmailHostExecution>[0],
  ): ReturnType<typeof beginContextualGmailHostExecution> {
    return beginContextualGmailHostExecution(input);
  }

  private settleContextualGmailHostExecution(
    ticket: Parameters<typeof settleContextualGmailHostExecution>[0],
  ): boolean {
    return settleContextualGmailHostExecution(ticket);
  }

  private confirmContextualGmailRuntimeTeardown(
    runtimeContext: Parameters<typeof confirmContextualGmailRuntimeTeardown>[0],
  ): boolean {
    return confirmContextualGmailRuntimeTeardown(runtimeContext);
  }

  /**
   * Get or create a SessionToolContext for executing session-scoped tools.
   * Cached per agent instance since the workspace/session don't change.
   */
  private getSessionToolContext(): SessionToolContext {
    if (this._sessionToolContext) return this._sessionToolContext;

    const sessionId = this.config.session?.id || '';
    const workspacePath = this.config.workspace.rootPath;
    const workspaceId = this.config.workspace.id;

    this._sessionToolContext = createClaudeContext({
      sessionId,
      workspacePath,
      workspaceId,
      onPlanSubmitted: (planPath: string) => {
        setLastPlanFilePath(sessionId, planPath);
        this.onPlanSubmitted?.(planPath);
      },
      onAuthRequest: (request: unknown) => {
        this.onAuthRequest?.(request as any);
      },
    });

    // Attach session self-management bindings (lazy getters from callback registry)
    attachSessionSelfManagementBindings(this._sessionToolContext, sessionId);

    return this._sessionToolContext;
  }

  /**
   * Execute a session-scoped tool by name.
   * Uses the canonical registry from @craft-agent/session-tools-core.
   */
  private async executeSessionTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> {
    try {
      // call_llm uses the shared pre-execution pipeline from BaseAgent
      if (toolName === 'call_llm') {
        try {
          const result = await this.preExecuteCallLlm(args);
          return { content: result.text || '(Model returned empty response)', isError: false };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `call_llm failed: ${msg}`, isError: true };
        }
      }

      // spawn_session uses the shared pre-execution pipeline from BaseAgent
      if (toolName === 'spawn_session') {
        try {
          const result = await this.preExecuteSpawnSession(args);
          return { content: JSON.stringify(result, null, 2), isError: false };
        } catch (error) {
          if (error instanceof SpawnSessionInputError) {
            return { content: JSON.stringify(error), isError: true };
          }
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `spawn_session failed: ${msg}`, isError: true };
        }
      }

      // browser_tool — single CLI-like tool for all browser actions
      if (toolName === 'browser_tool') {
        const callbacks = getSessionScopedToolCallbacks(this._sessionId);
        const browserFns = callbacks?.browserPaneFns;
        if (!browserFns) {
          return { content: 'Browser window controls are not available. This tool requires the desktop app.', isError: true };
        }

        try {
          const result = await executeBrowserToolCommand({
            command: (args.command as string | string[]) ?? '',
            fns: browserFns,
            sessionId: this._sessionId,
          });

          let content = result.output;
          if (result.image) {
            const sessionPath = getSessionPath(this.config.workspace.rootPath, this._sessionId);
            const imageBuffer = Buffer.from(result.image.data, 'base64');
            const ext = result.image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
            const saved = saveBinaryResponse(sessionPath, `browser-screenshot.${ext}`, imageBuffer, result.image.mimeType);

            if (saved.type === 'file_download') {
              content += [
                '',
                `Saved screenshot: ${saved.path}`,
                '',
                '```image-preview',
                JSON.stringify({
                  src: saved.path,
                  title: 'Browser Screenshot',
                }, null, 2),
                '```',
              ].join('\n');
            } else {
              content += `\n\n[Screenshot captured (${Math.round(result.image.sizeBytes / 1024)}KB ${result.image.mimeType}) but failed to save: ${saved.error}]`;
            }
          }

          return { content, isError: false };
        } catch (error) {
          // Branch on `err.code` (string), not `instanceof CodedError` — the
          // transport reconstructs a plain Error on the receiving side, so
          // class identity is lost across the wire.
          const rawCode = (error as { code?: unknown } | null)?.code;
          const code = typeof rawCode === 'string' ? rawCode : '';
          const msg = error instanceof Error ? error.message : String(error);
          const friendly = mapBrowserToolErrorCode(code) ?? msg;
          return { content: friendly, isError: true };
        }
      }

      const def = SESSION_TOOL_REGISTRY.get(toolName);
      if (!def) {
        return { content: `Unknown session tool: ${toolName}`, isError: true };
      }
      if (!def.handler) {
        return {
          content: `Session tool '${toolName}' is backend-executed (${def.executionMode}) but has no PiAgent adapter implementation.`,
          isError: true,
        };
      }

      const ctx = this.getSessionToolContext();
      const result: SessionToolResult = await def.handler(ctx, args);

      // Convert ToolResult to subprocess response format
      const text = result.content.map(c => c.text).join('\n');
      return { content: text, isError: !!result.isError };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.debug(`Session tool ${toolName} failed: ${msg}`);
      return { content: `Session tool error: ${msg}`, isError: true };
    }
  }



  /**
   * Handle session_tool_completed from subprocess.
   *
   * NOTE: For proxy-executed session tools, callbacks (onPlanSubmitted, etc.)
   * are already fired by executeSessionTool() via the SessionToolContext.
   * The subprocess sends this event because handleSessionEvent() detects the
   * mcp__session__ prefix, but we intentionally skip handleSessionMcpToolCompletion()
   * here to avoid double-firing callbacks.
   */
  private handleSessionToolCompleted(msg: Record<string, unknown>): void {
    const toolName = msg.toolName as string;
    const isError = msg.isError as boolean;
    this.debug(`Session tool completed: ${toolName} (isError=${isError})`);
    // Callbacks already handled by executeSessionTool() — no-op.
  }

  /**
   * Handle mini_completion_result from subprocess.
   */
  private handleMiniCompletionResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const text = msg.text as string | null;
    const pending = this.pendingMiniCompletions.get(id);
    if (pending) {
      this.pendingMiniCompletions.delete(id);
      pending.resolve(text);
    }
  }

  /**
   * Handle ensure_session_ready_result from subprocess.
   */
  private handleEnsureSessionReadyResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const sessionId = (msg.sessionId as string | null) ?? null;
    const pending = this.pendingEnsureSessionReady.get(id);
    if (!pending) return;

    this.pendingEnsureSessionReady.delete(id);
    if (sessionId && this.piSessionId !== sessionId) {
      this.piSessionId = sessionId;
      this.config.onSdkSessionIdUpdate?.(sessionId);
    }
    pending.resolve(sessionId);
  }

  /**
   * Handle compact_result from subprocess.
   */
  private handleCompactResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const success = Boolean(msg.success);
    const pending = this.pendingCompactions.get(id);
    if (!pending) return;

    this.pendingCompactions.delete(id);
    if (!success) {
      pending.reject(new Error(String(msg.errorMessage || 'Compaction failed')));
      return;
    }

    const raw = msg.result as Record<string, unknown> | undefined;
    if (!raw) {
      pending.resolve(null);
      return;
    }

    pending.resolve({
      summary: String(raw.summary || ''),
      firstKeptEntryId: String(raw.firstKeptEntryId || ''),
      tokensBefore: Number(raw.tokensBefore || 0),
      estimatedTokensAfter: typeof raw.estimatedTokensAfter === 'number'
        ? raw.estimatedTokensAfter
        : undefined,
      compactionModel: typeof raw.compactionModel === 'string'
        ? raw.compactionModel
        : undefined,
    });
  }

  /**
   * Handle set_auto_compaction_result from subprocess.
   */
  private handleSetAutoCompactionResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const success = Boolean(msg.success);
    const pending = this.pendingAutoCompactionToggles.get(id);
    if (!pending) return;

    this.pendingAutoCompactionToggles.delete(id);
    if (!success) {
      pending.reject(new Error(String(msg.errorMessage || 'Failed to set auto-compaction')));
      return;
    }

    pending.resolve(Boolean(msg.enabled));
  }

  /**
   * Handle update_runtime_config_result from subprocess.
   */
  private handleRuntimeConfigUpdateResult(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    const success = Boolean(msg.success);
    const pending = this.pendingRuntimeConfigUpdates.get(id);
    if (!pending) return;

    this.pendingRuntimeConfigUpdates.delete(id);
    if (!success) {
      pending.reject(new Error(String(msg.errorMessage || 'Runtime config update failed')));
      return;
    }

    pending.resolve(Boolean(msg.updated ?? true));
  }

  /**
   * Handle subprocess exit.
   */
  private hasPendingSubprocessWork(): boolean {
    return this._isProcessing
      || this.pendingPermissions.size > 0
      || this.pendingMiniCompletions.size > 0
      || this.pendingLlmQueries.size > 0
      || this.pendingEnsureSessionReady.size > 0
      || this.pendingCompactions.size > 0
      || this.pendingAutoCompactionToggles.size > 0
      || this.pendingRuntimeConfigUpdates.size > 0
      || this.pendingToolExecutions.size > 0;
  }

  private clearSubprocessReadyTimer(): void {
    if (this.subprocessReadyTimer) clearTimeout(this.subprocessReadyTimer);
    this.subprocessReadyTimer = null;
  }

  private resolveSubprocessReady(): void {
    const resolve = this.subprocessReadyResolve;
    this.clearSubprocessReadyTimer();
    this.subprocessReadyResolve = null;
    this.subprocessReadyReject = null;
    resolve?.();
  }

  private rejectSubprocessReady(error: Error): void {
    const reject = this.subprocessReadyReject;
    this.clearSubprocessReadyTimer();
    this.subprocessReadyResolve = null;
    this.subprocessReadyReject = null;
    reject?.(error);
  }

  private handleSubprocessError(
    error: Error,
    child: ChildProcess,
    runtimeContext?: PiSubprocessRuntimeContext,
  ): void {
    if (this.subprocess !== child) {
      this.debug(`Ignoring error from stale Pi subprocess: ${error.message}`);
      return;
    }
    // A process-level error is not proof that the child exited. Retain both the
    // child and its runtime identity until exit/close confirms termination, so
    // exact-once authority is neither released early nor orphaned forever.
    this.subprocessErrorsAwaitingExit.set(child, error);
    this.debug(`Pi subprocess error while awaiting confirmed termination: ${error.message}`);
    this.rejectSubprocessReady(new PiRuntimeInterruptedError(
      `Pi subprocess error (${error.message})`,
      'process_error',
    ));
  }

  private handleSubprocessExit(
    code: number | null,
    signal: string | null,
    child?: ChildProcess,
    processError?: Error,
    runtimeContext?: PiSubprocessRuntimeContext,
  ): void {
    if (child) {
      const forceKillTimer = this.subprocessForceKillTimers.get(child);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      this.subprocessForceKillTimers.delete(child);
    }
    const exitingRuntime = runtimeContext
      ?? (child ? this.subprocessRuntimeContexts.get(child) : undefined);
    const confirmedProcessError = processError
      ?? (child ? this.subprocessErrorsAwaitingExit.get(child) : undefined);
    if (child) this.subprocessErrorsAwaitingExit.delete(child);
    // A terminated generation may emit its exit after its replacement is
    // already live. Never let that late event tear down the new generation.
    if (child && this.subprocess !== child) {
      this.expectedSubprocessExits.delete(child);
      if (exitingRuntime) {
        this.confirmContextualGmailRuntimeTeardown(exitingRuntime);
      }
      this.debug('Ignoring termination from stale Pi subprocess generation');
      return;
    }

    this.revokeAdmittedToolExecutions();

    this.debug(confirmedProcessError
      ? `Pi subprocess error followed by confirmed exit: ${confirmedProcessError.message}`
      : `Pi subprocess exited: code=${code}, signal=${signal}`);

    const expectedExit = child ? this.expectedSubprocessExits.delete(child) : false;
    const hadPendingWork = this.hasPendingSubprocessWork();
    const interruptionCode: PiRuntimeInterruptionCode = confirmedProcessError
      ? 'process_error'
      : 'process_exit';
    const exitReason = confirmedProcessError?.message
      ?? (signal ? `signal ${signal}` : `code ${code}`);
    const interruptionError = new PiRuntimeInterruptedError(
      `Pi subprocess exited unexpectedly (${exitReason})`,
      interruptionCode,
    );
    this.rejectSubprocessReady(interruptionError);
    // A signal-only idle exit can come from the long-running-process idle
    // supervisor. Treat it as a failure only when work was active; explicit
    // non-zero exit codes remain failures even while idle.
    if (!expectedExit && (hadPendingWork || (code !== null && code !== 0))) {
      // The normal debug callback is intentionally low-volume in production.
      // Prefix unexpected exits with a structured marker so SessionManager can
      // persist one bounded, redacted diagnostic at error level instead of
      // losing the only useful stderr evidence with this in-memory ring buffer.
      const stderrTail = this.getRecentStderr().trim().slice(-RUNTIME_DIAGNOSTIC_MAX_CHARS);
      this.debug(`__RUNTIME_ERROR__${JSON.stringify({
        kind: 'pi_subprocess_exit',
        code,
        signal,
        ...(stderrTail ? { stderrTail } : {}),
      })}`);
    }

    this.subprocess = null;
    if (!runtimeContext
      || this.subprocessRuntimeContext?.runtimeId === runtimeContext.runtimeId) {
      this.subprocessRuntimeContext = null;
    }
    this.subprocessSupervisorHandle = null;
    this.readline = null;
    this.resetSubprocessErrorDedup();
    this.subprocessReady = null;
    this.subprocessReadyResolve = null;
    this.subprocessReadyReject = null;

    // Runtime loss is progress interruption, not a terminal provider error.
    // SessionManager owns the durable retry budget and process recreation.
    if (this._isProcessing && !expectedExit) {
      this.eventQueue.enqueue({
        type: 'runtime_interrupted',
        message: interruptionError.message,
        code: interruptionCode,
        exitCode: code,
        signal,
      });
      this.eventQueue.complete();
    }

    // Reject pending mini completions with error (not null) so callers
    // get a meaningful error instead of silently returning "no response"
    for (const [, pending] of this.pendingMiniCompletions) {
      pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    this.pendingMiniCompletions.clear();

    // Reject pending llm_query calls (call_llm in-flight during subprocess crash)
    for (const [, pending] of this.pendingLlmQueries) {
      pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    this.pendingLlmQueries.clear();

    // A dead runtime can never acknowledge any prompt that it owned.
    this.pendingProviderHandoffs.clear();
    this.pendingProviderDispatchRejections.clear();

    // Reject pending ensure_session_ready requests
    for (const [, pending] of this.pendingEnsureSessionReady) {
      pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    this.pendingEnsureSessionReady.clear();

    // Reject pending compact/toggle requests
    for (const [, pending] of this.pendingCompactions) {
      pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    this.pendingCompactions.clear();

    for (const [, pending] of this.pendingAutoCompactionToggles) {
      pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    this.pendingAutoCompactionToggles.clear();

    for (const [, pending] of this.pendingRuntimeConfigUpdates) {
      pending.reject(new Error(`Pi subprocess exited unexpectedly (${exitReason})`));
    }
    this.pendingRuntimeConfigUpdates.clear();

    // Reject all pending tool executions
    for (const [, pending] of this.pendingToolExecutions) {
      pending.reject(new Error('Pi subprocess exited'));
    }
    this.pendingToolExecutions.clear();

    // A permission prompt suspends handlePreToolUsePrompt. Runtime loss must
    // settle it fail-closed or the request and any sensitive-action reservation
    // remain live forever.
    this.denyAllPendingPermissions();

    // Drop any cached pre-tool metadata for the dead subprocess.
    this.preToolMetadataByCallId.clear();
    this.adapter.resetOverflowState();
    if (exitingRuntime) {
      this.confirmContextualGmailRuntimeTeardown(exitingRuntime);
    }
  }

  /**
   * Ask subprocess to create/verify the primary session (without sending a prompt)
   * and return the active Pi session ID.
   */
  private async requestEnsureSessionReady(): Promise<string | null> {
    await this.ensureSubprocess();

    const id = `ensure-ready-${++this.rpcIdCounter}`;
    const timeoutMs = 15_000;

    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingEnsureSessionReady.delete(id);
        reject(new Error(`ensure_session_ready timed out after ${Math.floor(timeoutMs / 1000)}s`));
      }, timeoutMs);

      this.pendingEnsureSessionReady.set(id, {
        resolve: (sessionId) => {
          clearTimeout(timer);
          resolve(sessionId);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.send({ type: 'ensure_session_ready', id });
    });
  }

  /**
   * Ask subprocess to compact the active session context.
   */
  private async requestCompact(customInstructions?: string): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number; estimatedTokensAfter?: number; compactionModel?: string } | null> {
    await this.ensureSubprocess();

    const id = `compact-${++this.rpcIdCounter}`;
    // GPT-backed Pi compactions on large conversations can legitimately take 60-120s.
    // Bound them at 210s and explicitly abort the SDK compaction on expiry so a
    // lost response cannot keep consuming tokens in the subprocess indefinitely.
    const timeoutMs = 210_000;

    return new Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number; estimatedTokensAfter?: number; compactionModel?: string } | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCompactions.delete(id);
        this.send({ type: 'abort_compaction', id });
        reject(new Error(`compact timed out after ${Math.floor(timeoutMs / 1000)}s`));
      }, timeoutMs);

      this.pendingCompactions.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.send({ type: 'compact', id, customInstructions });
    });
  }

  /** Host-triggered bounded-context compaction used by the session cost controller. */
  async compactContext(customInstructions?: string): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number; estimatedTokensAfter?: number; compactionModel?: string } | null> {
    return this.requestCompact(customInstructions);
  }

  /**
   * Ask the subprocess for one serialized manual compact-and-continue attempt
   * after the Pi SDK's native overflow recovery was skipped or exhausted.
   * Completion remains event-driven: compaction and recovered agent events flow
   * through PiEventAdapter, which owns the bounded recovery state machine.
   */
  private requestOverflowRecovery(): void {
    const id = `overflow-recovery-${++this.rpcIdCounter}`;
    this.debug(`Requesting guarded overflow recovery (${id})`);
    this.send({ type: 'recover_overflow', id });
  }

  /**
   * Ask subprocess to enable/disable auto-compaction.
   */
  private async requestSetAutoCompaction(enabled: boolean): Promise<boolean> {
    await this.ensureSubprocess();

    const id = `set-auto-compaction-${++this.rpcIdCounter}`;
    const timeoutMs = 15_000;

    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAutoCompactionToggles.delete(id);
        reject(new Error(`set_auto_compaction timed out after ${Math.floor(timeoutMs / 1000)}s`));
      }, timeoutMs);

      this.pendingAutoCompactionToggles.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.send({ type: 'set_auto_compaction', id, enabled });
    });
  }

  /**
   * Ask subprocess to refresh runtime-affecting custom endpoint config in-place.
   */
  private async requestRuntimeConfigUpdate(update: BackendRuntimeUpdate): Promise<boolean> {
    if (!this.subprocess) return true;

    const id = `runtime-config-${++this.rpcIdCounter}`;
    const timeoutMs = 15_000;
    const runtime = update.runtime ?? {};

    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRuntimeConfigUpdates.delete(id);
        reject(new Error(`update_runtime_config timed out after ${Math.floor(timeoutMs / 1000)}s`));
      }, timeoutMs);

      this.pendingRuntimeConfigUpdates.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.send({
        type: 'update_runtime_config',
        id,
        model: update.model,
        providerType: update.providerType,
        authType: update.authType,
        baseUrl: runtime.baseUrl,
        customEndpoint: runtime.customEndpoint,
        customModels: runtime.customModels,
      });
    });
  }

  /**
   * Ensure branched Pi sessions are backend-ready before first user message.
   * Called by SessionManager during branch creation to avoid creating
   * transcript-only branches without real Pi session context.
   */
  override async ensureBranchReady(): Promise<void> {
    const isBranchedSession = !!this.config.session?.branchFromMessageId;
    if (!isBranchedSession) return;

    // Branched sessions must include parent session path metadata for Pi forking.
    if (!this.config.session?.branchFromSessionPath) {
      throw new Error('Pi branch preflight failed: missing branchFromSessionPath metadata');
    }

    const sessionId = await this.requestEnsureSessionReady();
    if (!sessionId) {
      throw new Error('Pi branch preflight failed: subprocess did not provide a session ID');
    }

    if (this.piSessionId !== sessionId) {
      this.piSessionId = sessionId;
      this.config.onSdkSessionIdUpdate?.(sessionId);
    }
  }

  // ============================================================
  // Chat (AsyncGenerator backed by the subprocess event queue)
  // ============================================================

  protected async *chatImpl(
    messageParam: string,
    attachments?: FileAttachment[],
    options?: ChatOptions
  ): AsyncGenerator<AgentEvent> {
    let message = messageParam;
    let providerHandoffTurnId: string | undefined;
    const preparationRevision = this.promptPreparationRevision;
    this.revokeAdmittedToolExecutions();
    // Reset state for new turn
    this._isProcessing = true;
    this.abortReason = undefined;
    this.eventQueue.reset();
    this.currentUserMessage = message;
    this.adapter.startTurn();

    // Fire UserPromptSubmit hook event (fire-and-forget)
    this.emitAutomationEvent('UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: message,
    });

    // Refresh session-scoped tool callbacks (for SubmitPlan, source auth, etc.)
    // IMPORTANT: merge (don't replace) so SessionManager-provided browserPaneFns
    // survives across turns.
    const sessionId = this.config.session?.id;
    if (sessionId) {
      mergeSessionScopedToolCallbacks(sessionId, {
        onPlanSubmitted: (planPath) => this.onPlanSubmitted?.(planPath),
        onAuthRequest: (request) => this.onAuthRequest?.(request),
        queryFn: (request) => this.queryLlm(request),
      });
    }

    try {
      const bridgeProvider = getBackendRuntime(this.config).piAuthProvider;
      const bridgeName = bridgeProvider === 'google-antigravity' ? 'Antigravity'
        : bridgeProvider === 'mistral-vibe' ? 'Mistral Vibe' : undefined;
      if (bridgeName && attachments?.some(attachment =>
        attachment.type === 'image' || attachment.mimeType?.startsWith('image/')
      )) {
        // These external bridges send text only. Reject the turn before launch
        // so direct callers cannot silently discard images or transmit a partial prompt.
        yield {
          type: 'error',
          message: i18n.t('errors.bridgeImagesUnsupported', {
            provider: bridgeName,
            defaultValue: '{{provider}} cannot receive image attachments through this connection. Choose a connection that supports images, or remove the images before sending.',
          }),
        };
        yield { type: 'complete' };
        return;
      }

      // For OAuth providers with short-lived access tokens: proactively ensure tokens
      // are fresh before turn start so getPiAuth() or the running subprocess has valid credentials.
      const runtime = getBackendRuntime(this.config);
      if (this.config.authType === 'oauth' && runtime.piAuthProvider) {
        const slug = this.config.connectionSlug || 'pi';
        const expectedBindingId = this.config.expectedLlmCredentialBindingId;
        const stored = await getCredentialManager().getLlmOAuth(slug, expectedBindingId);
        if (shouldRefreshPiOAuthBeforeSpawn({
          authType: this.config.authType,
          piAuthProvider: runtime.piAuthProvider,
          refreshToken: stored?.refreshToken,
          expiresAt: stored?.expiresAt,
          refreshInFlight: PiAgent.globalRefreshMutex.has(
            `${slug}\u0000${expectedBindingId ?? 'unsealed'}`,
          ),
        })) {
          this.debug(`${runtime.piAuthProvider} token expired or expiring soon — proactively refreshing before chat turn`);
          await this.refreshAndPushTokens();
        }
      }

      // Ensure subprocess is spawned and ready
      try {
        await this.ensureSubprocess();
      } catch (subprocessError) {
        const errorMsg = subprocessError instanceof Error ? subprocessError.message : String(subprocessError);
        this.debug(`Failed to spawn Pi subprocess: ${errorMsg}`);

        // If resume failed, clear and try fresh
        if (this.piSessionId && !options?.isRetry && !(subprocessError instanceof InvalidWorkingDirectoryError)) {
          this.piSessionId = null;
          this.killSubprocess();
          this.clearSessionForRecovery();

          const recoveryContext = this.buildRecoveryContext();
          if (recoveryContext) {
            message = recoveryContext + message;
            this.debug('Injected recovery context into message');
          }

          await this.ensureSubprocess();
        } else {
          throw subprocessError;
        }
      }

      const trimmedMessage = message.trim();
      const compactCommand = parseCompactCommand(trimmedMessage);
      if (compactCommand && !attachments?.length) {
        const { customInstructions } = compactCommand;
        const compactResult = await this.requestCompact(customInstructions);
        if (compactResult) {
          yield {
            type: 'info',
            message: `Compacted context to fit within limits (from ~${compactResult.tokensBefore.toLocaleString()} tokens)`,
          };
        } else {
          yield { type: 'info', message: 'Compacted context to fit within limits' };
        }
        yield { type: 'complete' };
        return;
      }

      // Build system prompt
      const projectContext = this.resolveProjectContext();
      const systemPrompt = await getSystemPromptAsync(
        undefined, // pinnedPreferencesPrompt
        this.config.debugMode,
        this.config.workspace.rootPath,
        this.config.session?.workingDirectory,
        this.config.systemPromptPreset,
        ROBINSWOOD_BACKEND_NAME, // backendName
        getCoAuthorPreference(), // respect user's includeCoAuthoredBy preference (#576)
        projectContext ?? undefined,
      );

      // Stop can be handled while asynchronous filesystem discovery is pending.
      if (preparationRevision !== this.promptPreparationRevision) return;

      // Build context from sources
      const sourceContext = this.sourceManager.formatSourceState();

      const promptModeDiagnostics = getPermissionModeDiagnostics(this._sessionId)
      this.debug(
        `[ModeSnapshot] sessionId=${this._sessionId} chatPrompt mode=${promptModeDiagnostics.permissionMode} ` +
        `modeVersion=${promptModeDiagnostics.modeVersion} changedBy=${promptModeDiagnostics.lastChangedBy} changedAt=${promptModeDiagnostics.lastChangedAt}`
      )

      // Build context parts using centralized PromptBuilder, split into stable
      // vs volatile (issue #862). Stable blocks (workspace capabilities, working
      // directory) stay in the cached system prefix; volatile blocks (date/time,
      // session_state, source state) ride the user-message tail so a per-turn
      // re-stamp doesn't invalidate the prompt cache. buildVolatileContextParts
      // consumes the one-shot mode-change signal, so it is called exactly once.
      const plansFolderPath = getSessionPlansPath(this.config.workspace.rootPath, this._sessionId);
      const stableParts = this.promptBuilder.buildStableContextParts();
      const volatileParts = this.promptBuilder.buildVolatileContextParts(
        { plansFolderPath },
        sourceContext
      );

      // Process attachments
      const attachmentParts: string[] = [];
      const images: Array<{ type: string; data: string; mimeType: string }> = [];
      for (const att of attachments || []) {
        if (att.mimeType?.startsWith('image/') && att.base64) {
          images.push({
            type: 'image',
            data: att.base64,
            mimeType: att.mimeType,
          });
        } else if (att.mimeType?.startsWith('image/') && (att.storedPath || att.path)) {
          attachmentParts.push(`[Attached image: ${att.name}]\n[Stored at: ${att.storedPath || att.path}]`);
        } else if (att.mimeType === 'application/pdf' && att.storedPath) {
          attachmentParts.push(`[Attached PDF: ${att.name}]\n[Stored at: ${att.storedPath}]`);
        } else if (att.storedPath) {
          let pathInfo = `[Attached file: ${att.name}]\n[Stored at: ${att.storedPath}]`;
          if (att.markdownPath) {
            pathInfo += `\n[Markdown version: ${att.markdownPath}]`;
          }
          attachmentParts.push(pathInfo);
        }
      }

      // System prompt carries only stable context (issue #862): the system block
      // is pi-ai's cache prefix before all history, so anything volatile here
      // re-stamps the prefix every turn and drops cacheRead to 0. Volatile blocks
      // ride the user-message tail instead — exactly as the Claude path already
      // does (buildTextPrompt / buildSDKUserMessage append context to the tail).
      const fullSystemPrompt = [
        systemPrompt,
        ...stableParts,
      ].filter(Boolean).join('\n\n');

      // User message: volatile context + attachments + the actual message
      // (skill read directive is already prepended to message by BaseAgent.chat())
      const userParts = [
        ...volatileParts,
        ...attachmentParts,
        message,
      ].filter(Boolean);
      const userMessage = userParts.join('\n\n');

      if (preparationRevision !== this.promptPreparationRevision) return;

      // Send prompt to subprocess
      const turnId = `turn-${++this.rpcIdCounter}`;
      providerHandoffTurnId = turnId;
      this.pendingProviderHandoffs.set(turnId, this.captureProviderHandoffAcknowledgement());
      this.pendingProviderDispatchRejections.set(turnId, this.captureProviderDispatchRejection());
      const acknowledgeUncertainDispatch = this.captureProviderDispatchUncertainAcknowledgement();
      try {
        const accepted = await this.performProviderDispatchWriteAhead(() => {
          if (preparationRevision !== this.promptPreparationRevision) {
            throw new ProviderDispatchRejectedError('Pi prompt preparation changed before provider dispatch');
          }
          return this.send({
            type: 'prompt',
            id: turnId,
            message: userMessage,
            systemPrompt: fullSystemPrompt,
            images: images.length > 0 ? images : undefined,
            modelRoutePinned: this.modelRoutePinned(),
          });
        });
        // Test doubles historically returned void; only the real send path's
        // explicit false means the prompt was dropped before reaching stdin.
        if (accepted === false) {
          throw new ProviderDispatchRejectedError('Pi subprocess stdin is not writable');
        }
        // The child now owns the prompt, but its correlated preflight result
        // travels back on stdout. Stop in that inter-process window must not
        // restore/replay a delivery that the child may already have accepted.
        acknowledgeUncertainDispatch();
      } catch (error) {
        this.pendingProviderHandoffs.delete(turnId);
        this.pendingProviderDispatchRejections.delete(turnId);
        throw error;
      }

      // Yield events as they arrive. The source-activation drain controller
      // captures a pending restart on the first triggering tool_result and
      // drains sibling tool_results from the same parallel-tool batch before
      // firing `source_activated` + `forceAbort` — Pi's subprocess only picks
      // up new proxy tools on the next handlePrompt, so the restart is needed
      // here too. Without the drain, sibling tool_results from parallel
      // source_test calls are lost (#790).
      const sourceActivationDrain = new SourceActivationDrainController('fire-on-non-tool-result');
      for await (const event of this.eventQueue.drain()) {
        // Pre-yield check: when we're past capture and the incoming event is
        // not a tool_result, fire BEFORE yielding it (the event belongs to
        // the about-to-be-aborted next turn — letting it through would leak
        // a fragment of the cancelled response into the session journal).
        const preFire = sourceActivationDrain.shouldFireBeforeEvent(event);
        if (preFire) {
          this.debug(`source_test activated "${preFire.sourceSlug}", drained sibling tool_results, restarting turn`);
          yield preFire;
          this.forceAbort(AbortReason.SourceActivated);
          return;
        }

        if (sourceActivationDrain.observe(event, () => this.consumePendingSourceActivationRestart())) {
          yield event;
          continue;
        }

        yield event;
      }

      // Stream-end fallback: queue drained naturally with a captured restart
      // still pending. Fire and return (no further events expected).
      const sourceActivationFireAtEnd = sourceActivationDrain.shouldFireAtBoundary();
      if (sourceActivationFireAtEnd) {
        this.debug(`source_test activated "${sourceActivationFireAtEnd.sourceSlug}", stream ended with pending restart, restarting turn`);
        yield sourceActivationFireAtEnd;
        this.forceAbort(AbortReason.SourceActivated);
        return;
      }
    } catch (error) {
      if (error instanceof Error && !(error instanceof InvalidWorkingDirectoryError) && error.message.includes('abort')) {
        if (this.abortReason === AbortReason.PlanSubmitted) {
          return;
        }
        if (this.abortReason === AbortReason.AuthRequest) {
          return;
        }
        return;
      }

      const errorObj = error instanceof Error ? error : new Error(String(error));
      if (errorObj instanceof PiRuntimeInterruptedError) {
        yield {
          type: 'runtime_interrupted',
          message: errorObj.message,
          code: errorObj.interruptionCode,
        };
        yield { type: 'complete' };
        return;
      }
      const typedError = this.parsePiError(errorObj);

      if (typedError.code !== 'unknown_error') {
        yield { type: 'typed_error', error: typedError };
      } else {
        yield { type: 'error', message: errorObj.message };
      }

      yield { type: 'complete' };
    } finally {
      if (providerHandoffTurnId) {
        this.pendingProviderHandoffs.delete(providerHandoffTurnId);
        this.pendingProviderDispatchRejections.delete(providerHandoffTurnId);
      }
      this._isProcessing = false;
    }
  }

  // ============================================================
  // Permission Handling
  // ============================================================

  /**
   * Respond to a pending permission request.
   * Permission checking now happens in the main process, so this resolves locally.
   */
  respondToPermission(requestId: string, allowed: boolean, _alwaysAllow?: boolean): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      this.pendingPermissions.delete(requestId);
      pending.resolve(allowed);
    }
  }

  // ============================================================
  // Model Forwarding
  // ============================================================

  async updateRuntimeConfig(update: BackendRuntimeUpdate): Promise<boolean> {
    const previousModel = this.getModel();
    const previousRuntime = getBackendRuntime(this.config);

    this.config = {
      ...this.config,
      providerType: update.providerType ?? this.config.providerType,
      authType: update.authType ?? this.config.authType,
      model: update.model,
      runtime: {
        ...previousRuntime,
        ...(update.runtime ?? {}),
      },
    };
    this._model = update.model;
    this.adapter.setCallLlmModel(update.model);

    if (!this.subprocess) {
      this.debug(`Runtime config updated locally (no subprocess): ${previousModel} → ${update.model}`);
      return true;
    }

    const updated = await this.requestRuntimeConfigUpdate({
      ...update,
      providerType: this.config.providerType,
      authType: this.config.authType,
      runtime: getBackendRuntime(this.config),
    });
    this.debug(`Runtime config refreshed in subprocess: ${previousModel} → ${update.model}`);
    return updated;
  }

  override setModel(model: string): void {
    const previousModel = this.getModel();
    super.setModel(model);
    this.adapter.setCallLlmModel(model);
    // Forward to subprocess so it uses the new model on next turn
    if (this.subprocess) {
      this.debug(`Forwarding model change to subprocess: ${previousModel} → ${model}`);
      this.send({ type: 'set_model', model });
    } else {
      this.debug(`Model updated but no subprocess to forward to: ${previousModel} → ${model}`);
    }
  }

  override setThinkingLevel(level: ThinkingLevel): void {
    const previousLevel = this.getThinkingLevel();
    super.setThinkingLevel(level);
    // Forward to subprocess so it uses the new thinking level on next turn
    if (this.subprocess) {
      this.debug(`Forwarding thinking level change to subprocess: ${previousLevel} → ${level}`);
      this.send({ type: 'set_thinking_level', level });
    } else {
      this.debug(`Thinking level updated but no subprocess to forward to: ${previousLevel} → ${level}`);
    }
  }

  // ============================================================
  // Source / MCP Integration
  // ============================================================

  override async setSourceServers(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, unknown>,
    intendedSlugs?: string[]
  ): Promise<void> {
    // BaseAgent.setSourceServers() handles:
    //   1. SourceManager state tracking (active slugs)
    //   2. McpClientPool sync (connecting/disconnecting MCP + API sources)
    await super.setSourceServers(mcpServers, apiServers, intendedSlugs);

    // Register pool's proxy tool defs with subprocess so the model can call them.
    this.registerPoolToolsWithSubprocess();
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  private invalidateContextualGmailStateForCurrentSession(): void {
    const sessionId = this.subprocessRuntimeContext?.sessionId
      ?? this.config.session?.id
      ?? this._sessionId;
    if (sessionId) invalidateContextualGmailSessionState(sessionId);
  }

  private hasContextualGmailInFlightForCurrentRuntime(): boolean {
    const runtimeContext = this.subprocessRuntimeContext;
    return !!runtimeContext && hasContextualGmailInFlightForRuntime(runtimeContext);
  }

  /** Settle every host permission wait fail-closed before runtime teardown. */
  private denyAllPendingPermissions(): void {
    if (this.pendingPermissions.size === 0) return;
    const pendingPermissions = [...this.pendingPermissions.values()];
    this.pendingPermissions.clear();
    for (const pending of pendingPermissions) {
      pending.resolve(false);
    }
  }

  isProcessing(): boolean {
    return this._isProcessing;
  }

  async abort(reason?: string): Promise<void> {
    const requiresRuntimeTeardown = this.hasContextualGmailInFlightForCurrentRuntime()
      || this.hasAdmittedToolExecutions();
    this.promptPreparationRevision++;
    this.revokeAdmittedToolExecutions();
    // Fire Stop hook event (fire-and-forget)
    this.emitAutomationEvent('Stop', { hook_event_name: 'Stop' });

    // Deny all pending permissions
    this.denyAllPendingPermissions();
    this.invalidateContextualGmailStateForCurrentSession();

    // A plain SDK abort leaves the subprocess able to emit a delayed proxy
    // request. An admitted Gmail mutation therefore requires confirmed process
    // teardown before its not-yet-started reservation can be released.
    if (requiresRuntimeTeardown) {
      await this.killSubprocessGracefully();
    } else {
      this.send({ type: 'abort' });
    }
    this.eventQueue.complete();

    // Clear bridge cache for this interrupted turn.
    this.preToolMetadataByCallId.clear();
  }

  forceAbort(reason: AbortReason): void {
    const requiresRuntimeTeardown = this.hasContextualGmailInFlightForCurrentRuntime()
      || this.hasAdmittedToolExecutions();
    this.promptPreparationRevision++;
    this.revokeAdmittedToolExecutions();
    // Fire Stop hook event (fire-and-forget)
    this.emitAutomationEvent('Stop', { hook_event_name: 'Stop' });

    this.abortReason = reason;
    this._isProcessing = false;

    // Reject all pending permissions
    this.denyAllPendingPermissions();
    this.invalidateContextualGmailStateForCurrentSession();

    // Reject all pending tool executions
    for (const [, pending] of this.pendingToolExecutions) {
      pending.reject(new Error(`Force aborted: ${reason}`));
    }
    this.pendingToolExecutions.clear();

    // Signal turn complete to wake up any waiting consumers
    this.eventQueue.complete();

    // Clear bridge cache for aborted turn.
    this.preToolMetadataByCallId.clear();

    if (requiresRuntimeTeardown) {
      this.killSubprocess();
      return;
    }

    // For PlanSubmitted and AuthRequest, just interrupt the turn
    if (reason === AbortReason.PlanSubmitted || reason === AbortReason.AuthRequest) {
      return;
    }

    // For other reasons, send abort to subprocess
    this.send({ type: 'abort' });
  }

  /**
   * Redirect mid-stream via Pi SDK's steer().
   * Delivers the message after the current tool finishes, skips remaining
   * queued tools, and continues with full context intact.
   * Events flow through the existing generator — no abort needed.
   */
  override redirect(message: string): boolean {
    if ((this.pendingPermissions?.size ?? 0) > 0 || this.hasAdmittedToolExecutions()) {
      this.forceAbort(AbortReason.Redirect);
      return false;
    }
    // Vibe and Antigravity cannot deliver an authenticated mid-stream steer.
    // Tear down the old turn before returning false so SessionManager can keep
    // the complete replacement instruction in its durable queue.
    if (['mistral-vibe', 'google-antigravity'].includes(
      getBackendRuntime(this.config).piAuthProvider ?? '',
    )) {
      this.forceAbort(AbortReason.Redirect);
      return false;
    }

    if (!this._isProcessing || !this.subprocess) {
      // Not streaming or no subprocess — fall back to abort
      this.forceAbort(AbortReason.Redirect);
      return false;
    }
    this.debug(`Steering mid-stream: "${message.slice(0, 100)}"`);
    this.promptPreparationRevision++;
    if (!this.send({ type: 'steer', message })) {
      // A rejected stdin write is not a delivered steer. Stop the old runtime
      // before returning false so the host can durably replay this instruction.
      this.forceAbort(AbortReason.Redirect);
      return false;
    }
    // Pi skips the model's remaining queued tools before continuing from this
    // steer. Bind subsequent PreToolUse authority to the accepted steer text.
    this.setCurrentTurnUserMessage(message);
    return true;
  }

  // ============================================================
  // Session ID overrides — Pi maintains its own subprocess session id
  // ============================================================

  override getSessionId(): string | null {
    return this.piSessionId;
  }

  override setSessionId(sessionId: string | null): void {
    this.piSessionId = sessionId;
  }

  override setWorkspace(workspace: Workspace): void {
    super.setWorkspace(workspace);
    this.piSessionId = null;
    this._sessionToolContext = null;
    this.killSubprocess();
  }

  override clearHistory(): void {
    this.piSessionId = null;
    this.killSubprocess();
    super.clearHistory();
    this.debug('History cleared - next chat will start new subprocess');
  }

  destroy(): void {
    this.stopConfigWatcher();

    // Unregister session-scoped tool callbacks
    if (this.config.session?.id) {
      invalidateContextualGmailSessionState(this.config.session.id);
      unregisterSessionScopedToolCallbacks(this.config.session.id);
    }

    this._sessionToolContext = null;
    // Pool clients are owned by the main process — don't close them here.
    this.killSubprocess();
    this.debug('PiAgent destroyed');
  }

  async disposeForRestart(): Promise<void> {
    this.stopConfigWatcher();

    if (this.config.session?.id) {
      invalidateContextualGmailSessionState(this.config.session.id);
      unregisterSessionScopedToolCallbacks(this.config.session.id);
    }

    this._sessionToolContext = null;
    await this.killSubprocessGracefully();
    this.debug('PiAgent disposed for restart');
  }

  /**
   * Reconnect by killing subprocess -- next chat() will spawn fresh.
   */
  async reconnect(): Promise<void> {
    this.killSubprocess();
    this.debug('PiAgent reconnected (subprocess will be respawned on next chat)');
  }

  /**
   * Gracefully stop the subprocess and wait briefly for the child to exit.
   * Used before an idle runtime restart so we don't leave transient children behind.
   */
  private async killSubprocessGracefully(timeoutMs = 2_000): Promise<void> {
    this.denyAllPendingPermissions();
    this.invalidateContextualGmailStateForCurrentSession();
    const child = this.subprocess;
    if (!child) {
      this.killSubprocess();
      return;
    }
    const runtimeContext = this.subprocessRuntimeContext
      ?? this.subprocessRuntimeContexts.get(child);

    this.expectedSubprocessExits.add(child);

    const pid = child.pid;
    const waitForExit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      if (child.exitCode !== null || child.signalCode) {
        resolve({ code: child.exitCode, signal: child.signalCode });
        return;
      }
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    try {
      this.send({ type: 'shutdown' });
    } catch {
      // stdin may already be closed
    }

    if (this.subprocessSupervisorHandle) {
      this.subprocessSupervisorHandle.terminate('Pi agent graceful shutdown');
    } else {
      child.kill('SIGTERM');
    }
    let result = await Promise.race([
      waitForExit,
      new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
    ]);

    if (!result && this.subprocess === child) {
      this.debug(`Pi subprocess ${pid ?? '(unknown pid)'} did not exit after ${timeoutMs}ms; sending SIGKILL`);
      child.kill('SIGKILL');
      result = await Promise.race([
        waitForExit,
        new Promise<null>(resolve => setTimeout(() => resolve(null), 1_000)),
      ]);
    }

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
    if (this.subprocess === child) {
      this.subprocess = null;
      if (!runtimeContext
        || this.subprocessRuntimeContext?.runtimeId === runtimeContext.runtimeId) {
        this.subprocessRuntimeContext = null;
      }
    }
    this.subprocessSupervisorHandle = null;
    this.subprocessReady = null;
    this.subprocessReadyResolve = null;
    this.subprocessReadyReject = null;
    this.clearSubprocessReadyTimer();
    this.callbackPort = 0;
    this.preToolMetadataByCallId.clear();
    this.adapter.resetOverflowState();
    if (result && runtimeContext) {
      this.confirmContextualGmailRuntimeTeardown(runtimeContext);
    }

    if (result) {
      this.debug(`Pi subprocess ${pid ?? '(unknown pid)'} stopped for restart: code=${result.code}, signal=${result.signal}`);
    } else {
      this.debug(`Pi subprocess ${pid ?? '(unknown pid)'} stop timed out after SIGKILL`);
    }
  }

  /**
   * Escalate an owner-requested stop without ever targeting a replacement
   * generation. Exact-once Gmail state remains locked until exit/close invokes
   * handleSubprocessExit and confirms teardown for this same runtime.
   */
  private scheduleSubprocessForceKill(
    child: ChildProcess,
    runtimeContext?: PiSubprocessRuntimeContext,
    delayMs = PI_SUBPROCESS_FORCE_KILL_DELAY_MS,
  ): void {
    if (this.subprocessForceKillTimers.has(child)) return;
    const expectedRuntimeId = runtimeContext?.runtimeId
      ?? this.subprocessRuntimeContexts.get(child)?.runtimeId;
    const timer = setTimeout(() => {
      this.subprocessForceKillTimers.delete(child);
      if (!this.expectedSubprocessExits.has(child)
        || child.exitCode !== null
        || child.signalCode !== null) return;
      const registeredRuntimeId = this.subprocessRuntimeContexts.get(child)?.runtimeId;
      if (expectedRuntimeId && registeredRuntimeId !== expectedRuntimeId) {
        this.debug(`Skipping SIGKILL for Pi subprocess ${child.pid ?? '(unknown pid)'} after runtime correlation changed`);
        return;
      }
      this.debug(`Pi subprocess ${child.pid ?? '(unknown pid)'} ignored SIGTERM; sending SIGKILL`);
      try { child.kill('SIGKILL'); } catch { /* exit/close remains the teardown authority */ }
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.subprocessForceKillTimers.set(child, timer);
  }

  /**
   * Kill the subprocess and clean up resources.
   */
  private killSubprocess(): void {
    this.revokeAdmittedToolExecutions();
    this.denyAllPendingPermissions();
    this.invalidateContextualGmailStateForCurrentSession();
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    if (this.subprocess) {
      const child = this.subprocess;
      this.expectedSubprocessExits.add(child);
      // Try graceful shutdown first
      try {
        this.send({ type: 'shutdown' });
      } catch {
        // stdin may already be closed
      }
      if (this.subprocessSupervisorHandle) {
        this.subprocessSupervisorHandle.terminate('Pi agent reset');
      } else {
        child.kill('SIGTERM');
      }
      this.scheduleSubprocessForceKill(
        child,
        this.subprocessRuntimeContext ?? this.subprocessRuntimeContexts.get(child),
      );
      this.subprocess = null;
      if (this.subprocessRuntimeContext?.runtimeId
        === this.subprocessRuntimeContexts.get(child)?.runtimeId) {
        this.subprocessRuntimeContext = null;
      }
    } else {
      this.subprocessRuntimeContext = null;
    }
    this.subprocessSupervisorHandle = null;

    this.subprocessReady = null;
    this.subprocessReadyResolve = null;
    this.subprocessReadyReject = null;
    this.clearSubprocessReadyTimer();
    this.callbackPort = 0;
    this.preToolMetadataByCallId.clear();

    // Clear any in-flight overflow-recovery state so a stale fallback timer
    // doesn't fire on a torn-down adapter.
    this.adapter.resetOverflowState();
  }

  // ============================================================
  // Mini Completion (for title generation + summarization)
  // ============================================================

  /**
   * Run a simple text completion via the subprocess.
   * Sends a mini_completion request and waits for the result.
   */
  async runMiniCompletion(prompt: string): Promise<string | null> {
    await this.config.beforeProviderExecution?.();
    if (this.config.missionCapabilityLock) {
      throw new ProviderDispatchRejectedError('Auxiliary mini-model completion is disabled for a specialized Mission');
    }
    // If subprocess isn't running, spawn it
    await this.ensureSubprocess();

    const id = `mini-${++this.rpcIdCounter}`;
    const resultPromise = new Promise<string | null>((resolve, reject) => {
      this.pendingMiniCompletions.set(id, { resolve, reject });
    });

    this.send({
      type: 'mini_completion',
      id,
      prompt,
      allowModelSubstitution: false,
    });

    // Keep this aligned with the subprocess-side queryLlm timeout.
    const timeout = new Promise<string | null>((resolve) => {
      setTimeout(() => {
        if (this.pendingMiniCompletions.has(id)) {
          this.pendingMiniCompletions.delete(id);
          this.debug(`[runMiniCompletion] Timed out after ${LLM_QUERY_TIMEOUT_MS / 1000}s`);
          resolve(null);
        }
      }, LLM_QUERY_TIMEOUT_MS);
    });

    const text = await Promise.race([resultPromise, timeout]);
    this.debug(`[runMiniCompletion] Result: ${text ? `"${text.slice(0, 200)}"` : 'null'}`);
    return text;
  }

  /**
   * Execute an LLM query via the subprocess.
   * Used by session-scoped tool callbacks (call_llm).
   *
   * Sends the full LLMQueryRequest over the `llm_query` RPC so the subprocess's
   * model-aware queryLlm() can honor `request.model`, `request.systemPrompt`,
   * and (transitively via buildCallLlmRequest) `request.outputSchema`.
   * See packages/shared/CLAUDE.md → "queryLlm backend contract" and
   * packages/pi-agent-server/src/index.ts → handleLlmQuery for the invariant.
   */
  async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
    this.debug('[PiAgent.queryLlm] Starting');

    await this.config.beforeProviderExecution?.();

    await this.ensureSubprocess();

    const id = `llm-${++this.rpcIdCounter}`;
    const resultPromise = new Promise<LLMQueryResult>((resolve, reject) => {
      this.pendingLlmQueries.set(id, { resolve, reject });
    });

    const model = this.getModel();
    this.send({
      type: 'llm_query',
      id,
      request: { ...request, model },
      allowModelSubstitution: false,

    });

    // Keep this aligned with the subprocess-side queryLlm timeout.
    const timeout = new Promise<LLMQueryResult>((_, reject) => {
      setTimeout(() => {
        if (this.pendingLlmQueries.has(id)) {
          this.pendingLlmQueries.delete(id);
          reject(new Error(`queryLlm timed out after ${LLM_QUERY_TIMEOUT_MS / 1000}s`));
        }
      }, LLM_QUERY_TIMEOUT_MS);
    });

    return Promise.race([resultPromise, timeout]);
  }

  // ============================================================
  // Helpers
  // ============================================================

  /**
   * Resolve working directory to an absolute path.
   * BaseAgent stores paths with tilde (~) but Node.js spawn doesn't expand tilde.
   */
  private resolvedCwd(): string {
    const wd = this.workingDirectory;
    if (wd.startsWith('~/')) return join(homedir(), wd.slice(2));
    if (wd === '~') return homedir();
    return wd;
  }

  // ============================================================
  // Error Parsing
  // ============================================================

  /**
   * Parse a Pi error into a typed AgentError.
   */
  private parsePiError(error: Error): AgentError {
    if (error instanceof InvalidWorkingDirectoryError) return parseError(error);
    const errorMessage = error.message.toLowerCase();

    // Auth errors
    if (
      errorMessage.includes('api key') ||
      errorMessage.includes('unauthorized') ||
      errorMessage.includes('401') ||
      errorMessage.includes('authentication')
    ) {
      // For OAuth connections, attempt token refresh before giving up
      if (this.config.authType === 'oauth') {
        this.refreshAndPushTokens().catch(err => {
          this.debug(`Token refresh from parsePiError failed: ${err}`);
        });
      }

      return {
        code: 'invalid_api_key',
        title: 'Invalid API Key',
        message: 'Your API key was rejected. Check your credentials in Settings.',
        actions: [
          { key: 's', label: 'Update API key', command: '/settings', action: 'settings' },
        ],
        canRetry: this.config.authType === 'oauth',
        originalError: error.message,
      };
    }

    // Rate limiting
    if (errorMessage.includes('rate') || errorMessage.includes('429')) {
      return {
        code: 'rate_limited',
        title: 'Rate Limited',
        message: 'Too many requests. Please wait a moment before trying again.',
        actions: [
          { key: 'r', label: 'Retry', action: 'retry' },
        ],
        canRetry: true,
        retryDelayMs: 5000,
        originalError: error.message,
      };
    }

    // Service errors
    if (
      errorMessage.includes('500') ||
      errorMessage.includes('502') ||
      errorMessage.includes('503') ||
      errorMessage.includes('service') ||
      errorMessage.includes('overloaded')
    ) {
      return {
        code: 'service_error',
        title: 'Service Error',
        message: 'The AI service is temporarily unavailable. Please try again.',
        actions: [
          { key: 'r', label: 'Retry', action: 'retry' },
        ],
        canRetry: true,
        retryDelayMs: 2000,
        originalError: error.message,
      };
    }

    // Network errors
    if (
      errorMessage.includes('network') ||
      errorMessage.includes('econnrefused') ||
      errorMessage.includes('fetch failed')
    ) {
      return {
        code: 'network_error',
        title: 'Connection Error',
        message: 'Could not connect to the server. Check your internet connection.',
        actions: [
          { key: 'r', label: 'Retry', action: 'retry' },
        ],
        canRetry: true,
        retryDelayMs: 1000,
        originalError: error.message,
      };
    }

    // Fall back to shared error parsing
    return parseError(error);
  }

  // ============================================================
  // Debug
  // ============================================================

  protected override debug(message: string): void {
    this.onDebug?.(`[pi] ${message}`);
  }
}

// Alias for consistency with other backend naming
export { PiAgent as PiBackend };
