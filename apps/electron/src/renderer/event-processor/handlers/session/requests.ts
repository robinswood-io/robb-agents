import type { Message } from '@craft-agent/core/types';
import type { Session } from '../../../../../../../packages/shared/src/protocol/dto/sessions.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
/**
 * Session Event Handlers
 *
 * Handles complete, error, sources_changed, etc.
 * Pure functions that return new state - no side effects.
 */
import type { SessionState,ProcessResult,PermissionRequestEvent,CredentialRequestEvent,PlanSubmittedEvent,SessionSharedEvent,SessionUnsharedEvent,AuthRequestEvent,AuthCompletedEvent } from "../../types";
import { appendMessage } from "../../helpers";
import { markSessionProcessingState } from "../../../lib/session-processing-state";

/**
 * Handle permission_request - return effect for parent to handle
 */
export function handlePermissionRequest(
  state: SessionState,
  event: PermissionRequestEvent
): ProcessResult {
  return {
    state,
    effects: [{
      type: 'permission_request',
      request: event.request,
    }]
  }
}

/**
 * Handle credential_request - return effect for parent to handle
 */
export function handleCredentialRequest(
  state: SessionState,
  event: CredentialRequestEvent
): ProcessResult {
  return {
    state,
    effects: [{
      type: 'credential_request',
      request: event.request,
    }]
  }
}

/**
 * Handle plan_submitted - add plan message to session
 */
export function handlePlanSubmitted(
  state: SessionState,
  event: PlanSubmittedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: appendMessage(session, event.message),
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_shared - session was shared to viewer
 */
export function handleSessionShared(
  state: SessionState,
  event: SessionSharedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        sharedUrl: event.sharedUrl,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_unshared - session share was revoked
 */
export function handleSessionUnshared(
  state: SessionState,
  _event: SessionUnsharedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: omitUndefined<Session>({
        ...session,
        sharedUrl: undefined,
        sharedId: undefined,
      }),
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle auth_request - add auth-request message to session
 * This is the unified auth flow - execution is paused until auth completes
 */
export function handleAuthRequest(
  state: SessionState,
  event: AuthRequestEvent
): ProcessResult {
  const { session } = state

  // Add auth-request message to session
  return {
    state: {
      session: {
        ...markSessionProcessingState(appendMessage(session, event.message)),
        pendingAuthRequestMessage: event.message,
        isProcessing: false,  // Agent execution is paused
      },
      streaming: null,  // Clear any streaming state
    },
    effects: [],
  }
}

/**
 * Handle auth_completed - update auth-request message status
 * The agent will resume via a new user message (sent by session manager)
 */
export function handleAuthCompleted(
  state: SessionState,
  event: AuthCompletedEvent
): ProcessResult {
  const { session, streaming } = state

  // Update the auth-request message status
  const updatedMessages = session.messages.map(m => {
    if (
      m.role === 'auth-request' &&
      m.authRequestId === event.requestId &&
      m.authStatus === 'pending'
    ) {
      return omitUndefined<Message>({
        ...m,
        authStatus: event.success
          ? ('completed' as const)
          : event.cancelled
            ? ('cancelled' as const)
            : ('failed' as const),
        authError: event.error,
      })
    }
    return m
  })

  return {
    state: {
      session: omitUndefined<Session>({
        ...session,
        messages: updatedMessages,
        pendingAuthRequestMessage: session.pendingAuthRequestMessage?.authRequestId === event.requestId
          ? undefined : session.pendingAuthRequestMessage,
      }),
      streaming,
    },
    effects: [],
  }
}
