import type { SessionOperationContext } from '../operation-context.ts';
import { persistenceRootFor } from '../policy.ts';
import { getSessionPath as getSessionStoragePath, SessionPersistenceRootIdentityError } from '@craft-agent/shared/sessions';
import type { SessionEvent } from '@craft-agent/shared/protocol';
import { inspectAutonomousLineage, isSessionDescendant } from '../../autonomous-session-admission';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { METADATA_WRITE_GUARD_MS } from '../runtime-policy.ts';
import { autonomousAdmissionBlock as sessionOpAutonomousAdmissionBlock } from './exact-user-input-response.ts';
import { currentDelegatedSenderPath as sessionOpCurrentDelegatedSenderPath } from './is-current-delegated-descendant.ts';
import { hasExhaustedValidation as sessionOpHasExhaustedValidation } from './reconcile-provider-acceptance-unknown-for-retry.ts';
import { activeRelevantDelegatedDescendants as sessionOpActiveRelevantDelegatedDescendants, hasDurableDelegatedTerminalResultDelivery as sessionOpHasDurableDelegatedTerminalResultDelivery } from './quarantine-stale-typed-upward-agent-delivery.ts';
import { drainDeferredAutomaticSessions as sessionOpDrainDeferredAutomaticSessions, hydrateMessagesForColdPersist as sessionOpHydrateMessagesForColdPersist } from './drain-deferred-automatic-sessions.ts';

function sessionOpReserveSpawnAdmission(sessionOperationContext: SessionOperationContext, managed: ManagedSession, spawningRole?: 'worker' | 'reviewer'): symbol {
    const block = sessionOpAutonomousAdmissionBlock(sessionOperationContext, managed, true, true, spawningRole);
    if (block)
        throw new Error(`Delegation deferred (${block}). Resolve the ancestor decision or finish an existing delegation before spawning again. For a changed parent objective, create a new scoped delegation. Do not recursively delegate a delegated review.`);
    const token = Symbol('spawn-admission');
    sessionOperationContext.state.pendingSpawnRoots.set(token, inspectAutonomousLineage(managed, id => sessionOperationContext.state.sessions.get(id)).rootId);
    return token;
}

function sessionOpClaimAutomaticAdmission(sessionOperationContext: SessionOperationContext, managed: ManagedSession, actionableUpwardSenderId?: string | readonly string[]): boolean {
    if (sessionOperationContext.state.shuttingDown)
        return false;
    const alreadyReserved = sessionOperationContext.state.automaticAdmissionReservations.has(managed.id);
    const block = sessionOpAutonomousAdmissionBlock(sessionOperationContext, managed);
    // A reservation was granted only after dependency authentication. Keep it
    // across sendMessage's asynchronous preparation seams while revalidating
    // immutable lineage/capacity; do not deadlock by asking the same queued
    // terminal result to release its descendant a second time.
    if (!block && alreadyReserved)
        return true;
    const actionableSenderIds = typeof actionableUpwardSenderId === 'string'
        ? [actionableUpwardSenderId]
        : actionableUpwardSenderId ?? [];
    const releasedSenderPaths = actionableSenderIds.flatMap(senderId => {
        const sender = sessionOperationContext.state.sessions.get(senderId);
        const path = sender ? sessionOpCurrentDelegatedSenderPath(sessionOperationContext, managed, sender) : undefined;
        return path ? [path] : [];
    });
    const dependencyRemainsBlocking = (candidate: ManagedSession): boolean => (!releasedSenderPaths.some(path => path.has(candidate.id)));
    // Do not consume a slot while a current delegated descendant is still
    // producing the evidence this parent must consume. The parent's bounded
    // recovery or machine FIFO remains durable and wakes after the child stops.
    const waitingForPersistedChild = !block && [...sessionOperationContext.state.deferredAutomaticSessions].some(id => {
        const child = sessionOperationContext.state.sessions.get(id);
        return id !== managed.id && !!child && dependencyRemainsBlocking(child)
            && !!child.pendingTurnRecovery && !sessionOpHasExhaustedValidation(sessionOperationContext, child)
            && inspectAutonomousLineage(child, key => sessionOperationContext.state.sessions.get(key)).allowed
            && isSessionDescendant(id, managed.id, key => sessionOperationContext.state.sessions.get(key));
    });
    const waitingForChild = waitingForPersistedChild
        || (!block && sessionOpActiveRelevantDelegatedDescendants(sessionOperationContext, managed).some(child => (dependencyRemainsBlocking(child)
            && !sessionOpHasDurableDelegatedTerminalResultDelivery(sessionOperationContext, managed, child))));
    if (block || waitingForChild) {
        sessionOperationContext.state.deferredAutomaticSessions.add(managed.id);
        sessionLog.info('Deferred automatic admission behind lineage, capacity, or delegated work', {
            sessionId: managed.id,
            block,
            waitingForPersistedChild,
            waitingForChild,
            releasableQueuedResultSenders: actionableSenderIds,
            queuedAgentOrigins: managed.messageQueue.flatMap(item => (item.options?.internalOrigin?.kind === 'agent-message'
                ? [{
                        messageId: item.messageId,
                        senderSessionId: item.options.internalOrigin.senderSessionId,
                        deliveryId: item.options.internalOrigin.deliveryId,
                        agentMessageType: item.options.internalOrigin.agentMessageType,
                    }]
                : [])),
        });
        return false;
    }
    sessionOperationContext.state.automaticAdmissionReservations.add(managed.id);
    sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
    return true;
}

function sessionOpScheduleDeferredAutomaticSessions(sessionOperationContext: SessionOperationContext): void {
    if (sessionOperationContext.state.shuttingDown || !sessionOperationContext.state.deferredAutomaticSessions?.size || sessionOperationContext.state.automaticAdmissionWakeScheduled)
        return;
    if (sessionOperationContext.state.automaticAdmissionDrain) {
        sessionOperationContext.state.automaticAdmissionDrainWakeRequested = true;
        return;
    }
    sessionOperationContext.state.automaticAdmissionWakeScheduled = true;
    setImmediate(() => {
        sessionOperationContext.state.automaticAdmissionWakeScheduled = false;
        if (sessionOperationContext.state.shuttingDown)
            return;
        if (sessionOperationContext.state.automaticAdmissionDrain)
            sessionOperationContext.state.automaticAdmissionDrainWakeRequested = true;
        else
            void sessionOpDrainDeferredAutomaticSessions(sessionOperationContext);
    });
}

// Suppress fs.watch metadata-revert events for the window in which our own
// atomic write completes. See onSessionMetadataChange.
function sessionOpSetMetadataWriteGuard(_sessionOperationContext: SessionOperationContext, managed: ManagedSession): void {
    managed._metadataWriteGuardUntil = Date.now() + METADATA_WRITE_GUARD_MS;
}

function sessionOpAssertPersistenceSessionPath(_sessionOperationContext: SessionOperationContext, managed: ManagedSession, sessionPath: string): void {
    const expectedPath = getSessionStoragePath(persistenceRootFor(managed), managed.id);
    if (expectedPath !== sessionPath) {
        throw new SessionPersistenceRootIdentityError(`Session persistence path changed: ${managed.id}`);
    }
}

/**
 * Persist a session to disk (async, with debouncing in the persistence queue).
 *
 * Cold-session path: if messages haven't been lazy-loaded yet, hydrate them
 * synchronously from the JSONL first — otherwise the snapshot we enqueue
 * would write `messages: []` over the real messages on disk. Hydration
 * deliberately does NOT touch persistent metadata fields (name, labels,
 * sessionStatus, llmConnection, ...) because the caller may have just
 * mutated them; the in-memory mutation must win over what's on disk.
 * `loadStoredSession` is synchronous (sync fs reads), so the entire path
 * stays sync — no microtask race window between the load and the enqueue.
 */
function sessionOpPersistSession(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    if (sessionOperationContext.state.retiringSessions.has(managed))
        return false;
    if (!managed.messagesLoaded) {
        sessionOpHydrateMessagesForColdPersist(sessionOperationContext, managed);
    }
    const enqueued = sessionOperationContext.owner.enqueuePersist(managed);
    sessionOperationContext.owner.emitObjectiveChanged(managed);
    return enqueued;
}

/** Publish nested objective/recovery changes without repeating unchanged tool saves. */
function sessionOpEmitObjectiveChanged(sessionOperationContext: SessionOperationContext, managed: ManagedSession): void {
    const previous = sessionOperationContext.state.objectiveSnapshots.get(managed);
    if (previous === undefined && !managed.activeObjective && !managed.pendingTurnRecovery)
        return;
    const snapshot = JSON.stringify({
        activeObjective: managed.activeObjective ?? null,
        pendingTurnRecovery: managed.pendingTurnRecovery ?? null,
    });
    if (snapshot === previous)
        return;
    // Detached snapshots cannot change under an already queued transport event.
    const state = JSON.parse(snapshot) as Pick<Extract<SessionEvent, {
        type: 'objective_changed';
    }>, 'activeObjective' | 'pendingTurnRecovery'>;
    sessionOperationContext.owner["sendEvent"]({ type: 'objective_changed', sessionId: managed.id, ...state }, managed.workspace.id);
    sessionOperationContext.state.objectiveSnapshots.set(managed, snapshot);
}

export { sessionOpReserveSpawnAdmission as reserveSpawnAdmission };
export { sessionOpClaimAutomaticAdmission as claimAutomaticAdmission };
export { sessionOpScheduleDeferredAutomaticSessions as scheduleDeferredAutomaticSessions };
export { sessionOpSetMetadataWriteGuard as setMetadataWriteGuard };
export { sessionOpAssertPersistenceSessionPath as assertPersistenceSessionPath };
export { sessionOpPersistSession as persistSession };
export { sessionOpEmitObjectiveChanged as emitObjectiveChanged };
