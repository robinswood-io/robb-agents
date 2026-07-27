export interface SidebarSessionInput {
  id: string
  parentSessionId?: string
  isProcessing?: boolean
}

export interface SessionSubagentSummary {
  totalCount: number
  runningCount: number
}

export interface SidebarSessionSummary<T extends SidebarSessionInput> {
  topLevelSessions: T[]
  subagentsBySessionId: Map<string, SessionSubagentSummary>
}

/**
 * Keeps child/sub-agent sessions out of the sidebar while preserving their
 * relationship with every visible ancestor.
 *
 * Each ancestor summary includes all descendants, not only direct children.
 * Missing parents and malformed cycles fail open: those sessions remain
 * visible so damaged metadata can never make a conversation disappear.
 */
export function summarizeSessionsForSidebar<T extends SidebarSessionInput>(
  sessions: T[],
): SidebarSessionSummary<T> {
  const sessionById = new Map(sessions.map(session => [session.id, session]))
  const ancestorsBySessionId = new Map<string, string[] | null>()

  const resolveAncestors = (session: T): string[] | null => {
    if (!session.parentSessionId || session.parentSessionId === session.id) return []

    const ancestors: string[] = []
    const visited = new Set<string>([session.id])
    let ancestorId: string | undefined = session.parentSessionId

    while (ancestorId) {
      if (visited.has(ancestorId)) return null

      const ancestor = sessionById.get(ancestorId)
      if (!ancestor) return null

      visited.add(ancestorId)
      ancestors.push(ancestorId)

      if (!ancestor.parentSessionId || ancestor.parentSessionId === ancestor.id) {
        return ancestors
      }
      ancestorId = ancestor.parentSessionId
    }

    return ancestors
  }

  for (const session of sessions) {
    ancestorsBySessionId.set(session.id, resolveAncestors(session))
  }

  const topLevelSessions = sessions.filter(session => {
    const ancestors = ancestorsBySessionId.get(session.id)
    return ancestors === null || ancestors === undefined || ancestors.length === 0
  })
  const subagentsBySessionId = new Map<string, SessionSubagentSummary>()

  for (const session of sessions) {
    const ancestors = ancestorsBySessionId.get(session.id)
    if (!ancestors || ancestors.length === 0) continue

    for (const ancestorId of ancestors) {
      const current = subagentsBySessionId.get(ancestorId) ?? {
        totalCount: 0,
        runningCount: 0,
      }
      subagentsBySessionId.set(ancestorId, {
        totalCount: current.totalCount + 1,
        runningCount: current.runningCount + (session.isProcessing ? 1 : 0),
      })
    }
  }

  return {
    topLevelSessions,
    subagentsBySessionId,
  }
}
