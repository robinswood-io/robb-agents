/**
 * Backend Abstraction Types
 *
 * Defines the core interface that all AI backends (Claude, OpenAI, etc.) must implement.
 * The CraftAgent facade delegates to these backends, enabling provider switching while
 * maintaining a consistent API surface.
 *
 * Key design decisions:
 * - Provider-agnostic events: All backends emit the same AgentEvent types
 * - Capabilities-driven UI: Model/thinking selectors read from capabilities()
 * - Callback pattern: Facade sets callbacks after creating backend
 * - AsyncGenerator for streaming: Consistent with existing CraftAgent API
 */
import type { AgentEvent } from "@craft-agent/core/types";
import type { FileAttachment } from "../../../utils/files.ts";
import type { ThinkingLevel } from "../../thinking-levels.ts";
import type { PermissionMode } from "../../mode-manager.ts";
import type { LoadedSource } from "../../../sources/types.ts";
import type { Workspace } from "../../../config/storage.ts";
import type { SourceManager } from "../../core/source-manager.ts";
import type { LLMQueryRequest, LLMQueryResult } from "../../llm-tool.ts";
// Import AbortReason and RecoveryMessage from core module (single source of truth)
import { AbortReason } from "../../core/index.ts";
import type { AuthCallback, BackendRuntimeUpdate, ChatOptions, PermissionCallback, PlanCallback, PostInitResult, SdkMcpServerConfig, SourceActivationCallback, SourceChangeCallback, SourceServerSnapshot } from './contracts.ts';

/**
 * Core backend interface - all AI providers must implement this.
 *
 * The interface is designed to:
 * 1. Abstract provider differences (Claude SDK vs OpenAI Responses API)
 * 2. Enable the facade pattern in CraftAgent
 * 3. Support streaming via AsyncGenerator
 * 4. Allow capability-based UI adaptation
 */
export interface AgentBackend {
  /** Redacted subprocess diagnostics when the backend runs out of process. */
  getRecentStderr?(): string;
  // ============================================================
  // Chat & Lifecycle
  // ============================================================

  /**
   * Send a message and stream back events.
   * This is the core agentic loop - handles tool execution, permission checks, etc.
   *
   * @param message - User message text
   * @param attachments - Optional file attachments
   * @param options - Optional chat configuration
   * @yields AgentEvent stream
   */
  chat(
    message: string,
    attachments?: FileAttachment[],
    options?: ChatOptions
  ): AsyncGenerator<AgentEvent, void, unknown>;

  /**
   * Abort current query (user stop or internal abort).
   *
   * @param reason - Optional reason for abort (for logging/debugging)
   */
  abort(reason?: string): Promise<void>;

  /**
   * Force abort with specific reason.
   * Used for true hard-stop semantics (user stop, redirect fallback, teardown).
   *
   * @param reason - AbortReason enum value
   */
  forceAbort(reason: AbortReason): void;

  /**
   * WS2: register a sink for background task events that arrive BETWEEN turns
   * (when no chat() generator is being consumed) under keep-alive mode. Backends
   * without a persistent cross-turn query may leave this unimplemented.
   */
  setBackgroundEventSink?(sink: ((event: AgentEvent) => void) | null): void;

  /**
   * Interrupt the current turn because control is being handed to the UI.
   *
   * Used for pause points like plan submission and auth requests, where the
   * session should stop cleanly without necessarily using the backend's
   * hardest abort primitive.
   *
   * @param reason - AbortReason enum value for the handoff boundary
   */
  interruptForHandoff(reason: AbortReason): void;

  /**
   * Redirect the agent mid-stream with a new user message.
   * Called when the user sends a message while the agent is still processing.
   *
   * Each backend decides its own strategy:
   * - Backends with native steering (e.g., Pi) inject the message into the
   *   current stream and return true — events continue through the existing
   *   generator, no abort needed.
   * - Backends without steering call forceAbort(Redirect) internally and
   *   return false — the session layer queues the message for re-send.
   *
   * @param message - The new user message
   * @returns true if steered (events flow through existing stream),
   *          false if aborted (session layer must queue + re-send)
   */
  redirect(message: string): boolean;

  /**
   * Run a simple text completion using the backend's auth infrastructure.
   * Used for connection testing and title/icon metadata only.
   */
  runMiniCompletion(prompt: string): Promise<string | null>;

  /** Query task content using the selected session model unless explicitly overridden. */
  queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult>;

  /**
   * Compact the provider-side conversation before a costly turn. Backends that
   * cannot compact in place may omit this capability.
   */
  compactContext?(customInstructions?: string): Promise<{
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    /** SDK estimate of the actual model-visible context immediately after compaction. */
    estimatedTokensAfter?: number;
    /** Provider model that generated the summary, when reported by the backend. */
    compactionModel?: string;
  } | null>;

  /**
   * Clean up resources (MCP connections, watchers, etc.)
   */
  destroy(): void;

  /**
   * Alias for destroy() for consistency.
   */
  dispose(): void;

  /**
   * Post-construction initialization.
   * Handles auth injection, initial config generation, etc.
   * Called after construction and callback wiring, before first chat().
   */
  postInit(): Promise<PostInitResult>;

  /**
   * Ensure branch sessions are backend-ready before first user message.
   * Called at branch creation time to avoid creating "fake branches" that have
   * copied transcript history but no actual backend branch context.
   *
   * Default behavior can be a no-op for providers that don't need preflight.
   */
  ensureBranchReady(): Promise<void>;

  /**
   * Check if currently processing a query.
   */
  isProcessing(): boolean;

  // ============================================================
  // Model & Thinking Configuration
  // ============================================================

  /** Get current model ID */
  getModel(): string;

  /** Set model (should validate against capabilities) */
  setModel(model: string): void;

  /**
   * Update runtime-affecting provider config without recreating the backend.
   * Backends return false when the update cannot be applied in-place and the
   * session manager should fall back to an idle restart.
   */
  updateRuntimeConfig?(update: BackendRuntimeUpdate): Promise<boolean>;

  /**
   * Dispose resources before an idle backend restart. Backends with subprocesses
   * can wait for child process exit here to avoid transient process leaks.
   */
  disposeForRestart?(): Promise<void>;

  /** Get current thinking level */
  getThinkingLevel(): ThinkingLevel;

  /** Set thinking level */
  setThinkingLevel(level: ThinkingLevel): void;

  // ============================================================
  // Permission Mode
  // ============================================================

  /** Get current permission mode */
  getPermissionMode(): PermissionMode;

  /** Set permission mode */
  setPermissionMode(mode: PermissionMode): void;

  /** Apply the workspace sensitive-action policy to subsequent tool checks and prompts. */
  setExternalActionPolicy(policy: 'confirm' | 'allow-in-execute'): void;

  /** Cycle to next permission mode */
  cyclePermissionMode(): PermissionMode;

  // ============================================================
  // State
  // ============================================================

  /** Get SDK session ID (for resume, null if no session) */
  getSessionId(): string | null;

  /** Whether this backend supports session branching */
  readonly supportsBranching: boolean;

  // ============================================================
  // Source Management
  // ============================================================

  /**
   * Set the MCP server configurations for sources.
   * Called by facade when sources are activated/deactivated.
   *
   * @param mcpServers Pre-built MCP server configs with auth headers
   * @param apiServers In-process MCP servers for REST APIs
   * @param intendedSlugs Source slugs that should be considered active
   */
  setSourceServers(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, unknown>,
    intendedSlugs?: string[]
  ): void | Promise<void>;

  /** Last source-server configuration committed by this runtime. */
  getSourceServerSnapshot?(): SourceServerSnapshot;

  /**
   * Get currently active source slugs.
   */
  getActiveSourceSlugs(): string[];

  /**
   * Get the raw user message for the current turn (cleared between turns).
   * Used by SessionManager.activateSourceInSessionFn to capture the message
   * that should be re-sent after a source_test-triggered auto-restart.
   */
  getCurrentTurnUserMessage(): string | null;

  /**
   * Schedule a source-activation auto-restart. Consumed by the backend's
   * event loop after the next tool_result, which yields `source_activated`
   * and `forceAbort`s the turn. SessionManager's `source_activated` handler
   * then schedules the server-side resend with a "[{slug} activated]" suffix
   * (craft-agents-oss#804). Set by SessionManager after a successful mid-turn
   * activation (source_test auto-enable).
   */
  setPendingSourceActivationRestart(pending: { sourceSlug: string; userMessage: string }): void;

  /**
   * Get all sources (for context injection).
   */
  getAllSources(): LoadedSource[];

  /**
   * Set all sources (for context injection).
   */
  setAllSources(sources: LoadedSource[]): void;

  /**
   * Mark a source as unseen (will show introduction text again).
   */
  markSourceUnseen(sourceSlug: string): void;

  /**
   * Get a bound summarize callback for passing to API tool builders.
   */
  getSummarizeCallback(): (prompt: string) => Promise<string | null>;

  // ============================================================
  // Session & Workspace State
  // ============================================================

  /** Update the working directory */
  updateWorkingDirectory(path: string): void;

  /** Update the SDK cwd (transcript storage location) */
  updateSdkCwd(path: string): void;

  /** Set workspace configuration */
  setWorkspace(workspace: Workspace): void;

  /** Set session ID */
  setSessionId(sessionId: string | null): void;

  /** Get SourceManager for advanced queries */
  getSourceManager(): SourceManager;

  /** Generate a session title from user message */
  generateTitle(message: string, options?: { language?: string }): Promise<string | null>;

  /** Regenerate a session title from recent conversation */
  regenerateTitle(recentUserMessages: string[], lastAssistantResponse: string, options?: { language?: string }): Promise<string | null>;

  // ============================================================
  // Permission Resolution
  // ============================================================

  /**
   * Respond to a pending permission request.
   *
   * @param requestId - Permission request ID
   * @param allowed - Whether permission was granted
   * @param alwaysAllow - Whether to remember this permission for session
   */
  respondToPermission(requestId: string, allowed: boolean, alwaysAllow?: boolean): void;

  // ============================================================
  // Callbacks (set by facade after construction)
  // ============================================================

  /** Called when a tool requires permission */
  onPermissionRequest: PermissionCallback | null;

  /** Called when agent submits a plan */
  onPlanSubmitted: PlanCallback | null;

  /** Called when a source requires authentication */
  onAuthRequest: AuthCallback | null;

  /** Called when a source config changes */
  onSourceChange: SourceChangeCallback | null;

  /** Called when permission mode changes */
  onPermissionModeChange: ((mode: PermissionMode) => void) | null;

  /** Called with debug messages */
  onDebug: ((message: string) => void) | null;

  /** Called when a source tool is used but source isn't active */
  onSourceActivationRequest: SourceActivationCallback | null;

  /**
   * Called when backend-specific authentication is required.
   * Replaces per-backend callbacks (onChatGptAuthRequired, onGithubAuthRequired).
   * The session layer wires this to surface auth warnings in the UI.
   */
  onBackendAuthRequired: ((reason: string) => void) | null;

  /** Called when agent requests spawning a new session */
  onSpawnSession: ((request: import("../../base-agent.ts").SpawnSessionRequest) => Promise<import("../../base-agent.ts").SpawnSessionResult>) | null;

  /**
   * Called synchronously at the backend's non-replay boundary for this prompt.
   *
   * This is deliberately separate from the AgentEvent stream: a backend may
   * emit local preparation events before its provider runtime accepts any work.
   * The boundary is the strongest acknowledgement exposed by that runtime; it
   * does not necessarily prove that a remote HTTP request reached the provider.
   */
  onProviderHandoff: (() => void) | null;

  /**
   * Awaited immediately before the backend makes a prompt visible to its
   * provider runtime. The host uses it to fsync an exact write-ahead fence;
   * rejection must prevent the provider write.
   */
  onBeforeProviderDispatch?: (() => Promise<void>) | null;

  /** Correlated proof that the exact prepared prompt was rejected pre-provider. */
  onProviderDispatchRejected?: (() => void) | null;

  /**
   * Optional conservative fence for out-of-process backends. It fires after
   * the prompt has left the host process but before the child can report the
   * authoritative provider handoff. Stop must not replay work in this window;
   * a later explicit setup rejection may still roll it back normally.
   */
  onProviderDispatchUncertain?: (() => void) | null;
}
