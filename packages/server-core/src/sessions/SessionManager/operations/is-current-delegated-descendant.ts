import type { SessionOperationContext } from '../operation-context.ts';
import type { SendMessageOptions } from '@craft-agent/shared/protocol';
import type { ManagedSession } from '../managed-session.ts';

function sessionOpIsAutonomousMessage(sessionOperationContext: SessionOperationContext, options?: SendMessageOptions): boolean {
    if (options?.automaticRecovery?.cause === 'user_retry' || options?.internalOrigin?.kind === 'user-input')
        return false;
    return !!options?.automaticRecovery || !!options?.internalOrigin || !!options?.hidden;
}

/** Bind a descendant to the exact current parent/root objective. Activity is
 * deliberately checked by the caller: a just-created child has no objective
 * yet, while a terminal child's durable delivery still belongs to this
 * lineage. */
function sessionOpIsCurrentDelegatedDescendant(sessionOperationContext: SessionOperationContext, managed: ManagedSession, candidate: ManagedSession): boolean {
    const objective = managed.activeObjective;
    if (!objective || objective.terminalState !== 'active' || candidate.id === managed.id
        || candidate.workspace.id !== managed.workspace.id)
        return false;
    const objectiveId = (session: ManagedSession): string => (session.activeObjective?.objectiveId ?? session.activeObjective?.userMessageId ?? session.id);
    const rootId = managed.delegation?.rootSessionId ?? managed.id;
    const root = sessionOperationContext.state.sessions.get(rootId);
    if (!root || root.workspace.id !== managed.workspace.id
        || root.activeObjective?.terminalState !== 'active')
        return false;
    const rootObjectiveId = objectiveId(root);
    const delegation = candidate.delegation;
    if (!delegation || delegation.rootSessionId !== rootId
        || delegation.rootObjectiveId !== rootObjectiveId)
        return false;
    const seen = new Set<string>([candidate.id]);
    let cursor = candidate;
    while (cursor.parentSessionId && !seen.has(cursor.parentSessionId)) {
        seen.add(cursor.parentSessionId);
        const parent = sessionOperationContext.state.sessions.get(cursor.parentSessionId);
        const edge = cursor.delegation;
        if (!parent || parent.workspace.id !== managed.workspace.id || !edge
            || edge.rootSessionId !== rootId || edge.rootObjectiveId !== rootObjectiveId
            || edge.parentObjectiveId !== objectiveId(parent)
            || parent.activeObjective?.terminalState !== 'active')
            return false;
        if (parent.id === managed.id)
            return true;
        cursor = parent;
    }
    return false;
}

/** Return the exact descendant branch from `managed` to `sender`, excluding
 * the recipient itself. A result may release only this already-materialized
 * dependency; sibling work and descendants below the sender remain blocking. */
function sessionOpCurrentDelegatedSenderPath(sessionOperationContext: SessionOperationContext, managed: ManagedSession, sender: ManagedSession): Set<string> | undefined {
    if (!sessionOpIsCurrentDelegatedDescendant(sessionOperationContext, managed, sender))
        return undefined;
    const path = new Set<string>();
    const visited = new Set<string>([managed.id]);
    let cursor: ManagedSession | undefined = sender;
    while (cursor && cursor.id !== managed.id && !visited.has(cursor.id)) {
        visited.add(cursor.id);
        path.add(cursor.id);
        cursor = cursor.parentSessionId ? sessionOperationContext.state.sessions.get(cursor.parentSessionId) : undefined;
    }
    return cursor?.id === managed.id ? path : undefined;
}

export { sessionOpIsAutonomousMessage as isAutonomousMessage };
export { sessionOpIsCurrentDelegatedDescendant as isCurrentDelegatedDescendant };
export { sessionOpCurrentDelegatedSenderPath as currentDelegatedSenderPath };
