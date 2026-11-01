import type { AnnotationV1, ContentBadge, StoredAttachment } from './content-types.ts';
import type { AuthRequestType, AuthStatus, CredentialInputMode, InternalMessageOrigin, MessageRole, ObjectiveOutcomeDeclaration, ToolDisplayMeta, ToolExecutionCheckpoint, ToolStatus } from './message-types.ts';
import type { RoutingMeta } from './routing.ts';

/**
 * Runtime message type (includes transient fields like isStreaming)
 */
export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  // Tool-specific fields
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  toolStatus?: ToolStatus;
  /** False when the host returned a checkpoint before invoking the tool. */
  toolExecuted?: boolean;
  /** Structured reason associated with a non-executed tool result. */
  toolCheckpoint?: ToolExecutionCheckpoint;
  toolDuration?: number;
  toolIntent?: string;
  toolDisplayName?: string;
  /** Tool display metadata with base64 icon - embedded at storage time for viewer */
  toolDisplayMeta?: ToolDisplayMeta;
  // Parent tool ID for nested tool calls (e.g., child tools inside Task subagent)
  parentToolUseId?: string;
  // Background task fields
  taskId?: string;          // For Task with run_in_background
  shellId?: string;         // For Bash with run_in_background
  elapsedSeconds?: number;  // Live progress updates
  isBackground?: boolean;   // Flag for UI differentiation
  // Stored attachments for user messages (persistent, no base64)
  attachments?: StoredAttachment[];
  // Content badges for inline display (sources, skills)
  badges?: ContentBadge[];
  /** Annotation payloads for this message */
  annotations?: AnnotationV1[];
  isError?: boolean;
  isStreaming?: boolean;
  // Pending: streaming text where we don't yet know if it's intermediate
  // Set to true when text_delta creates message, false when text_complete arrives
  // Also used for optimistic user messages before backend confirmation
  isPending?: boolean | undefined;
  // Queued: user message that is waiting to be processed (sent during ongoing response)
  isQueued?: boolean;
  /** Durable transport provenance; this never grants user authority. */
  internalOrigin?: InternalMessageOrigin;
  /**
   * Durable write-ahead fence recorded before this exact turn is handed to a
   * provider runtime.  Its presence means the runtime may have accepted the
   * turn, but the host did not durably observe the correlated acknowledgement.
   * It is evidence against automatic replay, never authority to start work.
   */
  providerDispatch?: ProviderDispatchWriteAhead;
  agentDelivery?: {
    id: string;
    status: 'queued' | 'processing' | 'processed' | 'failed';
    /** Provider handoffs, not runtime construction attempts. */
    attempts: number;
    attachmentsSha256?: string;
    /** Durable bounded setup backoff before any provider handoff. */
    setupFailureCount?: number;
    lastSetupFailureClass?: string;
    setupRetryNotBefore?: number;
    setupRetryBlockedAt?: number;
    setupPersistenceFencedAt?: number;
    /** Stop won after host-to-child dispatch but before the correlated child ACK. */
    providerDispatchUncertainAt?: number;
  };

  // Intermediate text (commentary between tool calls, not final response)
  isIntermediate?: boolean;
  // Hidden: a system-generated message that must reach the model (it drives a
  // turn) but must NOT render as a bubble in the transcript — e.g. the WS2
  // background-task-completion nudge that wakes an idle session to present a
  // finished background agent's result. Filtered out in groupMessagesByTurn so
  // it never appears as a user/assistant bubble (desktop + viewer).
  hidden?: boolean;
  // Turn ID: Correlation ID from the API's message.id, groups all messages in an assistant turn
  turnId?: string;
  // Status type for special status messages (e.g., compacting)
  statusType?: 'compacting' | 'compaction_complete';
  /** Provider/model routing audit metadata for assistant messages. */
  routingMeta?: RoutingMeta;
  /** Model-declared objective outcome; the host validates it before changing objective state. */
  objectiveOutcome?: ObjectiveOutcomeDeclaration;
  /** Host extraction failure retained for crash-safe continuation diagnostics. */
  objectiveOutcomeError?: string;
  // Info level for info messages (determines icon/color)
  infoLevel?: 'info' | 'warning' | 'error' | 'success';
  // Error-specific fields (for typed errors with diagnostics)
  errorCode?: string;
  errorTitle?: string;
  errorDetails?: string[];
  errorOriginal?: string;
  errorCanRetry?: boolean;
  errorActions?: Array<{
    key: string;
    label: string;
    action?: 'retry' | 'settings' | 'reauth' | 'open_url' | 'reconnect_source' | 'reconnect_runtime';
    url?: string;
    sourceSlug?: string;
  }>;
  // Plan-specific fields (for role='plan')
  planPath?: string;  // Path to the plan markdown file
  // Auth-request-specific fields (for role='auth-request')
  authRequestId?: string;         // Unique ID for the auth request
  authRequestType?: AuthRequestType;
  authSourceSlug?: string;
  authSourceName?: string;
  authStatus?: AuthStatus;
  authCredentialMode?: CredentialInputMode;  // For credential requests
  authHeaderName?: string;        // For header auth - the header name
  authHeaderNames?: string[];     // For multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"])
  authLabels?: {                  // Custom field labels
    credential?: string;
    username?: string;
    password?: string;
  };
  authDescription?: string;       // Description/instructions
  authHint?: string;              // Hint about where to find credentials
  authSourceUrl?: string;         // Source URL for password manager domain matching (1Password)
  authPasswordRequired?: boolean; // For basic auth: whether password is required (default true)
  authError?: string;             // Error message if auth failed
  authEmail?: string;             // Authenticated email (for OAuth)
  authWorkspace?: string;         // Authenticated workspace (for Slack)
}

/**
 * Stored message format (persistence)
 * Excludes transient runtime-only fields (isStreaming, isPending)
 */
export interface StoredMessage {
  id: string;
  type: MessageRole;
  content: string;
  timestamp?: number;
  // Tool-specific fields
  toolName?: string;
  toolUseId?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  toolStatus?: ToolStatus;
  /** False when the host returned a checkpoint before invoking the tool. */
  toolExecuted?: boolean;
  /** Structured reason associated with a non-executed tool result. */
  toolCheckpoint?: ToolExecutionCheckpoint;
  toolDuration?: number;
  toolIntent?: string;
  toolDisplayName?: string;
  /** Tool display metadata with base64 icon - embedded at storage time for viewer */
  toolDisplayMeta?: ToolDisplayMeta;
  // Parent tool ID for nested tool calls (persisted for session restore)
  parentToolUseId?: string;
  // Background task fields (persisted)
  taskId?: string;
  shellId?: string;
  elapsedSeconds?: number;
  isBackground?: boolean;
  isError?: boolean;
  /** Stored attachments for user messages (persisted to disk) */
  attachments?: StoredAttachment[];
  /** Content badges for inline display (sources, skills) */
  badges?: ContentBadge[];
  /** Annotations persisted at message level */
  annotations?: AnnotationV1[];
  // Turn grouping - critical for TurnCard rendering after reload
  isIntermediate?: boolean;
  turnId?: string;
  // Status type for compaction messages (persisted for reload)
  statusType?: 'compacting' | 'compaction_complete';
  /** Provider/model routing audit metadata for assistant messages. */
  routingMeta?: RoutingMeta;
  /** Model-declared objective outcome; the host validates it before changing objective state. */
  objectiveOutcome?: ObjectiveOutcomeDeclaration;
  objectiveOutcomeError?: string;
  // Info level for info messages (persisted for reload)
  infoLevel?: 'info' | 'warning' | 'error' | 'success';
  // Error display fields
  errorCode?: string;
  errorTitle?: string;
  errorDetails?: string[];
  errorOriginal?: string;
  errorCanRetry?: boolean;
  errorActions?: Array<{
    key: string;
    label: string;
    action?: 'retry' | 'settings' | 'reauth' | 'open_url' | 'reconnect_source' | 'reconnect_runtime';
    url?: string;
    sourceSlug?: string;
  }>;
  // Plan-specific fields (for role='plan')
  planPath?: string;
  // Auth-request-specific fields (for role='auth-request')
  authRequestId?: string;
  authRequestType?: AuthRequestType;
  authSourceSlug?: string;
  authSourceName?: string;
  authStatus?: AuthStatus;
  authCredentialMode?: CredentialInputMode;
  authHeaderName?: string;
  authHeaderNames?: string[];
  authLabels?: {
    credential?: string;
    username?: string;
    password?: string;
  };
  authDescription?: string;
  authHint?: string;
  authSourceUrl?: string;
  authPasswordRequired?: boolean;
  authError?: string;
  authEmail?: string;
  authWorkspace?: string;
  // Queued: user message that is waiting to be processed (persisted for recovery)
  isQueued?: boolean;
  hidden?: boolean;
  /** Durable transport provenance; this never grants user authority. */
  internalOrigin?: InternalMessageOrigin;
  /** Durable provider-acceptance uncertainty fence. */
  providerDispatch?: ProviderDispatchWriteAhead;
  agentDelivery?: {
    id: string;
    status: 'queued' | 'processing' | 'processed' | 'failed';
    attempts: number;
    attachmentsSha256?: string;
    setupFailureCount?: number;
    lastSetupFailureClass?: string;
    setupRetryNotBefore?: number;
    setupRetryBlockedAt?: number;
    setupPersistenceFencedAt?: number;
    providerDispatchUncertainAt?: number;
  };

}

/** Exact durable identity for a provider dispatch crossing the non-replay seam. */
export interface ProviderDispatchWriteAhead {
  schemaVersion: 1;
  state: 'acceptance-unknown' | 'accepted' | 'retired-uncertain' | 'retired-accepted';
  messageId: string;
  objectiveId: string;
  objectiveUserMessageId: string;
  generation: number;
  cancellationEpoch: number;
  markedAt: number;
  /** Durable correlated provider-runtime acknowledgement. */
  acceptedAt?: number;
  /** Explicit user Stop observed while this possibly-consumed prompt was
   * fenced. Cold recovery must not turn that cancellation into new work; only
   * a later authenticated Retry may reconcile the receipt. */
  userStoppedAt?: number;
  /** Cold reconciliation retained evidence that an older prompt may have been
   * consumed, but a later authenticated human objective superseded it. */
  retiredAt?: number;
  retirementReason?: 'superseded-by-new-human-objective' | 'user-stop-after-provider-ack' | 'explicit-retry-reconciliation' | 'live-nonreplay-reconciliation';
}
