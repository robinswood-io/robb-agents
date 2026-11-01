/**
 * Session Tools Core - Context Interface
 *
 * Defines the abstract context interface that both Claude (in-process)
 * and Codex (subprocess) implementations must provide.
 *
 * This enables writing tool handlers once and running them in both environments.
 */
import type { SourceConfig, GoogleService, SlackService, MicrosoftService } from "../types.ts";
import type { CredentialManagerInterface, FileSystemInterface, SessionToolCallbacks, ValidatorInterface } from './ports.ts';
import type { AgentMessageType, BackgroundTaskInfo, ListSessionsOptions, ListSessionsResult, ResolvedLabelsResult, ResolvedStatusResult, SendAgentMessageResult, SessionInfo, WaitSessionsMode, WaitSessionsResult } from './session-results.ts';
import type { ApiTestResult, HttpMcpConfig, McpValidationResult, StdioMcpConfig, StdioValidationResult } from './source-diagnostics.ts';

// ============================================================
// Session Tool Context
// ============================================================

/**
 * Main context interface for session tools.
 *
 * Both Claude and Codex create their own implementation of this interface:
 * - Claude: createClaudeContext() with direct access to Electron internals
 * - Codex: createCodexContext() with callback IPC and limited capabilities
 */
export interface SessionToolContext {
  // ============================================================
  // Session Info
  // ============================================================

  /** Unique session identifier */
  sessionId: string;

  /** Absolute path to workspace folder (~/.craft-agent/workspaces/{id}) */
  workspacePath: string;

  /** Path to sources folder within workspace */
  get sourcesPath(): string;

  /** Path to skills folder within workspace */
  get skillsPath(): string;

  /** Path to session's plans folder */
  plansFolderPath: string;

  /** Working directory (project root) for the session, if set */
  workingDirectory?: string;

  // ============================================================
  // Callbacks (transport-agnostic)
  // ============================================================

  callbacks: SessionToolCallbacks;

  // ============================================================
  // File System
  // ============================================================

  fs: FileSystemInterface;

  // ============================================================
  // Validators (optional - may use basic or full)
  // ============================================================

  validators?: ValidatorInterface;

  // ============================================================
  // Optional Capabilities
  // ============================================================

  /**
   * Get credential manager for source authentication checks.
   * Only available in Claude (has keychain access).
   */
  credentialManager?: CredentialManagerInterface;

  /**
   * Load a source config from the workspace.
   */
  loadSourceConfig(sourceSlug: string): SourceConfig | null;

  /**
   * Save a source config to the workspace.
   */
  saveSourceConfig?(source: SourceConfig): void;

  /**
   * Infer Google service from URL.
   */
  inferGoogleService?(url?: string): GoogleService | undefined;

  /**
   * Infer Slack service from URL.
   */
  inferSlackService?(url?: string): SlackService | undefined;

  /**
   * Infer Microsoft service from URL.
   */
  inferMicrosoftService?(url?: string): MicrosoftService | undefined;

  /**
   * Check if Google OAuth is configured.
   */
  isGoogleOAuthConfigured?(clientId?: string, clientSecret?: string): boolean;

  // ============================================================
  // Icon Management (for source_test)
  // ============================================================

  /**
   * Check if a value is a URL that can be used as an icon.
   */
  isIconUrl?(value: string): boolean;

  /**
   * Download an icon from URL to the source folder.
   * Returns the path to the cached icon, or null if download failed.
   */
  downloadSourceIcon?(sourceSlug: string, iconUrl: string): Promise<string | null>;

  /**
   * Derive a service URL from a source config (for favicon fetching).
   */
  deriveServiceUrl?(source: SourceConfig): string | null;

  /**
   * Get a high-quality logo URL from a service URL.
   */
  getHighQualityLogoUrl?(serviceUrl: string, slug: string): Promise<string | null>;

  /**
   * Download an icon to a specific destination path.
   */
  downloadIcon?(destPath: string, url: string, tag: string): Promise<string | null>;

  // ============================================================
  // MCP Connection Validation (for source_test)
  // ============================================================

  /**
   * Validate a stdio MCP connection by spawning the command.
   */
  validateStdioMcpConnection?(config: StdioMcpConfig): Promise<StdioValidationResult>;

  /**
   * Validate an HTTP/SSE MCP connection.
   */
  validateMcpConnection?(config: HttpMcpConfig): Promise<McpValidationResult>;

  // ============================================================
  // API Testing (for source_test)
  // ============================================================

  /**
   * Test an API source connection with full credential handling.
   */
  testApiSource?(source: SourceConfig): Promise<ApiTestResult>;

  /**
   * Test a Google source (OAuth token validation).
   */
  testGoogleSource?(source: SourceConfig): Promise<ApiTestResult>;

  // ============================================================
  // Preferences (for update_user_preferences)
  // ============================================================

  /**
   * Submit developer feedback. Injected by each backend:
   * - Claude: writes JSON files to ~/.craft-agent/feedback/
   * - Codex/Pi: could send over IPC or write directly
   */
  submitFeedback?(feedback: import("../types.ts").DeveloperFeedback): void;

  /**
   * Update user preferences. Injected by each backend:
   * - Claude: calls updatePreferences() from config/preferences.ts
   * - Codex/session-mcp-server: writes directly to preferences.json
   * - Pi: calls updatePreferences() from config/preferences.ts
   */
  updatePreferences?(updates: Record<string, unknown>): void;

  // ============================================================
  // Session Self-Management (for set_session_labels, etc.)
  // ============================================================

  /** Set labels on a session. Defaults to current session if no ID given. Injected by backend. */
  setSessionLabels?(sessionId: string | undefined, labels: string[]): void | Promise<void>;

  /** Set status on a session. Defaults to current session if no ID given. Injected by backend. */
  setSessionStatus?(sessionId: string | undefined, status: string): void | Promise<void>;

  /** Get detailed info about a session. Defaults to current session if no ID given. Injected by backend. */
  getSessionInfo?(sessionId?: string): SessionInfo | null;

  /** List sessions in the workspace with pagination. Injected by backend. */
  listSessions?(options?: ListSessionsOptions): ListSessionsResult;

  /** Wait for delegated sessions without polling. `mode` is part of the exact
   * host-authorized invocation and is therefore forwarded unchanged. */
  waitForSessions?(
    sessionIds: string[],
    timeoutMs?: number,
    afterCursors?: Record<string, string>,
    terminalCapability?: string,
    mode?: WaitSessionsMode,
  ): Promise<WaitSessionsResult>;

  /**
   * List background tasks (running + recently-terminal) for a session from the
   * main-process registry. Defaults to the current session if no ID given.
   * Injected by backend (SessionManager). Returns [] in backends that don't
   * track background tasks.
   */
  listBackgroundTasks?(sessionId?: string): BackgroundTaskInfo[];

  /** Resolve label display names to IDs against configured labels. Injected by backend. */
  resolveLabels?(labels: string[]): ResolvedLabelsResult;

  /** Resolve a status display name to its ID against configured statuses. Injected by backend. */
  resolveStatus?(status: string): ResolvedStatusResult;
  /** Strengthen the current objective; never grants tool permissions. */
  setCompletionCriteria?(criteria: import('@craft-agent/core/types').ObjectiveAcceptanceCriterion[], procedure?: import('@craft-agent/core/types').ObjectiveProcedureId, terminalCapability?: string): Promise<unknown>;
  /** Register questions with the host; resolves before the user answers. */
  requestUserInput?(questions: import('@craft-agent/core/types').UserInputQuestion[]): Promise<{ requestId: string; status: 'pending' }>;
  projectLearning?(request: import("../handlers/project-learning.ts").ProjectLearningArgs): Promise<unknown>;

  // ============================================================
  // Inter-Session Messaging
  // ============================================================

  /**
   * Send a message to another session. Injected by backend (SessionManager).
   * Resolves with how the message was received so the sender can give the model
   * a truthful ack (delivered immediately vs. queued behind a busy turn) instead
   * of an unconditional "message sent".
   */
  sendAgentMessage?(
    sessionId: string,
    message: string,
    attachments?: Array<{ path: string; name?: string }>,
    messageType?: AgentMessageType,
  ): Promise<SendAgentMessageResult>;

  /**
   * Activate a source in the running session: add to enabledSourceSlugs,
   * build its MCP/API servers, apply to the agent.
   *
   * Only available in backends that run alongside SessionManager (Claude in-process, Pi subprocess).
   * Codex and other backends leave this undefined — callers should degrade gracefully (restart required).
   *
   * `availability` is always `'next-turn'` when activation succeeds: both Claude SDK
   * (frozen `mcpServers` at `query()` start) and Pi (subprocess reloads proxy tools
   * on the next `handlePrompt`) require the current turn to end before new tools
   * are callable. The backend handles this via the existing source_activated + auto_retry
   * machinery — the current turn is aborted and the renderer resends the user's
   * original message with a `[{slug} activated]` suffix.
   */
  activateSourceInSession?(sourceSlug: string): Promise<{
    ok: boolean;
    reason?: string;
    availability?: 'next-turn';
  }>;

  // ============================================================
  // Messaging Gateway (for list/unbind messaging channels)
  // ============================================================

  /** Get messaging bindings for a session. Injected by backend when messaging is configured. */
  getMessagingBindings?(sessionId: string): Array<{
    platform: string;
    channelId: string;
    /** Telegram supergroup forum topic id; undefined for DMs / non-Telegram. */
    threadId?: number;
    channelName?: string;
    enabled: boolean;
  }>;

  /** Unbind messaging channels from a session. Returns count of removed bindings. */
  unbindMessagingChannel?(sessionId: string, platform?: string): number;

  // ============================================================
  // Session Paths (for transform_data / render_template)
  // ============================================================

  /**
   * Absolute path to the session directory.
   * Used by transform_data for resolving input files.
   */
  sessionPath?: string;

  /**
   * Absolute path to the session's data directory.
   * Used by transform_data and render_template for output files.
   */
  dataPath?: string;
}
