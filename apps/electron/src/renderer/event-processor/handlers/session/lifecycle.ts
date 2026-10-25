import { isAgentRuntimeActivity } from "@craft-agent/core/types";
/**
 * Session Event Handlers
 *
 * Handles complete, error, sources_changed, etc.
 * Pure functions that return new state - no side effects.
 */
import type { SessionState, ProcessResult, CompleteEvent, ErrorEvent, TypedErrorEvent, StatusEvent, InfoEvent, InterruptedEvent, Effect } from "../../types";
import type { Message } from "../../../../shared/types";
import { generateMessageId, appendMessage } from "../../helpers";
import { markSessionProcessingState } from "../../../lib/session-processing-state";

/**
 * Handle complete - agent loop finished
 *
 * Sets isProcessing: false, clears streaming state.
 * Also marks any running tools as complete (fail-safe).
 */
export function handleComplete(
  state: SessionState,
  event: CompleteEvent
): ProcessResult {
  const { session } = state

  // Fail-safe: mark any non-terminal tools as complete.
  // Catches 'executing' (normal) and 'backgrounded' (spurious — e.g. foreground Agent
  // whose result contained agentId:). Genuinely backgrounded tasks have isBackground=true
  // AND a taskId, so they're excluded — task_completed will finalize them.
  const TERMINAL_TOOL_STATUSES = new Set(['completed', 'error'])
  let updatedMessages = session.messages
  const hasRunningTools = session.messages.some(
    m => m.role === 'tool'
      && !TERMINAL_TOOL_STATUSES.has(m.toolStatus ?? '')
      && !(m.isBackground && m.taskId)  // Don't force-complete genuine background tasks
  )

  if (hasRunningTools) {
    updatedMessages = session.messages.map(m => {
      if (
        m.role === 'tool'
        && !TERMINAL_TOOL_STATUSES.has(m.toolStatus ?? '')
        && !(m.isBackground && m.taskId)
      ) {
        return { ...m, toolStatus: 'completed' as const, toolResult: m.toolResult ?? '' }
      }
      return m
    })
  }

  return {
    state: {
      session: {
        ...markSessionProcessingState(session),
        messages: updatedMessages,
        isProcessing: false,
        currentStatus: undefined,  // Clear any lingering status
        // Update tokenUsage from complete event (for real-time context counter updates)
        tokenUsage: event.tokenUsage ?? session.tokenUsage,
        // Update hasUnread flag from main process (state machine for NEW badge)
        // Only update if explicitly provided - undefined means "don't change"
        ...(event.hasUnread !== undefined && { hasUnread: event.hasUnread }),
      },
      streaming: null,
    },
    effects: [],
  }
}

/**
 * Handle error - simple error event
 */
export function handleError(
  state: SessionState,
  event: ErrorEvent
): ProcessResult {
  const { session } = state

  // Stop the activity indicator without inventing an execution receipt. A
  // transport failure does not tell us whether an external operation completed.
  const messagesWithFailedTools = session.messages.map(m =>
    m.role === 'tool' && m.toolResult === undefined && m.toolStatus !== 'completed' && m.toolStatus !== 'error'
      ? { ...m, toolStatus: 'error' as const, isError: true }
      : m
  )

  const errorMessage: Message = {
    id: generateMessageId(),
    role: 'error',
    content: event.error,
    timestamp: event.timestamp ?? Date.now(),
  }

  return {
    state: {
      session: {
        ...markSessionProcessingState(session),
        messages: [...messagesWithFailedTools, errorMessage],
        isProcessing: false,
        currentStatus: undefined,  // Clear any lingering status
      },
      streaming: null,
    },
    effects: [],
  }
}

/**
 * Handle typed_error - error with structured details
 */
export function handleTypedError(
  state: SessionState,
  event: TypedErrorEvent
): ProcessResult {
  const { session } = state

  // Preserve unknown execution/result state when only the transport failed.
  const messagesWithFailedTools = session.messages.map(m =>
    m.role === 'tool' && m.toolResult === undefined && m.toolStatus !== 'completed' && m.toolStatus !== 'error'
      ? { ...m, toolStatus: 'error' as const, isError: true }
      : m
  )

  const errorMessage: Message = {
    id: generateMessageId(),
    role: 'error',
    content: event.error.title
      ? `${event.error.title}: ${event.error.message}`
      : event.error.message,
    timestamp: event.timestamp ?? Date.now(),
    errorCode: event.error.code,
    errorTitle: event.error.title,
    errorDetails: event.error.details,
    errorOriginal: event.error.originalError,
    errorCanRetry: event.error.canRetry,
    errorActions: event.error.actions?.map(a => ({
      key: a.key,
      label: a.label,
      action: a.action,
      url: a.url,
      sourceSlug: a.sourceSlug,
    })),
  }

  return {
    state: {
      session: {
        ...markSessionProcessingState(session),
        messages: [...messagesWithFailedTools, errorMessage],
        isProcessing: false,
        currentStatus: undefined,  // Clear any lingering status
      },
      streaming: null,
    },
    effects: [],
  }
}

/**
 * Handle status - status message (e.g., compacting)
 * Stores on session for ProcessingIndicator AND appends as message for TurnCard activity
 */
export function handleStatus(
  state: SessionState,
  event: StatusEvent
): ProcessResult {
  const { session, streaming } = state
  const runtimePhase = isAgentRuntimeActivity(event.message)
  if (event.message === '') {
    return { state: { ...state, session: { ...session,
      messages: session.messages.filter(message => message.role !== 'status' || !isAgentRuntimeActivity(message.content)),
      currentStatus: isAgentRuntimeActivity(session.currentStatus?.message) ? undefined : session.currentStatus,
    } }, effects: [] }
  }
  if (runtimePhase && session.currentStatus?.message === event.message) {
    return { state: { ...state, session: { ...session } }, effects: [] }
  }
  const baseSession = runtimePhase ? { ...session, messages: session.messages.filter(message =>
    message.role !== 'status' || !isAgentRuntimeActivity(message.content)) } : session

  const statusMessage: Message = {
    id: generateMessageId(),
    role: 'status',
    content: event.message,
    timestamp: event.timestamp ?? Date.now(),
    statusType: event.statusType,
  }

  const updatedSession = appendMessage(baseSession, statusMessage)

  return {
    state: {
      session: {
        ...updatedSession,
        // Also store on session for ProcessingIndicator
        currentStatus: {
          message: event.message,
          statusType: event.statusType,
        },
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle info - info message (may update existing compacting message)
 */
export function handleInfo(
  state: SessionState,
  event: InfoEvent
): ProcessResult {
  const { session, streaming } = state

  // If this is a compaction complete, update the existing compacting message and clear currentStatus
  if (event.statusType === 'compaction_complete') {
    const updatedMessages = session.messages.map(m =>
      m.role === 'status' && m.statusType === 'compacting'
        ? { ...m, role: 'info' as const, content: event.message, statusType: 'compaction_complete' as const, infoLevel: event.level }
        : m
    )
    return {
      state: {
        session: {
          ...session,
          messages: updatedMessages,
          currentStatus: undefined,  // Clear status from ProcessingIndicator
        },
        streaming,
      },
      effects: [],
    }
  }

  // Otherwise, add as new info message
  const infoMessage: Message = {
    id: generateMessageId(),
    role: 'info',
    content: event.message,
    timestamp: event.timestamp ?? Date.now(),
    infoLevel: event.level,
  }

  return {
    state: {
      session: appendMessage(session, infoMessage),
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle interrupted - agent was interrupted.
 *
 * Two distinct shapes:
 * - **User-initiated stop** (`event.message` present): user clicked the Stop
 *   button. We render the "Response interrupted" notice, drop queued user
 *   bubbles, and restore their text to the input field so the user can edit
 *   and re-send.
 * - **Silent redirect** (`event.message` absent): the agent aborted internally
 *   so a new message could be processed. The backend's `processNextQueuedMessage`
 *   will auto-replay queued messages — we must NOT remove the queued bubbles
 *   nor restore them to the input, otherwise the user perceives a silent drop
 *   (#616).
 */
export function handleInterrupted(
  state: SessionState,
  event: InterruptedEvent
): ProcessResult {
  const { session } = state
  const effects: Effect[] = []
  const isUserInitiated = !!event.message

  // Clear transient streaming state (isPending, isStreaming) and mark running tools as interrupted
  // These fields are not persisted, so this matches the state after a reload
  // Also filter out status messages - they are transient UI state that shouldn't persist after interruption
  const updatedMessages = session.messages
    .filter(m => m.role !== 'status')  // Remove transient status messages
    // Only drop queued bubbles when the user explicitly stopped — silent
    // redirects auto-replay them so they must remain visible (#616).
    .filter(m => !(isUserInitiated && m.isQueued))
    .map(m => {
      // Mark running tools as interrupted
      if (m.role === 'tool' && m.toolResult === undefined && m.toolStatus !== 'completed' && m.toolStatus !== 'error') {
        return { ...m, toolStatus: 'error' as const, toolResult: 'Interrupted', isError: true }
      }
      // Clear pending state on assistant messages (transient streaming state)
      if (m.role === 'assistant' && m.isPending) {
        return { ...m, isPending: false, isStreaming: false }
      }
      return m
    })

  // Only add the "Response interrupted" message if provided (not a silent redirect)
  const messages = event.message
    ? [...updatedMessages, event.message]
    : updatedMessages

  // Restore queued message text to the input field — only on user-initiated
  // stops. Silent redirects keep the bubble in chat and rely on the backend's
  // auto-replay (#616).
  if (isUserInitiated && event.queuedMessages && event.queuedMessages.length > 0) {
    effects.push({
      type: 'restore_input',
      text: event.queuedMessages.join('\n\n'),
    })
  }

  return {
    state: {
      session: {
        ...markSessionProcessingState(session),
        isProcessing: false,
        messages,
        currentStatus: undefined,  // Clear any lingering status
      },
      streaming: null,
    },
    effects,
  }
}
