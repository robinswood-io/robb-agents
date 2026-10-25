import { publishColdProviderReconciliation } from './cold-provider-reconciliation-publication.ts';
import type { ColdProviderRollbackSnapshot } from './cold-provider-reconciliation-publication.ts';
import type { SessionOperationContext } from '../operation-context.ts';
import { providerDispatchesAwaitingColdReconciliation, exactProviderDispatchAcceptanceUnknown, queuedDirectHumanContinuationIndex, validAllocatedRecoveryDispatch, isDurableProviderActivityOrHumanSupersession, enqueueRecoveredMessageInTranscriptOrder, repairLegacyContextualObjectiveAuthority, isClosedColdResumeStatus } from '../policy.ts';
import { recoveredInternalMessageOptions } from '../../agent-delivery.ts';
import type { SendMessageOptions } from '@craft-agent/shared/protocol';
import type { Message } from '@craft-agent/core/types';
import { createPendingTurnRecovery } from '../../turn-recovery';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { SOURCE_ACTIVATION_TOMBSTONE_LIMIT, SOURCE_ACTIVATION_TOMBSTONE_TTL_MS, rememberAutoRetryTombstone } from '../source-activation.ts';
import { repairLegacySyntheticObjectiveAuthority as sessionOpRepairLegacySyntheticObjectiveAuthority, dropDeferredSourceActivations as sessionOpDropDeferredSourceActivations, hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState } from './repair-legacy-synthetic-objective-authority.ts';
import { stripDisabledAllocatedRoutingFallback as sessionOpStripDisabledAllocatedRoutingFallback, coldAutomaticRecoveryLeaseExpired as sessionOpColdAutomaticRecoveryLeaseExpired } from './start-recovery-dispatch.ts';
import { pendingRecoveryBelongsToCurrentObjective as sessionOpPendingRecoveryBelongsToCurrentObjective } from './pending-recovery-belongs-to-current-objective.ts';
import { hasExhaustedValidation as sessionOpHasExhaustedValidation } from './reconcile-provider-acceptance-unknown-for-retry.ts';
import { hasOnlyMachineInbox as sessionOpHasOnlyMachineInbox, hasAnyRetainedStoppedAgentDelivery as sessionOpHasAnyRetainedStoppedAgentDelivery } from './restore-pre-ack-agent-delivery-dequeues.ts';

/** Restore decisions before any inbox dispatch; none of these records grants permission. */
function sessionOpRestoreDurableRuntimeState(sessionOperationContext: SessionOperationContext, managed: ManagedSession): void {
    const repairedSyntheticObjectiveAuthority = sessionOpRepairLegacySyntheticObjectiveAuthority(sessionOperationContext, managed);
    if (repairedSyntheticObjectiveAuthority) {
        sessionLog.warn('Repaired legacy synthetic objective authority from accepted human turns', {
            sessionId: managed.id,
            objectiveId: managed.activeObjective?.objectiveId,
        });
    }
    const repairedContextualObjectiveAuthority = repairLegacyContextualObjectiveAuthority(managed);
    if (repairedContextualObjectiveAuthority) {
        sessionLog.warn('Repaired legacy contextual objective root from the preceding accepted human mission', {
            sessionId: managed.id,
            objectiveId: managed.activeObjective?.objectiveId,
        });
    }
    const latestAuth = managed.messages.findLast(message => message.role === 'auth-request');
    const auth = latestAuth?.authStatus === 'pending'
        && (!managed.pendingAuthRequestId || latestAuth.authRequestId === managed.pendingAuthRequestId) ? latestAuth : undefined;
    managed.pendingAuthRequestId = undefined;
    managed.pendingAuthRequest = undefined;
    if (auth?.authRequestId && auth.authRequestType && auth.authSourceSlug && auth.authSourceName) {
        const base = { requestId: auth.authRequestId, sessionId: managed.id, sourceSlug: auth.authSourceSlug, sourceName: auth.authSourceName };
        managed.pendingAuthRequestId = auth.authRequestId;
        managed.pendingAuthRequest = auth.authRequestType === 'credential'
            ? { ...base, type: 'credential', mode: auth.authCredentialMode ?? 'bearer', labels: auth.authLabels,
                description: auth.authDescription, hint: auth.authHint, headerName: auth.authHeaderName,
                headerNames: auth.authHeaderNames, sourceUrl: auth.authSourceUrl, passwordRequired: auth.authPasswordRequired }
            : { ...base, type: auth.authRequestType };
    }
    if (managed.pendingTurnRecovery?.waitingForPermission) {
        managed.pendingTurnRecovery.waitingForPermission = { ...managed.pendingTurnRecovery.waitingForPermission, recoveryRequired: true };
    }
    const disabledRoutingFallbackSanitization = managed.pendingTurnRecovery
        ? sessionOpStripDisabledAllocatedRoutingFallback(sessionOperationContext, managed, managed.pendingTurnRecovery)
        : undefined;
    if (disabledRoutingFallbackSanitization) {
        managed.pendingTurnRecovery = disabledRoutingFallbackSanitization.pending;
    }
    const allocatedRecovery = managed.pendingTurnRecovery
        ? validAllocatedRecoveryDispatch(managed.pendingTurnRecovery)
        : undefined;
    const queuedHumanSupersedesSourceActivation = managed.messages.some(message => (message.role === 'user' && message.isQueued === true && !message.isPending
        && !message.hidden && !message.internalOrigin && !message.agentDelivery));
    const providerDispatchMessages = providerDispatchesAwaitingColdReconciliation(managed);
    const activeObjective = managed.activeObjective;
    const activeObjectiveId = activeObjective?.objectiveId ?? activeObjective?.userMessageId;
    const exactBoundProviderDispatches = providerDispatchMessages.filter(message => (activeObjective?.terminalState === 'active'
        && exactProviderDispatchAcceptanceUnknown(message)
        && message.providerDispatch!.userStoppedAt === undefined
        && message.providerDispatch!.objectiveId === activeObjectiveId
        && message.providerDispatch!.objectiveUserMessageId === activeObjective.userMessageId));
    const currentHumanRootMatches = activeObjective
        ? managed.messages.filter(message => (message.id === activeObjective.userMessageId
            && message.role === 'user' && !message.hidden && !message.isPending
            && !message.internalOrigin && !message.agentDelivery))
        : [];
    const currentHumanRoot = currentHumanRootMatches.length === 1
        ? currentHumanRootMatches[0] : undefined;
    const currentHumanRootIndex = currentHumanRoot
        ? managed.messages.indexOf(currentHumanRoot) : -1;
    // A durable accepted receipt from an older objective is already consumed.
    // Retire it inertly; it must neither authorize nor block the current root.
    // Unknown receipts, and multiple receipts bound to the current root, remain
    // quarantined because selecting among them would invent replay authority.
    const inertAcceptedDispatches = providerDispatchMessages.filter(message => {
        const marker = message.providerDispatch;
        const messageIndex = managed.messages.indexOf(message);
        return marker?.state === 'accepted'
            && marker.userStoppedAt === undefined
            && exactProviderDispatchAcceptanceUnknown(message)
            && !exactBoundProviderDispatches.includes(message)
            && !!currentHumanRoot && currentHumanRootIndex > messageIndex
            && marker.objectiveId !== activeObjectiveId
            && marker.objectiveUserMessageId !== activeObjective?.userMessageId;
    });
    const retiredUncertainDispatches = providerDispatchMessages.filter(message => {
        const marker = message.providerDispatch;
        const messageIndex = managed.messages.indexOf(message);
        return marker?.state === 'acceptance-unknown'
            && exactProviderDispatchAcceptanceUnknown(message)
            && !exactBoundProviderDispatches.includes(message)
            && !!currentHumanRoot && currentHumanRootIndex > messageIndex
            && marker.objectiveId !== activeObjectiveId
            && marker.objectiveUserMessageId !== activeObjective?.userMessageId;
    });
    const unresolvedProviderDispatches = providerDispatchMessages.filter(message => (!inertAcceptedDispatches.includes(message)
        && !retiredUncertainDispatches.includes(message)));
    const exactBoundProviderDispatch = unresolvedProviderDispatches.length === 1
        && exactBoundProviderDispatches.length === 1
        && unresolvedProviderDispatches[0] === exactBoundProviderDispatches[0]
        ? exactBoundProviderDispatches[0]
        : undefined;
    const providerDispatchPending = managed.pendingTurnRecovery;
    const providerDispatchRecoveryEligible = !!exactBoundProviderDispatch
        && !!providerDispatchPending
        && sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, providerDispatchPending)
        && !sessionOpColdAutomaticRecoveryLeaseExpired(sessionOperationContext, providerDispatchPending)
        && !sessionOpHasExhaustedValidation(sessionOperationContext, managed);
    let recoveredProviderDispatchNeedsContinuation = false;
    let providerDispatchRollbackSnapshot: ColdProviderRollbackSnapshot;
    if (providerDispatchRecoveryEligible || inertAcceptedDispatches.length > 0
        || retiredUncertainDispatches.length > 0) {
        // This is a cold-only transaction. The exact possibly-consumed prompt is
        // retired and replaced by a generic, idempotent inspection continuation;
        // it is never submitted a second time. The mutation is admitted only
        // after one durable snapshot contains both sides of that transition.
        providerDispatchRollbackSnapshot = {
            messages: structuredClone(managed.messages),
            messageQueue: structuredClone(managed.messageQueue),
            pendingTurnRecovery: managed.pendingTurnRecovery
                ? structuredClone(managed.pendingTurnRecovery) : undefined,
            autoRetryPending: managed.autoRetryPending
                ? structuredClone(managed.autoRetryPending) : undefined,
            pendingQueuedMessageIds: managed.pendingQueuedMessageIds
                ? [...managed.pendingQueuedMessageIds] : undefined,
            pendingAgentDeliveryIds: managed.pendingAgentDeliveryIds
                ? [...managed.pendingAgentDeliveryIds] : undefined,
        };
        const retireConsumedDispatch = (consumed: Message) => {
            const marker = consumed.providerDispatch!;
            delete consumed.providerDispatch;
            consumed.isQueued = false;
            managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== consumed.id);
            if (consumed.agentDelivery) {
                consumed.agentDelivery.status = 'processed';
                consumed.agentDelivery.providerDispatchUncertainAt ??= marker.acceptedAt ?? marker.markedAt;
            }
            if (consumed.internalOrigin?.kind === 'source-activation'
                && managed.autoRetryPending?.sourceActivationId === consumed.internalOrigin.sourceActivationId) {
                managed.autoRetryPending!.providerStarted = true;
            }
            if (consumed.hidden && !consumed.agentDelivery
                && consumed.internalOrigin?.kind !== 'source-activation'
                && consumed.internalOrigin?.kind !== 'user-input') {
                const index = managed.messages.indexOf(consumed);
                if (index >= 0)
                    managed.messages.splice(index, 1);
            }
        };
        const retireUncertainDispatch = (retired: Message) => {
            const marker = retired.providerDispatch!;
            retired.providerDispatch = {
                ...marker,
                state: 'retired-uncertain',
                acceptedAt: undefined,
                retiredAt: Date.now(),
                retirementReason: 'superseded-by-new-human-objective',
            };
            retired.isQueued = false;
            managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== retired.id);
            if (retired.agentDelivery) {
                retired.agentDelivery.status = 'processed';
                retired.agentDelivery.providerDispatchUncertainAt ??= marker.markedAt;
            }
        };
        for (const staleAccepted of inertAcceptedDispatches)
            retireConsumedDispatch(staleAccepted);
        for (const staleUnknown of retiredUncertainDispatches)
            retireUncertainDispatch(staleUnknown);
        if (providerDispatchRecoveryEligible) {
            retireConsumedDispatch(exactBoundProviderDispatch!);
            const alreadyAllocatedContinuation = validAllocatedRecoveryDispatch(providerDispatchPending!);
            // A provider can ACK and complete without producing a transcript row.
            // The live path first persists a distinct generic allocation while the
            // accepted receipt still fences admission, then clears that receipt.
            // If the host crashes between those writes, retain the already-budgeted
            // allocation instead of discarding it and minting another attempt.
            managed.pendingTurnRecovery = alreadyAllocatedContinuation
                && alreadyAllocatedContinuation.id !== exactBoundProviderDispatch!.id
                ? providerDispatchPending
                : {
                    ...providerDispatchPending!,
                    lastCause: 'app_restart',
                    continuationRequired: true,
                    recoveryDispatch: undefined,
                };
            recoveredProviderDispatchNeedsContinuation = true;
        }
    }
    const providerDispatchSnapshotNeedsDurability = !!providerDispatchRollbackSnapshot;
    const providerDispatchQuarantineMessage = providerDispatchesAwaitingColdReconciliation(managed)[0];
    const now = Date.now();
    for (const message of managed.messages.slice(-SOURCE_ACTIVATION_TOMBSTONE_LIMIT * 2)) {
        if (message.role === 'user' && message.internalOrigin?.kind === 'source-activation'
            && message.timestamp + SOURCE_ACTIVATION_TOMBSTONE_TTL_MS > now) {
            rememberAutoRetryTombstone(managed, message.content, now, message.timestamp + SOURCE_ACTIVATION_TOMBSTONE_TTL_MS);
        }
    }
    const staleSourceActivationDropped = providerDispatchQuarantineMessage
        ? false
        : sessionOpDropDeferredSourceActivations(sessionOperationContext, managed, queuedHumanSupersedesSourceActivation);
    if (staleSourceActivationDropped) {
        sessionLog.warn('Dropped stale durable source-activation continuation during restore', {
            sessionId: managed.id,
            supersededByHuman: queuedHumanSupersedesSourceActivation,
        });
    }
    let recoveredProcessingAgentDelivery = false;
    let recoveredConsumedAgentDeliveryNeedsContinuation = false;
    for (const [messageIndex, message] of managed.messages.entries()) {
        if (message.role !== 'user' || message.agentDelivery?.status !== 'processing')
            continue;
        if (message.providerDispatch) {
            // The write-ahead predates the provider write. A host crash before its
            // correlated ACK can therefore never turn this exact receipt back into
            // runnable FIFO work.
            message.agentDelivery.status = 'processed';
            message.agentDelivery.providerDispatchUncertainAt ??= message.providerDispatch.markedAt;
            message.isQueued = false;
            recoveredProcessingAgentDelivery = true;
            continue;
        }
        const laterConsumptionActivity = managed.messages.slice(messageIndex + 1).some(candidate => (isDurableProviderActivityOrHumanSupersession(managed, candidate)));
        if (!laterConsumptionActivity) {
            // No provider evidence followed the claim. Replaying the same durable
            // receipt is the only path that cannot duplicate observed work.
            message.agentDelivery.status = 'queued';
            message.isQueued = true;
        }
        else {
            // Any persisted provider activity proves this exact child receipt was
            // consumed. Never replay it: a successful mutation/tool result could
            // otherwise run twice. Terminal output needs no new generation;
            // intermediate activity resumes through the objective recovery path.
            message.agentDelivery.status = 'processed';
            message.isQueued = false;
            if (managed.activeObjective?.terminalState === 'active') {
                const objective = managed.activeObjective;
                const existingRecovery = managed.pendingTurnRecovery;
                const recoveryAnchor = objective.lastUserMessageId ?? objective.userMessageId;
                managed.pendingTurnRecovery = {
                    ...(existingRecovery ?? createPendingTurnRecovery(recoveryAnchor, message.timestamp)),
                    userMessageId: existingRecovery?.userMessageId ?? recoveryAnchor,
                    lastCause: 'app_restart',
                    continuationRequired: true,
                };
                recoveredConsumedAgentDeliveryNeedsContinuation = true;
            }
        }
        recoveredProcessingAgentDelivery = true;
    }
    const durableRuntimeStateChanged = repairedSyntheticObjectiveAuthority
        || repairedContextualObjectiveAuthority
        || staleSourceActivationDropped || recoveredProcessingAgentDelivery
        || providerDispatchSnapshotNeedsDurability
        || disabledRoutingFallbackSanitization?.changed === true;
    if (recoveredConsumedAgentDeliveryNeedsContinuation || recoveredProviderDispatchNeedsContinuation) {
        sessionOperationContext.state.deferredAutomaticSessions.add(managed.id);
    }
    const providerBoundaryIndex = managed.providerContextBoundaryMessageId
        ? managed.messages.findIndex(message => message.id === managed.providerContextBoundaryMessageId)
        : -1;
    for (const [messageIndex, message] of managed.messages.entries()) {
        if (message.role !== 'user' || !message.isQueued || managed.messageQueue.some(item => item.messageId === message.id))
            continue;
        if (message.providerDispatch) {
            message.isQueued = false;
            continue;
        }
        if (message.agentDelivery && providerBoundaryIndex >= 0 && messageIndex < providerBoundaryIndex) {
            message.isQueued = false;
            message.agentDelivery.status = 'processed';
            continue;
        }
        const isBoundAutomaticRecovery = allocatedRecovery?.cause !== 'user_retry'
            && allocatedRecovery?.id === message.id && message.hidden === true && !message.agentDelivery
            && (allocatedRecovery.fallbackIntent
                ? message.internalOrigin?.kind === 'browser-fallback'
                : message.internalOrigin === undefined);
        const options: SendMessageOptions | undefined = isBoundAutomaticRecovery
            ? {
                hidden: true,
                ...(message.internalOrigin ? { internalOrigin: message.internalOrigin } : {}),
                automaticRecovery: {
                    originalUserMessageId: managed.pendingTurnRecovery!.userMessageId,
                    cause: allocatedRecovery.cause,
                    dispatchId: allocatedRecovery.id,
                    dispatchAttempt: allocatedRecovery.attempt,
                    dispatchOrigin: allocatedRecovery.origin,
                    dispatchAllocatedAt: allocatedRecovery.allocatedAt,
                    ...(allocatedRecovery.cleanContinuationId
                        ? { cleanContinuationId: allocatedRecovery.cleanContinuationId }
                        : {}),
                },
            }
            : recoveredInternalMessageOptions(message);
        enqueueRecoveredMessageInTranscriptOrder(managed, {
            message: message.content,
            messageId: message.id,
            storedAttachments: message.attachments,
            options,
        });
    }
    const closedColdResumeStatus = isClosedColdResumeStatus(managed);
    if ((managed.pendingAuthRequestId || managed.pendingAuthRequest)
        && queuedDirectHumanContinuationIndex(managed) >= 0) {
        // This capability is minted only while reconstructing a durable inbox.
        // A later, live user message cannot obtain the cold-resume downgrade.
        sessionOperationContext.state.coldAuthHumanContinuationSessions.add(managed);
    }
    else {
        sessionOperationContext.state.coldAuthHumanContinuationSessions.delete(managed);
    }
    const retainedMachineInbox = (sessionOpHasTerminalObjectiveState(sessionOperationContext, managed)
        && sessionOpHasOnlyMachineInbox(sessionOperationContext, managed))
        || (sessionOpHasAnyRetainedStoppedAgentDelivery(sessionOperationContext, managed) && sessionOpHasOnlyMachineInbox(sessionOperationContext, managed));
    publishColdProviderReconciliation(managed, sessionOperationContext, providerDispatchSnapshotNeedsDurability, providerDispatchRollbackSnapshot, providerDispatchQuarantineMessage, durableRuntimeStateChanged, retainedMachineInbox, closedColdResumeStatus, recoveredConsumedAgentDeliveryNeedsContinuation, recoveredProviderDispatchNeedsContinuation);
}

export { sessionOpRestoreDurableRuntimeState as restoreDurableRuntimeState };
