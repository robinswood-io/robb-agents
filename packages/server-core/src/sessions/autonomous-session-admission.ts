/** Direct-session tools must obey the same depth/concurrency envelope as missions. */
export const AUTONOMOUS_SESSION_LIMITS = { maxDepth: 4, maxPerRoot: 4, maxRestartConcurrent: 8 } as const

export interface AutonomousSessionNode {
  id: string
  parentSessionId?: string
  workspace: { id: string }
  createdAt?: number
  isProcessing?: boolean
  stopRequested?: boolean
  activeObjective?: { terminalState: string; startedAt: number; userMessageId?: string }
  pendingTurnRecovery?: unknown
  pendingQueuedMessageIds?: string[]
  pendingAgentDeliveryIds?: string[]
  messageQueue?: readonly unknown[]
  userInputRequests?: readonly { sessionId: string; status: string; objectiveUserMessageId?: string }[]
  pendingAuthRequestId?: string
  pendingAuthRequest?: unknown
}

export interface AutonomousAdmission {
  allowed: boolean
  rootId: string
  depth: number
  reason?: 'missing_parent' | 'cross_workspace' | 'cycle' | 'depth' | 'decision' | 'stopped' | 'terminal' | 'parent_paused' | 'parent_changed'
  blockedBy?: string
}

/** Questions here are origin records, never the ancestor's aggregated UI projection. */
export function inspectAutonomousLineage(
  session: AutonomousSessionNode,
  get: (id: string) => AutonomousSessionNode | undefined,
  spawning = false,
  hasPendingPermission: (id: string) => boolean = () => false,
): AutonomousAdmission {
  let cursor = session
  const seen = new Set<string>()
  const chain: AutonomousSessionNode[] = []
  let reason: AutonomousAdmission['reason']
  let blockedBy: string | undefined
  const block = (why: NonNullable<AutonomousAdmission['reason']>, id: string) => {
    if (!reason) { reason = why; blockedBy = id }
  }
  while (true) {
    if (seen.has(cursor.id)) { block('cycle', cursor.id); break }
    seen.add(cursor.id); chain.push(cursor)
    if (cursor.workspace.id !== session.workspace.id) { block('cross_workspace', cursor.id); break }
    if (cursor.stopRequested) block('stopped', cursor.id)
    if (cursor.userInputRequests?.some(q => q.sessionId === cursor.id && q.status === 'pending'
      && (!q.objectiveUserMessageId || q.objectiveUserMessageId === cursor.activeObjective?.userMessageId))
      || cursor.pendingAuthRequestId || cursor.pendingAuthRequest || hasPendingPermission(cursor.id)) {
      block('decision', cursor.id)
    }
    // A descendant answer may wake this session's older machine inbox. That
    // wake does not reopen the target's own completed/exhausted objective.
    if (cursor.activeObjective?.terminalState != null
      && cursor.activeObjective.terminalState !== 'active') block('terminal', cursor.id)
    if (cursor !== session || spawning) {
      // A stopped ancestor has no continuation authority, even after its
      // transient stopRequested flag was cleared or the process restarted.
      if (cursor.activeObjective && !cursor.isProcessing && !cursor.pendingTurnRecovery
        && !cursor.messageQueue?.length && !cursor.pendingQueuedMessageIds?.length
        && !cursor.pendingAgentDeliveryIds?.length) block('parent_paused', cursor.id)
    }
    if (!cursor.parentSessionId) break
    const parent = get(cursor.parentSessionId)
    if (!parent) { block('missing_parent', cursor.parentSessionId); break }
    // Existing metadata binds old delegations to the parent's original time
    // window. A newer user objective cannot silently adopt historical children.
    if (cursor.createdAt && parent.activeObjective?.startedAt && cursor.createdAt < parent.activeObjective.startedAt) {
      block('parent_changed', parent.id)
    }
    cursor = parent
  }
  const depth = chain.length - 1 + (spawning ? 1 : 0)
  if (depth > AUTONOMOUS_SESSION_LIMITS.maxDepth) block('depth', session.id)
  return { allowed: !reason, rootId: chain.at(-1)?.id ?? session.id, depth, ...(reason ? { reason, blockedBy } : {}) }
}

export function isSessionDescendant(id: string, ancestorId: string, get: (id: string) => AutonomousSessionNode | undefined): boolean {
  const seen = new Set<string>()
  let cursor = get(id)
  const workspaceId = cursor?.workspace.id
  while (cursor?.parentSessionId && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    cursor = get(cursor.parentSessionId)
    if (!cursor || cursor.workspace.id !== workspaceId) return false
    if (cursor.id === ancestorId) return true
  }
  return false
}

/** Stable depth ordering starts persisted children before their waiting parents. */
export function orderAutonomousRestartFrontier<T extends AutonomousSessionNode>(
  sessions: readonly T[], get: (id: string) => AutonomousSessionNode | undefined,
): T[] {
  return sessions.map((session, index) => ({ session, index, depth: inspectAutonomousLineage(session, get).depth }))
    .sort((a, b) => b.depth - a.depth || a.index - b.index).map(entry => entry.session)
}
