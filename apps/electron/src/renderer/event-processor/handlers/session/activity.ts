/**
 * Session Event Handlers
 *
 * Handles complete, error, sources_changed, etc.
 * Pure functions that return new state - no side effects.
 */
import type { SessionState, ProcessResult, TitleGeneratedEvent, TitleRegeneratingEvent, AsyncOperationEvent, WorkingDirectoryChangedEvent, PermissionModeChangedEvent, SessionModelChangedEvent, LLMConnectionChangedEvent } from "../../types";

/**
 * Handle title_generated - update session title and clear regenerating state
 */
export function handleTitleGenerated(
  state: SessionState,
  event: TitleGeneratedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        name: event.title,
        // Clear regenerating state - title generation completed
        isRegeneratingTitle: false,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle title_regenerating - set regenerating state for shimmer effect
 * @deprecated Use handleAsyncOperation instead
 */
export function handleTitleRegenerating(
  state: SessionState,
  event: TitleRegeneratingEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        isRegeneratingTitle: event.isRegenerating,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle async_operation - set async operation state for shimmer effect
 * Generic handler for any async operation (sharing, updating share, revoking, title regeneration)
 */
export function handleAsyncOperation(
  state: SessionState,
  event: AsyncOperationEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        isAsyncOperationOngoing: event.isOngoing,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle working_directory_changed - update session working directory (user-initiated via UI)
 */
export function handleWorkingDirectoryChanged(
  state: SessionState,
  event: WorkingDirectoryChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: { ...session, workingDirectory: event.workingDirectory },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle permission_mode_changed - return effect for parent to handle session options
 */
export function handlePermissionModeChanged(
  state: SessionState,
  event: PermissionModeChangedEvent
): ProcessResult {
  return {
    state,
    effects: [{
      type: 'permission_mode_changed',
      sessionId: event.sessionId,
      permissionMode: event.permissionMode,
      previousPermissionMode: event.previousPermissionMode,
      transitionDisplay: event.transitionDisplay,
      modeVersion: event.modeVersion,
      changedAt: event.changedAt,
      changedBy: event.changedBy,
    }],
  }
}

/**
 * Handle session_model_changed - update session model
 */
export function handleSessionModelChanged(
  state: SessionState,
  event: SessionModelChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        model: event.model ?? undefined,
        ...(event.modelRoutePinned !== undefined
          ? { modelRoutePinned: event.modelRoutePinned }
          : event.model === null
            ? { modelRoutePinned: false }
            : {}),
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle connection_changed - sync session.llmConnection to renderer state
 */
export function handleConnectionChanged(
  state: SessionState,
  event: LLMConnectionChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        llmConnection: event.connectionSlug,
        ...(event.supportsBranching !== undefined && { supportsBranching: event.supportsBranching }),
      },
      streaming,
    },
    effects: [],
  }
}
