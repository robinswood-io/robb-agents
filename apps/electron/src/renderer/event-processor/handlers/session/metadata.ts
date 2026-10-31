import type { Session } from '../../../../../../../packages/shared/src/protocol/dto/sessions.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
/**
 * Session Event Handlers
 *
 * Handles complete, error, sources_changed, etc.
 * Pure functions that return new state - no side effects.
 */
import type { SessionState, ProcessResult, SourcesChangedEvent, LabelsChangedEvent, ProjectIdChangedEvent, SessionStatusChangedEvent, SessionMetadataChangedEvent, ObjectiveChangedEvent, SessionFlaggedEvent, SessionUnflaggedEvent, SessionArchivedEvent, SessionUnarchivedEvent, NameChangedEvent, UsageUpdateEvent } from "../../types";
import { markSessionProcessingState } from "../../../lib/session-processing-state";

/**
 * Handle sources_changed - update session's enabled sources
 */
export function handleSourcesChanged(
  state: SessionState,
  event: SourcesChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        enabledSourceSlugs: event.enabledSourceSlugs,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle labels_changed - update session's labels
 */
export function handleLabelsChanged(
  state: SessionState,
  event: LabelsChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: {
        ...session,
        labels: event.labels,
      },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle project_id_changed - update session's projectId binding
 */
export function handleProjectIdChanged(
  state: SessionState,
  event: ProjectIdChangedEvent
): ProcessResult {
  const { session, streaming } = state

  return {
    state: {
      session: omitUndefined<Session>({
        ...session,
        projectId: event.projectId ?? undefined,
      }),
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_status_changed - update session's sessionStatus (external metadata change or agent tool)
 */
export function handleSessionStatusChanged(
  state: SessionState,
  event: SessionStatusChangedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, sessionStatus: event.sessionStatus },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_metadata_changed - merge programmatic metadata changes (taskNodeCount,
 * kanbanColumn, and the taskDraft→taskSlug promotion on orchestrator adoption) that don't
 * propagate via the header-signature file watch.
 */
export function handleSessionMetadataChanged(
  state: SessionState,
  event: SessionMetadataChangedEvent
): ProcessResult {
  const { session, streaming } = state
  const { kanbanColumn, ...changes } = event.changes
  const updated = {
    ...(typeof changes.isProcessing === 'boolean' ? markSessionProcessingState(session) : session),
    ...changes,
  }
  if ('kanbanColumn' in event.changes) {
    if (kanbanColumn === null || kanbanColumn === undefined) delete updated.kanbanColumn
    else updated.kanbanColumn = kanbanColumn
  }
  return {
    state: {
      session: updated,
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_flagged - mark session as flagged
 */
export function handleSessionFlagged(
  state: SessionState,
  _event: SessionFlaggedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, isFlagged: true },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_unflagged - mark session as unflagged
 */
export function handleSessionUnflagged(
  state: SessionState,
  _event: SessionUnflaggedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, isFlagged: false },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_archived - mark session as archived
 */
export function handleSessionArchived(
  state: SessionState,
  _event: SessionArchivedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: { ...session, isArchived: true, archivedAt: Date.now() },
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle session_unarchived - mark session as unarchived
 */
export function handleSessionUnarchived(
  state: SessionState,
  _event: SessionUnarchivedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: omitUndefined<Session>({ ...session, isArchived: false, archivedAt: undefined }),
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle name_changed - update session name (external metadata change)
 */
export function handleNameChanged(
  state: SessionState,
  event: NameChangedEvent
): ProcessResult {
  const { session, streaming } = state
  return {
    state: {
      session: omitUndefined<Session>({ ...session, name: event.name }),
      streaming,
    },
    effects: [],
  }
}

/**
 * Handle usage_update - real-time context usage during processing
 * Merges usage update into existing tokenUsage (preserves outputTokens, costUsd, etc.)
 */
export function handleUsageUpdate(
  state: SessionState,
  event: UsageUpdateEvent
): ProcessResult {
  const { session, streaming } = state

  // Merge usage update into existing tokenUsage, providing defaults for required fields
  const updatedTokenUsage = {
    inputTokens: event.tokenUsage.inputTokens,
    outputTokens: session.tokenUsage?.outputTokens ?? 0,
    totalTokens: session.tokenUsage?.totalTokens ?? 0,
    contextTokens: session.tokenUsage?.contextTokens ?? 0,
    costUsd: session.tokenUsage?.costUsd ?? 0,
    ...(session.tokenUsage?.cacheReadTokens !== undefined && { cacheReadTokens: session.tokenUsage.cacheReadTokens }),
    ...(session.tokenUsage?.cacheCreationTokens !== undefined && { cacheCreationTokens: session.tokenUsage.cacheCreationTokens }),
    ...(event.tokenUsage.contextWindow && { contextWindow: event.tokenUsage.contextWindow }),
  }

  return {
    state: {
      session: {
        ...session,
        tokenUsage: updatedTokenUsage,
      },
      streaming,
    },
    effects: [],
  }
}

/** Apply host objective truth without treating a checkpoint as turn completion. */
export function handleObjectiveChanged(
  state: SessionState,
  event: ObjectiveChangedEvent,
): ProcessResult {
  return {
    state: {
      ...state,
      session: omitUndefined<Session>({
        ...state.session,
        activeObjective: event.activeObjective ?? undefined,
        pendingTurnRecovery: event.pendingTurnRecovery ?? undefined,
      }),
    },
    effects: [],
  }
}
