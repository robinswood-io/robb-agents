import { getInternalParentSessionId, isUserFacingSession, type SessionVisibilityInput } from './session-visibility'

export interface SidebarSessionInput extends SessionVisibilityInput {
  isProcessing?: boolean
  hasPendingUserInput?: boolean
  hasPendingAuth?: boolean
  pendingTurnRecovery?: {
    exhaustedAt?: number
    validationExhausted?: boolean
  }
}

export interface SessionSubagentSummary {
  totalCount: number
  runningCount: number
}

export interface SidebarSessionSummary<T extends SidebarSessionInput> {
  topLevelSessions: T[]
  subagentsBySessionId: Map<string, SessionSubagentSummary>
}

/** A delegated session remains active while it is running, waiting on an
 * explicit human/auth handoff, or holding a recoverable durable continuation.
 * Merely retaining a legacy `active` objective is deliberately insufficient:
 * old idle child headers must not make the parent look busy forever. */
function hasActiveSubagentWork(session: SidebarSessionInput): boolean {
  if (session.isProcessing || session.hasPendingUserInput || session.hasPendingAuth) return true
  const recovery = session.pendingTurnRecovery
  return !!recovery && recovery.exhaustedAt === undefined && recovery.validationExhausted !== true
}

/**
 * Keeps child/sub-agent sessions out of the sidebar while preserving their
 * relationship with every visible ancestor. `sessions` supplies the rows that
 * may render; `relatedSessions` supplies the complete workspace lineage.
 *
 * Each ancestor summary includes all descendants, not only direct children.
 * Visibility comes from each session's own metadata, including when its parent
 * is absent from the current list. Aggregation does not change that policy.
 */
export function summarizeSessionsForSidebar<T extends SidebarSessionInput>(
  sessions: T[],
  relatedSessions: T[] = sessions,
): SidebarSessionSummary<T> {
  const sessionById = new Map(relatedSessions.map(session => [session.id, session]))
  const ancestorsBySessionId = new Map<string, string[] | null>()

  const resolveAncestors = (session: T): string[] | null => {
    const internalParentId = getInternalParentSessionId(session)
    if (!internalParentId) return []

    const ancestors: string[] = []
    const visited = new Set<string>([session.id])
    let ancestorId: string | undefined = internalParentId

    while (ancestorId) {
      if (visited.has(ancestorId)) return null

      const ancestor = sessionById.get(ancestorId)
      if (!ancestor) return null

      visited.add(ancestorId)
      ancestors.push(ancestorId)

      const nextAncestorId = getInternalParentSessionId(ancestor)
      if (!nextAncestorId) {
        return ancestors
      }
      ancestorId = nextAncestorId
    }

    return ancestors
  }

  for (const session of relatedSessions) {
    ancestorsBySessionId.set(session.id, resolveAncestors(session))
  }

  const topLevelSessions = sessions.filter(isUserFacingSession)
  const subagentsBySessionId = new Map<string, SessionSubagentSummary>()

  for (const session of relatedSessions) {
    const ancestors = ancestorsBySessionId.get(session.id)
    if (!ancestors || ancestors.length === 0) continue

    for (const ancestorId of ancestors) {
      const current = subagentsBySessionId.get(ancestorId) ?? {
        totalCount: 0,
        runningCount: 0,
      }
      subagentsBySessionId.set(ancestorId, {
        totalCount: current.totalCount + 1,
        runningCount: current.runningCount + (hasActiveSubagentWork(session) ? 1 : 0),
      })
    }
  }

  return {
    topLevelSessions,
    subagentsBySessionId,
  }
}
