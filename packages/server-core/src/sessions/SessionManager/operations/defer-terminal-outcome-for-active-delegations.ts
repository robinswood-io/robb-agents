import type { SessionEvent } from '../../../../../shared/src/protocol/dto/session-events.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import { validAllocatedRecoveryDispatch } from '../policy.ts';
import { demoteLatestCheckpointAssistant, latestFinalAssistantId } from '../../tool-checkpoint-visibility';
import { createPendingTurnRecovery } from '../../turn-recovery';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { activeRelevantDelegatedDescendants as sessionOpActiveRelevantDelegatedDescendants, queuedRelevantDelegatedDeliverySenderIds as sessionOpQueuedRelevantDelegatedDeliverySenderIds, placeCurrentRecoveryAfterDelegatedDeliveries as sessionOpPlaceCurrentRecoveryAfterDelegatedDeliveries } from './quarantine-stale-typed-upward-agent-delivery.ts';
import { requeueAllocatedRecoveryDispatch as sessionOpRequeueAllocatedRecoveryDispatch } from './start-recovery-dispatch.ts';

/** A provider final cannot close its objective while a bound delegation is
 * still producing evidence. Keep the objective active and use the existing
 * bounded recovery/FIFO path; this neither creates new user authority nor a
 * fresh lineage. */
async function sessionOpDeferTerminalOutcomeForActiveDelegations(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<boolean> {
    const descendants = sessionOpActiveRelevantDelegatedDescendants(sessionOperationContext, managed, true);
    const queuedDeliverySenderIds = sessionOpQueuedRelevantDelegatedDeliverySenderIds(sessionOperationContext, managed);
    const descendantIds = [...new Set([...descendants.map(child => child.id), ...queuedDeliverySenderIds])];
    if (!descendantIds.length)
        return false;
    const validationGaps = [
        `Delegated results are still pending consumption from the current objective lineage: ${descendantIds.join(', ')}.`,
    ];
    // On restart, reuse an allocation that was already committed before the
    // process died. Rebuilding its transient FIFO row must not spend a second
    // attempt merely because the live guard had not yet dispatched it.
    const allocated = managed.pendingTurnRecovery
        && validAllocatedRecoveryDispatch(managed.pendingTurnRecovery);
    const queued = !!allocated && sessionOpRequeueAllocatedRecoveryDispatch(sessionOperationContext, managed, managed.pendingTurnRecovery!)
        ? true
        : await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, 'premature_final', validationGaps);
    if (queued)
        sessionOpPlaceCurrentRecoveryAfterDelegatedDeliveries(sessionOperationContext, managed);
    if (!queued && managed.activeObjective?.terminalState === 'active') {
        // Exhaustion remains intact: waiting for an already-authorized child must
        // not mint or reset a retry budget. A terminal agent delivery can still
        // enter through the normal durable FIFO and resume this active objective.
        const pending = managed.pendingTurnRecovery ?? {
            ...createPendingTurnRecovery(managed.activeObjective.userMessageId),
            budgetHistoryUnavailable: true,
            exhaustedAt: Date.now(),
        };
        managed.pendingTurnRecovery = {
            ...pending,
            lastCause: 'premature_final',
            validationGaps,
            // This wait is not itself a host tool checkpoint. Preserve a genuine
            // earlier checkpoint, but never manufacture one that would prevent the
            // delivery's own turn from validating its final response.
            continuationRequired: pending.continuationRequired === true,
        };
        sessionOperationContext.state.deferredAutomaticSessions.add(managed.id);
        const checkpoint = demoteLatestCheckpointAssistant(managed.messages, managed.pendingTurnRecovery.userMessageId);
        if (checkpoint) {
            managed.lastFinalMessageId = latestFinalAssistantId(managed.messages);
            sessionOperationContext.owner["sendEvent"](omitUndefined<Extract<SessionEvent, { type: 'text_complete' }>>({
                type: 'text_complete', sessionId: managed.id,
                text: checkpoint.content, isIntermediate: true,
                turnId: checkpoint.turnId, parentToolUseId: checkpoint.parentToolUseId,
                timestamp: checkpoint.timestamp, messageId: checkpoint.id,
                routingMeta: checkpoint.routingMeta,
                objectiveOutcome: checkpoint.objectiveOutcome ?? null,
                objectiveOutcomeError: checkpoint.objectiveOutcomeError ?? null,
            }), managed.workspace.id);
        }
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
    }
    sessionLog.info('Deferred terminal parent outcome for active delegated descendants', {
        sessionId: managed.id,
        objectiveId: managed.activeObjective?.objectiveId ?? managed.activeObjective?.userMessageId,
        descendantIds,
        recoveryQueued: queued,
    });
    return managed.activeObjective?.terminalState === 'active';
}

export { sessionOpDeferTerminalOutcomeForActiveDelegations as deferTerminalOutcomeForActiveDelegations };
