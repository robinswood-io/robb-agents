import type { ThinkingLevel } from "../../thinking-levels.ts";
import type { LoadedSource } from "../../../sources/types.ts";
import type { McpClientPool } from "../../../mcp/mcp-pool.ts";
import type { Workspace } from "../../../config/storage.ts";
import type { SessionConfig as Session } from "../../../sessions/storage.ts";
import type { MissionCapabilityLock } from "../../../sessions/types.ts";
// Import AbortReason and RecoveryMessage from core module (single source of truth)
import { type RecoveryMessage } from "../../core/index.ts";
// Import LLM connection types for auth
import type { LlmAuthType, LlmConnection, LlmProviderType } from "../../../config/llm-connections.ts";
import type { AutomationSystem } from "../../../automations/index.ts";
import type { AgentProvider, SdkMcpServerConfig, TerminalReconciliationPolicy } from './contracts.ts';

/**
 * Provider-agnostic backend configuration used by the session layer.
 * Provider-specific runtime details are resolved by backend drivers internally.
 */
export interface CoreBackendConfig {
  /** Workspace configuration */
  workspace: Workspace;

  /** Session configuration (for resume) */
  session?: Session;

  /** Initial model ID */
  model?: string;

  /** Utility model for title/icon metadata generation only */
  miniModel?: string;

  /** Initial thinking level */
  thinkingLevel?: ThinkingLevel;

  /** Live workspace master switch. The callback is host-owned so an existing
   * runtime observes an UI toggle before any nested model request. */


  /** Live session-owned manual model authority. Automatic routing may
   * substitute a model only while this getter returns false. */
  isModelRoutePinned?: () => boolean;

  /** Headless mode flag (disables interactive tools) */
  isHeadless?: boolean;

  /**
   * Confirmation policy for sensitive external actions. Defaults to `confirm`.
   * `allow-in-execute` only takes effect when the session's effective permission
   * mode is `allow-all`; Explore and Ask retain their existing safeguards.
   */
  externalActionPolicy?: 'confirm' | 'allow-in-execute';
  /** Host-owned live interaction policy; inheritance never grants tool rights. */
  getHumanInputAllowed?: () => boolean;

  /** Dynamic host-owned objective authority. False means the current accepted
   * objective is observational/response-only. Segments are authenticated human
   * scope and bind sensitive external actions to an explicit action + target. */
  getObjectiveMutationAuthority?: (currentUserRequest?: string) => boolean | {
    // Undefined delegates the decision to authenticated segments on ordinary chats.
    authorized: boolean | undefined;
    sensitiveActionAuthorized: boolean | undefined;
    authorizationSegments: readonly string[];
    /** Structured-answer authority carried on a host-only provenance channel. */
    authenticatedUserAuthorizationSegments?: readonly string[];
    /** Host-owned receipt-reconciliation lock and its complete positive allowlist. */
    terminalReconciliationPolicy?: TerminalReconciliationPolicy;
  } | undefined;

  /**
   * Host-owned durability barrier for one exact tool execution. Backends must
   * await this callback after their permission checks but before acknowledging
   * PreToolUse to the SDK/subprocess. A rejection means the tool must not run.
   */
  beforeToolExecution?: (request: {
    toolUseId?: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  }) => Promise<void>;

  /** Host fence checked immediately before a provider turn is dispatched. */
  beforeProviderExecution?: () => Promise<void>;

  /**
   * Immutable connection/config snapshot used by a governed Mission runtime.
   * Backends must not re-resolve a mutable connection when this is present.
   */
  sealedLlmConnection?: LlmConnection;

  /** Opaque host credential generation certified by the route lock. */
  expectedLlmCredentialBindingId?: string;

  /** Host-only exact capability lease for specialized Mission runtimes. */
  missionCapabilityLock?: MissionCapabilityLock;

  /** Complete host-sealed skill packages consumed inline by governed turns. */
  sealedSkillPackages?: ReadonlyArray<{
    slug: string;
    name: string;
    content: string;
  }>;

  /** Skip agent-level config file watching (server already owns a workspace-level watcher) */
  skipConfigWatcher?: boolean;

  /** Debug mode configuration */
  debugMode?: {
    enabled: boolean;
    logFilePath?: string;
  };

  /** System prompt preset ('default' | 'mini' | custom string) */
  systemPromptPreset?: 'default' | 'mini' | string;

  /** Workspace-level automation system for user-defined automations (automations.json) */
  automationSystem?: AutomationSystem;

  /**
   * Per-session environment variable overrides for the SDK subprocess.
   * Layered after the backend's inherited/restricted environment in
   * backend-specific option builders.
   */
  envOverrides?: Record<string, string>;

  /**
   * Centralized MCP client pool for source tool execution.
   * Owns all MCP source connections in the main process.
   */
  mcpPool?: McpClientPool;

  /**
   * URL of the McpPoolServer HTTP endpoint for this session.
   * External SDK subprocesses connect here to access pool-managed MCP tools.
   */
  poolServerUrl?: string;

  /** Callback when SDK session ID is captured/updated */
  onSdkSessionIdUpdate?: (sdkSessionId: string) => void;

  /** Callback when SDK session ID is cleared (e.g., after failed resume) */
  onSdkSessionIdCleared?: () => void;

  /**
   * Called when the agent decides the persisted branch-fork metadata
   * (branchFromSdkSessionId / branchFromSdkCwd / branchFromSdkTurnId) is
   * unrecoverable on this machine — typically because the parent's sdk cwd
   * doesn't exist locally (cross-machine session import) or the SDK fork
   * spawn failed before establishing a child session.
   *
   * Implementations MUST clear all four fields (including sdkSessionId)
   * atomically and persist. `onSdkSessionIdCleared` is insufficient because
   * it only clears sdkSessionId — branch fields would reload from disk
   * on next launch and re-trigger the failure.
   */
  onBranchForkInvalidated?: () => void;

  /** Callback to get recent messages for recovery context */
  getRecoveryMessages?: () => RecoveryMessage[];

  /**
   * Get ALL parent messages for branch fork fallback (not limited to 6).
   * Called when SDK-level branch fork fails and we need to summarize
   * the parent conversation for context injection via mini completion.
   * Returns empty array for non-branched sessions.
   */
  getBranchFallbackMessages?: () => RecoveryMessage[];

  /**
   * Callback to get branch seed messages (up to branch cutoff) for first turn in seeded branch mode.
   * When provided and non-empty, BaseAgent injects a hidden context block before the first user turn.
   */
  getBranchSeedMessages?: () => RecoveryMessage[];

  /** Callback invoked after branch seed context has been injected. */
  markBranchSeedApplied?: () => void;

  /** One-shot hidden summary to inject on the first turn of a transferred session. */
  getTransferredSessionSummary?: () => string | null;

  /** Callback invoked after transferred session summary has been injected. */
  markTransferredSessionSummaryApplied?: () => void;

  /**
   * Optional callback to resize an oversized image for API compatibility.
   * Called from PreToolUse when Read targets an image exceeding the base64 size limit.
   * Returns path to the resized temp file, or null if resize not possible.
   * Provided by the host app (Electron uses nativeImage, server could use sharp, etc.).
   */
  onImageResize?: (filePath: string, maxSizeBytes: number) => Promise<string | null>;

  /** Enable 1M context window for current Opus models. Default: true. Set false to use 200K and conserve usage limits. */
  enable1MContext?: boolean;

  /**
   * Pre-computed source configurations for initial setup.
   * Passed at construction so backends can set up sources in postInit().
   */
  initialSources?: {
    enabledSources: LoadedSource[];
    mcpServers: Record<string, SdkMcpServerConfig>;
    apiServers: Record<string, unknown>;
    enabledSlugs: string[];
  };
}

/**
 * Configuration for creating a backend.
 */
export interface BackendConfig extends CoreBackendConfig {
  /**
   * Provider/SDK to use for this backend.
   * Determines which agent class is instantiated:
   * - 'anthropic' → ClaudeAgent (Anthropic SDK)
   * - 'pi' → PiAgent (Pi via @earendil-works/pi-coding-agent)
   */
  provider: AgentProvider;

  /**
   * Full provider type from LLM connection.
   * Includes compat variants and cloud providers.
   * Used for routing validation, credential lookup, etc.
   */
  providerType?: LlmProviderType;

  /**
   * Authentication mechanism from LLM connection.
   * Determines how credentials are retrieved and passed to the backend.
   */
  authType?: LlmAuthType;

  /**
   * @deprecated Use authType instead. Kept for backwards compatibility.
   */
  legacyAuthType?: 'api_key' | 'oauth_token';

  /** MCP token override (for testing) */
  mcpToken?: string;

  /**
   * Connection slug for credential routing.
   * Set by factory when creating from a connection.
   * Used to read/write credentials under the correct key.
   */
  connectionSlug?: string;

  /** Workspace-level automation system for user-defined SDK hooks (automations.json) */
  automationSystem?: AutomationSystem;

  /**
   * Opaque runtime payload resolved by backend drivers.
   * This keeps provider-specific runtime details out of the public config surface.
   */
  runtime?: Record<string, unknown>;
}
