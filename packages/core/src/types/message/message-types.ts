
/**
 * Message types for conversations
 */

/**
 * Message roles for display (runtime)
 */
export type MessageRole =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'error'
  | 'status'
  | 'info'
  | 'warning'
  | 'plan'
  | 'auth-request';

/**
 * Credential input modes for different auth types
 */
export type CredentialInputMode =
  | 'bearer'       // Single token field (Bearer Token, API Key)
  | 'basic'        // Username + Password fields
  | 'header'       // API Key with custom header name
  | 'query'        // API Key for query parameter
  | 'multi-header';

// Multiple header fields

/**
 * Auth request types
 */
export type AuthRequestType =
  | 'credential'
  | 'oauth'
  | 'oauth-google'
  | 'oauth-slack'
  | 'oauth-microsoft';

/**
 * Auth request status
 */
export type AuthStatus = 'pending' | 'completed' | 'cancelled' | 'failed';

/**
 * Tool execution status
 */
export type ToolStatus = 'pending' | 'executing' | 'completed' | 'error' | 'backgrounded';

/**
 * Host-authored explanation for a tool result that closed without executing
 * the requested operation. Optional fields on events/messages keep sessions
 * written by older app versions readable.
 */
export interface ToolExecutionCheckpoint {
  schemaVersion: 1;
  kind: 'tool-call-budget';
  reason: string;
}

export type ObjectiveOutcomeState =
  | 'complete_verified'
  | 'blocked_human'
  | 'blocked_policy'
  | 'continue';

export type ObjectiveOutcomeBlockerKind =
  | 'credential'
  | 'mfa'
  | 'external_authorization'
  | 'irreversible_authority'
  | 'business_decision'
  | 'policy';

/** Structured, model-authored outcome subsequently verified by the host. */
export interface ObjectiveOutcomeDeclaration {
  state: ObjectiveOutcomeState;
  criteria: Array<{
    id: string;
    satisfied: boolean;
    evidence: string[];
  }>;
  remainingWork: string[];
  blocker?: {
    kind: ObjectiveOutcomeBlockerKind;
    description: string;
    evidence: string[];
  } | null;
}

/**
 * Tool display metadata - embedded at storage time for viewer compatibility
 * Icons are base64-encoded to work in both Electron and web viewer
 */
export interface ToolDisplayMeta {
  /** Display name for the tool (e.g., "Commit", "Linear") */
  displayName: string;
  /** Base64-encoded icon as data URL (e.g., "data:image/png;base64,...") - 32x32px */
  iconDataUrl?: string;
  /** Description of what this tool does */
  description?: string;
  /** Category for grouping/styling */
  category?: 'skill' | 'source' | 'native' | 'mcp';
}

/**
 * Token usage tracking
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  costUsd: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/**
 * Recovery action for typed errors
 */
export interface RecoveryAction {
  /** Keyboard shortcut (single letter) */
  key: string;
  /** Description of the action */
  label: string;
  /** Slash command to execute (e.g., '/settings') */
  command?: string;
  /** Custom action type for special handling */
  action?: 'retry' | 'settings' | 'reauth' | 'open_url' | 'reconnect_source' | 'reconnect_runtime';
  /** URL to open (for open_url action) */
  url?: string;
  /** Source slug (for reconnect_source action) */
  sourceSlug?: string;
}

/**
 * Error codes for typed errors - must match AgentError.code in shared/agent/errors.ts
 */
export type ErrorCode =
  | 'invalid_api_key'
  | 'invalid_credentials'
  | 'response_too_large'
  | 'expired_oauth_token'
  | 'token_expired'
  | 'rate_limited'
  | 'service_error'
  | 'service_unavailable'
  | 'network_error'
  | 'proxy_error'           // Proxy/firewall/captive portal intercepted the request
  | 'mcp_auth_required'
  | 'mcp_unreachable'
  | 'billing_error'
  | 'model_no_tool_support'  // Model doesn't support tool/function calling
  | 'invalid_model'          // Model ID not found
  | 'data_policy_error'      // OpenRouter data policy restriction
  | 'invalid_request'        // API rejected the request (e.g., bad image, invalid content)
  | 'image_too_large'        // Image exceeds API dimension/size limits
  | 'provider_error'         // AI provider experiencing issues (overloaded, unavailable)
  | 'queued_message_replay_failed'  // A message queued during an active turn could not be auto-replayed (#616)
  | 'sdk_binary_missing'     // SDK subprocess binary not present on disk (incomplete bundle)
  | 'sdk_cwd_missing'        // SDK subprocess cwd not present on disk (stale cross-machine import)
  | 'execution_bridge_unavailable' // Local execution/tool bridge unavailable or corrupted
  | 'objective_validation_failed' // Completion contract rejected after bounded recovery
  | 'unknown_error';

/**
 * Typed error from agent
 */
export interface TypedError {
  /** Error code for programmatic handling */
  code: ErrorCode;
  /** User-friendly title */
  title: string;
  /** Detailed message explaining what went wrong */
  message: string;
  /** Suggested recovery actions */
  actions: RecoveryAction[];
  /** Whether auto-retry is possible */
  canRetry: boolean;
  /** Retry delay in ms (if canRetry is true) */
  retryDelayMs?: number;
  /** Diagnostic check results for debugging */
  details?: string[];
  /** Original error message for debugging */
  originalError?: string;
}

/**
 * Permission request type categories
 */
export type PermissionRequestType = 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';

/**
 * Permission request from agent (e.g., bash command approval)
 */
export interface PermissionRequest {
  requestId: string;
  toolName: string;
  /** Exact provider tool call blocked by this pre-execution permission gate. */
  toolUseId?: string;
  command?: string;  // Optional: bash commands have it, MCP tools may not
  description: string;
  type?: PermissionRequestType;  // Type of permission request
  /** Friendly app/package label for admin approval prompts */
  appName?: string;
  /** Plain-language reason shown in admin approval prompt */
  reason?: string;
  /** Plain-language impact shown in admin approval prompt */
  impact?: string;
  /** Whether native OS auth prompt is expected */
  requiresSystemPrompt?: boolean;
  /** Optional remember window for this exact command */
  rememberForMinutes?: number;
  /** Hash binding for approval integrity checks */
  commandHash?: string;
  /** Approval validity window */
  approvalTtlSeconds?: number;
  /** Scoped metadata for a sensitive external-action confirmation. */
  sensitiveActionCategory?: 'git_push' | 'deployment' | 'service_restart' | 'secret_transfer' | 'external_send' | 'external_publication' | 'external_mutation' | 'payment';
  sensitiveActionTargets?: string[];
  /** Hash binding this approval to the exact tool input without exposing it. */
  sensitiveActionOperationHash?: string;
}

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
  // These IDs also enter permission checks; never fall back to Math.random.
  // getRandomValues keeps this shared package usable in browser and server runtimes.
  // Core deliberately has no DOM/Node ambient types; describe only this standard API.
  const webCrypto = (globalThis as typeof globalThis & {
    crypto: { getRandomValues(bytes: Uint8Array): Uint8Array };
  }).crypto;
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  const randomPart = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `msg-${Date.now()}-${randomPart}`;
}

/** Persisted alongside internal messages so recovery preserves their origin. */
export interface InternalMessageOrigin {
  /** `source-activation` is a host-authenticated same-objective restart; its
   * prompt text is transport and never independent user authority. */
  kind: 'agent-message' | 'auth-result' | 'auth-retry' | 'browser-fallback' | 'source-activation' | 'spawned-session' | 'automation' | 'user-input';
  /** Host-only durable binding for a source-activation continuation. RPC
   * callers cannot supply InternalMessageOrigin at all. */
  objectiveId?: string;
  /** Most recent direct-user revision accepted into the bound objective. */
  objectiveRevision?: string;
  /** Source and host nonce that minted a durable source-activation restart. */
  sourceSlug?: string;
  sourceActivationId?: string;
  senderSessionId?: string;
  deliveryId?: string;
  attachmentsSha256?: string;
  /** Typed delivery semantics supplied by the session tool and persisted by the host. */
  agentMessageType?: 'progress' | 'result' | 'question' | 'decision';
  /** Host-authored semantic Task assignment, excluding execution/retry scaffolding. */
  authenticatedTaskText?: string;
}
