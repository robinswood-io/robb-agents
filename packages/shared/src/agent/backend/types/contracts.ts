import type { ThinkingLevel } from "../../thinking-levels.ts";
import type { LoadedSource } from "../../../sources/types.ts";
import type { AuthRequest } from "../../session-scoped-tools.ts";
import type { ModelProvider } from "../../../config/models.ts";
// Import LLM connection types for auth
import type { LlmAuthType, LlmProviderType } from "../../../config/llm-connections.ts";

/** A host-authored, payload-free admission explanation that backends may show
 * to the model. Arbitrary storage/runtime exceptions must remain generic. */
export class ToolAdmissionRecoveryError extends Error {
  constructor(readonly safeReason: string) {
    super(safeReason);
    this.name = 'ToolAdmissionRecoveryError';
  }
}

/** Definitive local rejection before a provider/runtime accepted the prompt. */
export class ProviderDispatchRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderDispatchRejectedError';
  }
}

export interface BackendRuntimeUpdate {
  model: string;
  providerType?: LlmProviderType;
  authType?: LlmAuthType;
  runtime?: {
    baseUrl?: string;
    piAuthProvider?: string;
    customEndpoint?: { api: string; supportsImages?: boolean };
    customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean; supportsThinking?: boolean; maxTokens?: number }>;
    [key: string]: unknown;
  };
}

/**
 * Provider identifier for AI backends.
 * @deprecated Use ModelProvider from config/models.ts instead
 */
export type AgentProvider = ModelProvider;

/**
 * Host-computed capabilities for a receipt-only terminal reconciliation.
 * Presence of this policy is itself the fail-closed lock: a backend may run
 * only the explicitly listed operations, and must not infer additions from
 * prompt text, tool metadata, permission mode, or a provider's read hint.
 */
export interface TerminalReconciliationPolicy {
  /** Missing/invalid objective contexts reuse the same empty fail-closed capability envelope. */
  kind: 'terminal-reconciliation' | 'missing-objective' | 'invalid-lineage';
  allowInitialCriteriaRegistration: boolean;
  allowReviewerSpawn: boolean;
  /** Exact JSON inputs of current objective-scoped read observations. */
  readReplays: ReadonlyArray<{ toolName: string; toolInputJson: string }>;
  /** Direct terminal reviewers bound to the current objective + acceptance SHA. */
  waitReviewerSessionIds: readonly string[];
  /**
   * Host-only key for deriving one exact invocation capability after every
   * PreToolUse gate has passed. It is never accepted directly from model
   * input and is not the capability returned to the tool handler.
   */
  invocationCapabilityKey?: string;
}

// ============================================================
// Callback Types
// ============================================================

/**
 * Permission prompt types for different tool categories.
 */
export type PermissionRequestType = 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';

/**
 * Permission request callback signature.
 * Called when a tool requires user permission before execution.
 */
export type PermissionCallback = (request: {
  requestId: string;
  toolName: string;
  /** Exact provider tool call blocked by this pre-execution permission gate. */
  toolUseId?: string;
  command?: string;
  description: string;
  type?: PermissionRequestType;
  appName?: string;
  reason?: string;
  impact?: string;
  requiresSystemPrompt?: boolean;
  rememberForMinutes?: number;
  commandHash?: string;
  approvalTtlSeconds?: number;
  sensitiveActionCategory?: import("../../core/sensitive-external-action.ts").SensitiveExternalActionCategory;
  sensitiveActionTargets?: string[];
  sensitiveActionOperationHash?: string;
}) => void;

/**
 * Plan submission callback signature.
 * Called when agent submits a plan for user review.
 */
export type PlanCallback = (planPath: string) => void;

/**
 * Auth request callback signature.
 * Called when a source requires authentication.
 */
export type AuthCallback = (request: AuthRequest) => void;

/**
 * Source change callback signature.
 * Called when a source is activated, deactivated, or modified.
 */
export type SourceChangeCallback = (slug: string, source: LoadedSource | null) => void;

/**
 * Source activation request callback.
 * Returns true if source was successfully activated.
 */
export type SourceActivationCallback = (sourceSlug: string) => Promise<boolean>;

// ============================================================
// Lifecycle Types
// ============================================================

/**
 * Result of backend post-initialization (auth injection, config setup).
 * Returned by postInit() so the session layer can surface warnings.
 */
export interface PostInitResult {
  /** Whether auth credentials were successfully injected */
  authInjected: boolean;
  /** Optional warning message to surface in UI */
  authWarning?: string;
  /** Severity level for the warning */
  authWarningLevel?: 'error' | 'warning' | 'info';
}

/** In-memory snapshot used to restore the exact source runtime when a
 * mid-turn activation loses its objective/generation ownership while an
 * asynchronous pool update is in flight. Values are deliberately retained by
 * reference because API server instances are not structured-cloneable. */
export interface SourceServerSnapshot {
  mcpServers: Record<string, SdkMcpServerConfig>;
  apiServers: Record<string, unknown>;
  intendedSlugs: string[];
}

/**
 * Host runtime context passed from the application shell (Electron/CLI/etc.).
 * This is intentionally provider-agnostic metadata; backend drivers resolve
 * provider-specific paths from this context internally.
 */
export interface BackendHostRuntimeContext {
  /** App root path (packaged app path or repository root in development) */
  appRootPath: string;
  /** Optional resources path for packaged runtime compatibility fallbacks */
  resourcesPath?: string;
  /** Whether the host app is running as a packaged build */
  isPackaged: boolean;
  /** Optional runtime override for Node/Bun executable */
  nodeRuntimePath?: string;
  /** Optional interceptor bundle override (CJS bundle loaded via --require) */
  interceptorBundlePath?: string;
}

// ============================================================
// Backend Interface
// ============================================================

/**
 * Options for the chat method.
 */
export interface ChatOptions {
  /** Retry flag (internal use for session recovery) */
  isRetry?: boolean;
  /** Override thinking level for this message only */
  thinkingOverride?: ThinkingLevel;
}

/**
 * SDK-compatible MCP server configuration.
 * Supports HTTP/SSE (remote) and stdio (local subprocess) transports.
 */
export type SdkMcpServerConfig =
  | {
      type: 'http' | 'sse';
      url: string;
      headers?: Record<string, string>;
      /** Environment variable name containing bearer token (Codex-specific) */
      bearerTokenEnvVar?: string;
    }
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      /** Environment variables to set (literal values) */
      env?: Record<string, string>;
      /** Environment variable names to forward from parent process (Codex-specific) */
      envVars?: string[];
      /** Working directory for the server process (Codex-specific) */
      cwd?: string;
    };
