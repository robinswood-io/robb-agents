import type { Session, Message } from "../../../shared/types";
import { resolveObjectiveSessionStatus } from "../../utils/session-status";

/**
 * Session metadata for list display (lightweight, no messages)
 * Used by SessionList to avoid re-rendering on message changes
 */
export interface SessionMeta {
  id: string
  name?: string
  /** Preview of first user message (for title fallback) */
  preview?: string
  workspaceId: string
  lastMessageAt?: number
  isProcessing?: boolean
  hasPendingUserInput?: boolean
  hasPendingAuth?: boolean
  isFlagged?: boolean
  lastReadMessageId?: string
  workingDirectory?: string
  enabledSourceSlugs?: string[]
  /** Shared viewer URL (if shared via viewer) */
  sharedUrl?: string
  /** Shared session ID in viewer (for revoke) */
  sharedId?: string
  /** ID of the last final (non-intermediate) assistant message - for unread detection */
  lastFinalMessageId?: string
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean
  /** Labels for filtering (additive tags, many-per-session) */
  labels?: string[]
  /** Permission mode ('safe', 'ask', 'allow-all') — used by view expressions */
  permissionMode?: string
  /** Session status for filtering */
  sessionStatus?: string
  /** Host objective truth used to project a coherent terminal UI status. */
  activeObjective?: Session['activeObjective']
  pendingTurnRecovery?: Session['pendingTurnRecovery']
  /** Role/type of the last message (for badge display without loading messages) */
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  /** Whether an async operation is ongoing (sharing, updating share, revoking, title regeneration) */
  isAsyncOperationOngoing?: boolean
  /** @deprecated Use isAsyncOperationOngoing instead */
  isRegeneratingTitle?: boolean
  /** Model override for this session */
  model?: string
  /** Whether the model is an explicit user choice rather than Auto. */
  modelRoutePinned?: boolean
  /** LLM connection slug for this session */
  llmConnection?: string
  /** Token usage stats (from JSONL header, available without loading messages) */
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    costUsd: number
    contextTokens: number
  }
  /** When the session was created (ms timestamp) */
  createdAt?: number
  /** Total number of messages in this session */
  messageCount?: number
  /** When true, session is hidden from session list (e.g., mini edit sessions) */
  hidden?: boolean
  /** Whether this session is archived */
  isArchived?: boolean
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number
  /** Workspace-scoped project id this session is bound to (undefined = unbound) */
  projectId?: string
  /** Parent session id — when set, this session is a subtask of the parent (undefined = top-level task) */
  parentSessionId?: string
  /** Host-owned autonomous delegation lineage (fallback when direct lineage hydrates late). */
  delegation?: Session['delegation']
  /** Kanban board column id ('todo' | 'in-progress' | 'done'); independent of sessionStatus */
  kanbanColumn?: string
  /** Tasks Conductor: slug of the task spec this session belongs to (orchestrator + child nodes) */
  taskSlug?: string
  /** Tasks Conductor: id of the run that spawned this child session (Conductor-owned children only) */
  taskRunId?: string
  /** Tasks Conductor: id of the DAG node this child session executes (Conductor-owned children only) */
  taskNodeId?: string
  /** Tasks Conductor: total DAG node count (orchestrator only) — stable board progress denominator while children spawn lazily */
  taskNodeCount?: number
  /** Tasks Conductor: a generate-time draft orchestrator, hidden from the board until adopted by createTask. */
  taskDraft?: boolean
  /** Mission v2 internal child identity. */
  missionWorkItemId?: string
  missionRole?: Session['missionRole']
}

/**
 * Find the last final (non-intermediate) assistant or plan message ID
 */
export function findLastFinalMessageId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    // Include plan messages as final responses (they're AI-generated content)
    if ((msg.role === 'assistant' || msg.role === 'plan') && !msg.isIntermediate && !msg.isStreaming && !msg.isPending) {
      return msg.id
    }
  }
  return undefined
}

/**
 * Extract metadata from a full session object
 */
export function extractSessionMeta(session: Session): SessionMeta {
  const messages = session.messages || []

  // Destructure fields that don't exist on SessionMeta or need overrides
  const {
    messages: _msgs, sessionFolderPath: _sf, supportsBranching: _sb,
    pendingAuthRequestMessage: _pendingAuth, userInputRequests: _userInputRequests,
    workspaceName: _wn, thinkingLevel: _tl, currentStatus: _cs,
    isAsyncOperationOngoing, isRegeneratingTitle,
    messageCount, lastFinalMessageId: sessionLastFinal,
    ...sessionFields
  } = session

  return {
    ...sessionFields,
    // Objective state is the durable execution truth. Do not let a stale
    // lifecycle status render completed work as review-pending, or exhausted
    // work as still in progress.
    sessionStatus: resolveObjectiveSessionStatus(session),
    hasPendingUserInput: session.userInputRequests?.some(request => request.status === 'pending') ?? false,
    hasPendingAuth: !!session.pendingAuthRequestMessage,
    lastFinalMessageId: sessionLastFinal ?? findLastFinalMessageId(messages),
    // Math.max, not ??: streaming appends grow `messages` without touching the
    // session's `messageCount` field, so a defined-but-stale count (stamped at
    // load/creation) must never shadow the live length. Meta-only sessions
    // (empty `messages`) keep the server/header count.
    messageCount: Math.max(messageCount ?? 0, messages.length),
    isAsyncOperationOngoing: isAsyncOperationOngoing ?? isRegeneratingTitle,
    isRegeneratingTitle,
  } as SessionMeta
}
