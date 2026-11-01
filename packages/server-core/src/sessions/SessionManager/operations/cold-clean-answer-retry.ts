import type { ManagedSession } from '../managed-session.ts';
import type { SessionOperationContext } from '../operation-context.ts';
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions';
import { sessionLog } from '../runtime-platform.ts';
import { resumeAllocatedRecoveryDispatch as sessionOpResumeAllocatedRecoveryDispatch } from './dispatch-allocated-clean-retry.ts';
import { stopImmutableRestartRecovery as sessionOpStopImmutableRestartRecovery } from './exact-user-input-response.ts';
import { reclaimableUnobservedStartedCleanUserInputRetry as sessionOpReclaimableUnobservedStartedCleanUserInputRetry } from './retry-turn-internal.ts';

export async function resumeColdCleanAnswerRetry(managed: ManagedSession, sessionOperationContext: SessionOperationContext, restartRecoveryStillAuthorized: () => boolean, pending: PendingTurnRecovery, startedCleanAnswerRetry: NonNullable<ReturnType<typeof sessionOpReclaimableUnobservedStartedCleanUserInputRetry>>, sessionId: string): Promise<void> {
    if (await sessionOpStopImmutableRestartRecovery(sessionOperationContext, managed))
        return;
    if (!restartRecoveryStillAuthorized() || managed.pendingTurnRecovery !== pending
        || managed.isProcessing)
        return;
    const boundaryRow = managed.messages[startedCleanAnswerRetry.messageIndex]!;
    const reclaimedPending: PendingTurnRecovery = {
        ...pending,
        recoveryDispatch: startedCleanAnswerRetry.allocatedDispatch,
    };
    managed.messages.splice(startedCleanAnswerRetry.messageIndex, 1);
    managed.pendingTurnRecovery = reclaimedPending;
    try {
        if (!sessionOperationContext.owner["persistSession"](managed)) {
            throw new Error('The reclaimed clean answer boundary could not be queued for durable storage');
        }
        await sessionOperationContext.owner.flushSession(managed.id);
    }
    catch (error) {
        if (sessionOperationContext.state.sessions.get(sessionId) === managed
            && managed.pendingTurnRecovery === reclaimedPending && !managed.stopRequested) {
            managed.pendingTurnRecovery = pending;
            if (!managed.messages.some(message => message.id === boundaryRow.id)) {
                managed.messages.splice(Math.min(startedCleanAnswerRetry.messageIndex, managed.messages.length), 0, boundaryRow);
            }
            sessionOperationContext.owner["persistSession"](managed);
        }
        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
        sessionLog.warn('Failed to durably reclaim an unobserved clean user-input Retry', {
            sessionId,
            dispatchId: startedCleanAnswerRetry.allocatedDispatch.id,
            error: error instanceof Error ? error.message : String(error),
        });
        return;
    }
    if (sessionOperationContext.state.sessions.get(sessionId) !== managed
        || managed.pendingTurnRecovery !== reclaimedPending || managed.stopRequested)
        return;
    if (!sessionOpResumeAllocatedRecoveryDispatch(sessionOperationContext, managed, reclaimedPending)) {
        sessionOperationContext.state.deferredAutomaticSessions.add(sessionId);
        sessionOperationContext.owner["scheduleDeferredAutomaticSessions"]();
    }
    return;
}


