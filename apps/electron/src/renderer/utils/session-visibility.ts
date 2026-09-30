export interface SessionVisibilityInput {
  id: string
  hidden?: boolean
  parentSessionId?: string
  /** Host-owned delegation lineage survives hydration/order races. */
  delegation?: { rootSessionId?: string } | null
  /** Conductor and Mission OS child markers are internal even if lineage is incomplete. */
  taskNodeId?: string
  missionWorkItemId?: string
  missionRole?: 'planner' | 'worker' | 'reviewer' | 'supervisor'
}

/**
 * Resolve the internal conversation owner without trusting labels or titles.
 * `parentSessionId` remains the direct-lineage authority. Delegation's
 * host-stamped root is a fail-closed fallback for event/hydration races and
 * legacy children whose direct parent was not restored yet.
 */
export function getInternalParentSessionId(
  session: SessionVisibilityInput,
): string | undefined {
  if (session.parentSessionId && session.parentSessionId !== session.id) {
    return session.parentSessionId
  }
  const delegatedRoot = session.delegation?.rootSessionId
  if (delegatedRoot && delegatedRoot !== session.id) return delegatedRoot
  return undefined
}

function isInternalSession(session: SessionVisibilityInput): boolean {
  return !!getInternalParentSessionId(session)
    || !!session.parentSessionId
    || !!session.delegation
    || !!session.taskNodeId
    || !!session.missionWorkItemId
    || session.missionRole === 'worker'
    || session.missionRole === 'reviewer'
}

/**
 * User conversations are independent of the filtered session list. A delegated
 * session stays internal even when its parent is archived, missing, or filtered
 * out. Manual conversation branches use branchFromSessionId/branchFromMessageId
 * instead of parentSessionId and remain user-facing.
 */
export function isUserFacingSession(session: SessionVisibilityInput): boolean {
  return !session.hidden && !isInternalSession(session)
}

/** Find the user conversation responsible for internal work, without cycles. */
export function getUserFacingSessionId(
  sessionId: string,
  sessions: ReadonlyMap<string, SessionVisibilityInput>,
): string | undefined {
  const visited = new Set<string>()
  let currentId: string | undefined = sessionId
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const session = sessions.get(currentId)
    if (!session) return undefined
    if (isUserFacingSession(session)) return currentId
    currentId = getInternalParentSessionId(session)
  }
  return undefined
}

/**
 * Resolve where UI attention for an internal session belongs. Root
 * conversations handle their own requests, while orphaned/cyclic internal
 * sessions stay fail-closed instead of becoming directly navigable.
 */
export function getInternalRequestNavigationTarget(
  sessionId: string,
  sessions: ReadonlyMap<string, SessionVisibilityInput>,
): string | undefined {
  const session = sessions.get(sessionId)
  if (!session || isUserFacingSession(session)) return undefined
  return getUserFacingSessionId(sessionId, sessions)
}

/** Surface required human input in its parent, retaining the original request. */
export function findPendingRequestForConversation<T>(
  sessionId: string,
  pending: ReadonlyMap<string, readonly T[]>,
  sessions: ReadonlyMap<string, SessionVisibilityInput>,
): T | undefined {
  const ownRequest = pending.get(sessionId)?.[0]
  if (ownRequest) return ownRequest
  for (const [requestSessionId, queue] of pending) {
    if (queue.length > 0 && getUserFacingSessionId(requestSessionId, sessions) === sessionId) {
      return queue[0]
    }
  }
  return undefined
}

export function getActiveSessionDescendantIds(
  sessionId: string,
  sessions: ReadonlyMap<string, SessionVisibilityInput & { isProcessing?: boolean }>,
): string[] {
  const activeIds: string[] = []
  for (const session of sessions.values()) {
    if (session.id !== sessionId && session.isProcessing
      && getUserFacingSessionId(session.id, sessions) === sessionId) activeIds.push(session.id)
  }
  return activeIds
}
