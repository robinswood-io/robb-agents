/**
 * Session Event Handlers
 *
 * Handles complete, error, sources_changed, etc.
 * Pure functions that return new state - no side effects.
 */
import type { SessionState, ProcessResult, UserMessageEvent, MessageAnnotationsUpdatedEvent } from "../../types";
import type { Message } from "../../../../shared/types";
import { markSessionProcessingState } from "../../../lib/session-processing-state";

/**
 * Handle user_message - confirms optimistic user message from backend
 *
 * Three statuses:
 * - 'accepted': Message is being processed (confirms optimistic message)
 * - 'queued': Message was queued during ongoing response (adds if not present, marks as queued)
 * - 'processing': Queued message is now being processed (updates status)
 */
export function handleUserMessage(
  state: SessionState,
  event: UserMessageEvent
): ProcessResult {
  const { session, streaming } = state
  const { message, status } = event

  // IDs win over the legacy content fallback: two genuine sends can have the
  // same text and adjacent timestamps. Only an unacknowledged optimistic row
  // may be reconciled by content when an older server omits its optimistic ID.
  let existingIndex = session.messages.findIndex(m =>
    m.role === 'user' && (
      m.id === message.id ||
      (event.optimisticMessageId && m.id === event.optimisticMessageId)
    )
  )
  if (existingIndex < 0 && !event.optimisticMessageId) {
    existingIndex = session.messages.findIndex(m => m.role === 'user' && m.isPending
      && !m.hidden && !m.internalOrigin && !message.hidden && !message.internalOrigin
      && m.content === message.content && Math.abs(m.timestamp - message.timestamp) < 5000)
  }

  let updatedMessages: Message[]

  if (existingIndex >= 0) {
    const existingMessage = session.messages[existingIndex]

    // Event sequence protection: don't regress from 'processing' back to 'queued'
    // This handles out-of-order events (e.g., 'processing' arrives before 'queued')
    if (status === 'queued' && existingMessage.isQueued === false
      && !existingMessage.isPending && existingMessage.id === message.id) {
      // Already progressed past queued state, ignore this late 'queued' event
      return { state, effects: [] }
    }

    // Update existing message — clear isPending, set isQueued based on status.
    //
    // - 'queued'     → isQueued = true  (Claude path: backend queued for re-send)
    // - 'processing' → isQueued = false (queued message is now actually running)
    // - 'accepted'   → isQueued = false (Pi steer path: agent has the message)
    //
    // Once accepted, the host ID is the message identity used by objectives,
    // retry and subsequent events. Keeping the optimistic ID makes live retry
    // target an unknown message until the conversation is rehydrated.
    updatedMessages = session.messages.map((m, i) => {
      if (i === existingIndex) {
        return {
          ...m,
          ...message,
          isPending: false,
          isQueued: status === 'queued',
        }
      }
      return m
    })
  } else {
    // Message not found (e.g., queued message from backend) - add it
    const newMessage: Message = {
      ...message,
      isPending: false,
      isQueued: status === 'queued',
    }
    updatedMessages = [...session.messages, newMessage]
  }

  return {
    state: {
      session: {
        ...(status === 'queued' ? session : markSessionProcessingState(session)),
        messages: updatedMessages,
        lastMessageAt: Date.now(),
        lastMessageRole: 'user',  // Clear plan badge when user responds
        // Queue acceptance does not stop the currently executing turn. Only
        // its complete/interrupted event can do that; dispatch starts the next.
        isProcessing: status === 'queued' ? session.isProcessing : true,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle message_annotations_updated - update annotations on a specific message.
 */
export function handleMessageAnnotationsUpdated(
  state: SessionState,
  event: MessageAnnotationsUpdatedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        messages: session.messages.map(m =>
          m.id === event.messageId
            ? { ...m, annotations: event.annotations }
            : m
        ),
      },
      streaming,
    },
    effects: [],
  }
}
