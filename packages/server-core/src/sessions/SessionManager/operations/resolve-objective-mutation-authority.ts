import type { PendingTurnRecovery } from '../../../../../shared/src/sessions/types/turn-recovery.ts';
import type { SessionCompletionEvent } from '../runtime-types.ts';
import type { SessionEvent } from '../../../../../shared/src/protocol/dto/session-events.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import { isLegacyHostObjectiveContractEnabled } from '../policy.ts';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { hasCurrentObjectiveIndependentReviewPass } from '../../objective-outcome';
import { canonicalTerminalReconciliationToolInput } from '@craft-agent/shared/agent';
import type { TerminalReconciliationPolicy } from '@craft-agent/shared/agent';
import { collectObjectiveAcceptanceObservations } from '../../objective-acceptance-criteria';
import type { SessionLifecycleStopReason } from '../../session-status-lifecycle';
import { objectiveRequiresExecutionEvidence, objectiveReviewBinding, isExplicitReadOnlyClosureRequest } from '../../objective-contract';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import type { SessionOperations } from '../operation-types.ts';
import { mintTerminalInvocationCapabilityKey as sessionOpMintTerminalInvocationCapabilityKey, authenticatedObjectiveAuthorizationSegments as sessionOpAuthenticatedObjectiveAuthorizationSegments } from './repair-legacy-synthetic-objective-authority.ts';
import { hasOnlyMachineInbox as sessionOpHasOnlyMachineInbox } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { getLastFinalAssistantMessageId as sessionOpGetLastFinalAssistantMessageId } from './session-sources.ts';
import { cancelPendingAuthForHumanContinuation as sessionOpCancelPendingAuthForHumanContinuation } from './downgrade-cold-auth-resume-permission.ts';

function sessionOpResolveObjectiveMutationAuthority(sessionOperationContext: SessionOperationContext, managed: ManagedSession, objective: ActiveSessionObjective | undefined): {
    authorized: boolean;
    sensitiveActionAuthorized: boolean;
    authorizationSegments: string[];
    authenticatedUserAuthorizationSegments?: string[];
    terminalReconciliationPolicy?: TerminalReconciliationPolicy;
} {
    const emptyPolicy = (kind: TerminalReconciliationPolicy['kind']): TerminalReconciliationPolicy => ({
        kind,
        allowInitialCriteriaRegistration: false,
        allowReviewerSpawn: false,
        readReplays: [],
        waitReviewerSessionIds: [],
    });
    const deny = (kind: TerminalReconciliationPolicy['kind']) => ({
        authorized: false,
        sensitiveActionAuthorized: false,
        authorizationSegments: [],
        terminalReconciliationPolicy: emptyPolicy(kind),
    });
    const sameReviewBinding = (left: {
        objectiveId: string;
        acceptanceSha256: string;
    } | undefined, right: {
        objectiveId: string;
        acceptanceSha256: string;
    }) => !!left && left.objectiveId === right.objectiveId
        && left.acceptanceSha256 === right.acceptanceSha256;
    const terminalPolicy = (owner: ManagedSession, terminalObjective: ActiveSessionObjective, coordination: boolean): TerminalReconciliationPolicy | undefined => {
        const marker = terminalObjective.terminalReconciliation;
        if (!marker)
            return undefined;
        if (terminalObjective.terminalState !== 'active') {
            return emptyPolicy('terminal-reconciliation');
        }
        const binding = objectiveReviewBinding(terminalObjective);
        const initialRegistration = coordination
            && marker.initialAcceptanceRegistrationRequired === true
            && terminalObjective.requiresAcceptanceCriteria === true
            && (!terminalObjective.acceptanceCriteria?.length
                || terminalObjective.acceptanceNeedsReview === true);
        const reviewerEligible = coordination
            && marker.initialAcceptanceRegistrationRequired === true
            && terminalObjective.requiresAcceptanceCriteria === true
            && !!terminalObjective.acceptanceCriteria?.length
            && terminalObjective.acceptanceNeedsReview !== true
            && terminalObjective.acceptanceRegisteredRevision
                === (terminalObjective.acceptanceRevision ?? terminalObjective.userMessageId)
            && Number.isFinite(terminalObjective.acceptanceRegisteredAt)
            && terminalObjective.acceptanceRegisteredAt! >= marker.timestamp
            && terminalObjective.completionCriteria.includes('independent-review-passed')
            && !hasCurrentObjectiveIndependentReviewPass(terminalObjective, owner.messages, terminalObjective.acceptanceRegisteredAt);
        const replayKeys = new Set<string>();
        const readReplays = initialRegistration ? [] : collectObjectiveAcceptanceObservations(terminalObjective, [...owner.messages], owner.id).flatMap(({ message }) => {
            if (!message.toolName)
                return [];
            const toolInputJson = canonicalTerminalReconciliationToolInput(message.toolInput);
            if (toolInputJson === undefined)
                return [];
            const key = `${message.toolName}\u0000${toolInputJson}`;
            if (replayKeys.has(key))
                return [];
            replayKeys.add(key);
            return [{ toolName: message.toolName, toolInputJson }];
        });
        const waitReviewerSessionIds = coordination ? [...sessionOperationContext.state.sessions.values()].flatMap(candidate => {
            if (candidate.parentSessionId !== owner.id || candidate.delegation?.role !== 'reviewer'
                || candidate.workspace.id !== owner.workspace.id
                || candidate.delegation.rootSessionId !== owner.id
                || candidate.delegation.depth !== 1
                || candidate.delegation.rootObjectiveId !== binding.objectiveId
                || candidate.delegation.parentObjectiveId !== binding.objectiveId
                || !sameReviewBinding(candidate.delegation.reviewBinding, binding))
                return [];
            const persistedAttempt = !!candidate.activeObjective || candidate.messages.some(message => (message.role === 'user' && !!message.internalOrigin)) || !!candidate.pendingQueuedMessageIds?.length
                || !!candidate.pendingAgentDeliveryIds?.length;
            const activeAttempt = candidate.isProcessing || candidate.messageQueue.length > 0
                || !!candidate.pendingTurnRecovery || sessionOperationContext.state.automaticAdmissionReservations.has(candidate.id);
            return persistedAttempt || activeAttempt ? [candidate.id] : [];
        }).sort() : [];
        const allowReviewerSpawn = reviewerEligible && waitReviewerSessionIds.length === 0;
        const invocationCapabilityKey = coordination
            && (initialRegistration || allowReviewerSpawn || waitReviewerSessionIds.length > 0)
            ? sessionOpMintTerminalInvocationCapabilityKey(sessionOperationContext, owner, terminalObjective, {
                allowInitialCriteriaRegistration: initialRegistration,
                allowReviewerSpawn,
                waitReviewerSessionIds,
            })
            : undefined;
        return {
            kind: 'terminal-reconciliation',
            allowInitialCriteriaRegistration: initialRegistration,
            allowReviewerSpawn,
            readReplays,
            waitReviewerSessionIds,
            ...(invocationCapabilityKey ? { invocationCapabilityKey } : {}),
        };
    };
    if (!objective)
        return deny('missing-objective');
    // A persisted delegation is an authority boundary. Any missing, foreign or
    // stale lineage denies every tool rather than falling back to the child's
    // model-authored objective. Terminal reviewer bindings are stronger than
    // legacy objective IDs but still require their direct parent and root.
    if (managed.delegation) {
        const delegation = managed.delegation;
        const parent = managed.parentSessionId ? sessionOperationContext.state.sessions.get(managed.parentSessionId) : undefined;
        const root = sessionOperationContext.state.sessions.get(delegation.rootSessionId);
        if (!parent || !root || parent.workspace.id !== managed.workspace.id
            || root.workspace.id !== managed.workspace.id)
            return deny('invalid-lineage');
        const parentObjective = parent.activeObjective;
        const rootObjective = root.activeObjective;
        if (delegation.reviewBinding) {
            if (delegation.role !== 'reviewer' || root.id !== parent.id || delegation.depth !== 1
                || delegation.rootObjectiveId !== delegation.reviewBinding.objectiveId
                || delegation.parentObjectiveId !== delegation.reviewBinding.objectiveId
                || !parentObjective
                || !sameReviewBinding(delegation.reviewBinding, objectiveReviewBinding(parentObjective))) {
                return deny('invalid-lineage');
            }
            const inherited = terminalPolicy(parent, parentObjective, false);
            return inherited ? {
                authorized: false,
                sensitiveActionAuthorized: false,
                authorizationSegments: [],
                terminalReconciliationPolicy: inherited,
            } : deny('invalid-lineage');
        }
        if (!rootObjective || !parentObjective
            || (rootObjective.objectiveId ?? rootObjective.userMessageId) !== delegation.rootObjectiveId
            || (parentObjective.objectiveId ?? parentObjective.userMessageId) !== delegation.parentObjectiveId) {
            return deny('invalid-lineage');
        }
        const inherited = terminalPolicy(root, rootObjective, false);
        if (inherited)
            return {
                authorized: false,
                sensitiveActionAuthorized: false,
                authorizationSegments: [],
                terminalReconciliationPolicy: inherited,
            };
        if (rootObjective.terminalState !== 'active' || parentObjective.terminalState !== 'active') {
            return deny('invalid-lineage');
        }
        const authoritySegments = sessionOpAuthenticatedObjectiveAuthorizationSegments(sessionOperationContext, root, rootObjective);
        return {
            authorized: authoritySegments.authorizationSegments.length > 0
                && objectiveRequiresExecutionEvidence(objective),
            sensitiveActionAuthorized: authoritySegments.authorizationSegments.length > 0
                && objectiveRequiresExecutionEvidence(rootObjective),
            authorizationSegments: authoritySegments.authorizationSegments,
            ...(authoritySegments.authenticatedUserAuthorizationSegments.length > 0 ? {
                authenticatedUserAuthorizationSegments: authoritySegments.authenticatedUserAuthorizationSegments,
            } : {}),
        };
    }
    if (managed.parentSessionId)
        return deny('invalid-lineage');
    const policy = terminalPolicy(managed, objective, true);
    if (policy)
        return {
            authorized: false,
            sensitiveActionAuthorized: false,
            authorizationSegments: [],
            terminalReconciliationPolicy: policy,
        };
    if (objective.terminalState !== 'active')
        return deny('invalid-lineage');
    const authoritySegments = sessionOpAuthenticatedObjectiveAuthorizationSegments(sessionOperationContext, managed, objective);
    return {
        authorized: authoritySegments.authorizationSegments.length > 0
            && objectiveRequiresExecutionEvidence(objective),
        sensitiveActionAuthorized: authoritySegments.authorizationSegments.length > 0
            && objectiveRequiresExecutionEvidence(objective),
        authorizationSegments: authoritySegments.authorizationSegments,
        ...(authoritySegments.authenticatedUserAuthorizationSegments.length > 0 ? {
            authenticatedUserAuthorizationSegments: authoritySegments.authenticatedUserAuthorizationSegments,
        } : {}),
    };
}

/** Resolve the live tool capability frontier. A durable queued closure and
 * every accepted steer revoke the previous provider turn immediately; only
 * a call correlated to the new accepted request may use its new objective. */
function sessionOpResolveRuntimeObjectiveMutationAuthority(sessionOperationContext: SessionOperationContext, managed: ManagedSession, currentUserRequest?: string): Omit<ReturnType<SessionOperations['resolveObjectiveMutationAuthority']>, 'authorized' | 'sensitiveActionAuthorized'> & {
    authorized: boolean | undefined;
    sensitiveActionAuthorized: boolean | undefined;
} {
    const denyAll = (kind: TerminalReconciliationPolicy['kind']) => ({
        authorized: false,
        sensitiveActionAuthorized: false,
        authorizationSegments: [],
        terminalReconciliationPolicy: {
            kind,
            allowInitialCriteriaRegistration: false,
            allowReviewerSpawn: false,
            readReplays: [],
            waitReviewerSessionIds: [],
        } satisfies TerminalReconciliationPolicy,
    });
    // A direct human no-effect closure is authoritative as soon as its queued
    // row is durable. This latch survives redirect=false and application
    // restart, and closes the previous provider's entire tool surface.
    if (managed.messages.some(message => message.role === 'user' && message.isQueued
        && !message.hidden && !message.internalOrigin && !message.agentDelivery
        && isExplicitReadOnlyClosureRequest(message.content))) {
        return denyAll('terminal-reconciliation');
    }
    const pendingSteers = managed.pendingUserSteers;
    const resolveBaseAuthority = () => {
        if (pendingSteers?.size) {
            // New authority is usable only by the request that introduced it. An old
            // request, an uncorrelated retry, or a provider reentry after permission/
            // source activation receives no capabilities at all.
            const accepted = currentUserRequest
                ? pendingSteers.get(currentUserRequest)?.objectiveAfter
                : undefined;
            if (accepted)
                return sessionOpResolveObjectiveMutationAuthority(sessionOperationContext, managed, accepted);
            const terminalLocked = [...pendingSteers.values()].some(pending => (!!pending.objectiveAfter?.terminalReconciliation));
            return denyAll(terminalLocked ? 'terminal-reconciliation' : 'invalid-lineage');
        }
        return sessionOpResolveObjectiveMutationAuthority(sessionOperationContext, managed, managed.activeObjective);
    };
    const authority = resolveBaseAuthority();
    if (isLegacyHostObjectiveContractEnabled(managed)) {
        return authority;
    }
    return {
        authorized: undefined,
        sensitiveActionAuthorized: undefined,
        authorizationSegments: authority.authorizationSegments ?? [],
        ...('authenticatedUserAuthorizationSegments' in authority && authority.authenticatedUserAuthorizationSegments ? {
            authenticatedUserAuthorizationSegments: authority.authenticatedUserAuthorizationSegments,
        } : {}),
    };
}

async function sessionOpReconcileRetainedTerminalMachineInbox(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    const objective = managed?.activeObjective;
    if (!managed || managed.isProcessing || !objective || objective.terminalState === 'active'
        || !sessionOpHasOnlyMachineInbox(sessionOperationContext, managed))
        return;
    sessionOperationContext.state.deferredAutomaticSessions.delete(sessionId);
    sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
    const reason: SessionLifecycleStopReason = objective.terminalState === 'complete_verified' ? 'complete' : 'error';
    const reconciled = await sessionOperationContext.owner.reconcileRecoveredTerminalStatus(managed, reason);
    // The retained machine inbox intentionally survives restart. Publish the
    // reconstructed completion only when this hydration actually repaired a
    // stale lifecycle status; subsequent cold loads are idempotent.
    if (!reconciled)
        return;
    if (sessionOperationContext.state.sessions.get(sessionId) !== managed || managed.activeObjective !== objective
        || managed.activeObjective?.terminalState === 'active' || managed.isProcessing
        || !sessionOpHasOnlyMachineInbox(sessionOperationContext, managed))
        return;
    sessionOperationContext.owner.emitObjectiveChanged(managed);
    sessionOperationContext.owner["sendEvent"](omitUndefined<Extract<SessionEvent, { type: 'complete' }>>({
        type: 'complete', sessionId, reason, tokenUsage: managed.tokenUsage,
        hasUnread: managed.hasUnread, backgroundTasksAlive: sessionOperationContext.state.keepBackgroundTasksAlive,
    }), managed.workspace.id);
    const finalMessageId = sessionOpGetLastFinalAssistantMessageId(sessionOperationContext, managed.messages);
    sessionOperationContext.owner.emitSessionComplete(omitUndefined<SessionCompletionEvent>({
        sessionId, workspaceId: managed.workspace.id, reason, ...(finalMessageId !== undefined ? { finalMessageId: finalMessageId } : {}),
        finalText: finalMessageId ? managed.messages.find(message => message.id === finalMessageId)?.content : undefined,
        ...(managed.tokenUsage !== undefined ? { tokenUsage: managed.tokenUsage } : {}),
    }));
}

/** A direct chat continuation closes obsolete human handoffs fail-closed. It
 * never fabricates a structured answer and never approves an old tool. */
function sessionOpSupersedeHumanHandoffsForDirectContinuation(sessionOperationContext: SessionOperationContext, managed: ManagedSession): {
    changed: boolean;
    userInputChanged: boolean;
    rollbackFailedDurability: () => boolean;
} {
    let changed = false;
    let userInputChanged = false;
    const cancellationEpoch = sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0;
    const previousRecovery = managed.pendingTurnRecovery;
    const previousPermissionWait = previousRecovery?.waitingForPermission
        ? { ...previousRecovery.waitingForPermission }
        : undefined;
    const cancelledUserInputs: Array<{
        request: NonNullable<ManagedSession['userInputRequests']>[number];
        answeredAt: number | undefined;
        cancelledAt: number;
    }> = [];
    // Revoke provider/admin capabilities before removing the durable marker.
    // The broker helper always responds false and records toolExecuted=false.
    const pendingPermissions = [...sessionOperationContext.state.pendingPermissionRequests.values()]
        .filter(request => request.sessionId === managed.id);
    const pendingPermissionCount = pendingPermissions.length;
    if (pendingPermissionCount) {
        for (const generation of new Set(pendingPermissions.map(request => request.processingGeneration))) {
            void sessionOperationContext.owner.closePendingPermissionRequestsForStop(managed, generation);
        }
        changed = true;
    }
    if (managed.pendingTurnRecovery?.waitingForPermission || managed.pendingTurnRecovery?.recoveryDispatch) {
        managed.pendingTurnRecovery = omitUndefined<PendingTurnRecovery>({
            ...managed.pendingTurnRecovery,
            waitingForPermission: undefined,
            recoveryDispatch: undefined,
        });
        changed = true;
    }
    if (sessionOpCancelPendingAuthForHumanContinuation(sessionOperationContext, managed))
        changed = true;
    // `respondToUserInput` changes pending -> answered and creates its hidden
    // message synchronously before its first await. Therefore a response which
    // won the race is immutable here and cannot be mistaken for an old prompt.
    for (const request of managed.userInputRequests ?? []) {
        if (request.status !== 'pending' || request.sessionId !== managed.id
            || request.originWorkspaceId !== managed.workspace.id
            || request.responseMessageId || request.answers
            || sessionOperationContext.state.userInputResponsesInFlight.has(request.id))
            continue;
        const answeredAt = request.answeredAt;
        request.status = 'cancelled';
        request.answeredAt = Math.max(Date.now(), (request.answeredAt ?? 0) + 1);
        cancelledUserInputs.push({ request, answeredAt, cancelledAt: request.answeredAt });
        changed = true;
        userInputChanged = true;
    }
    if (changed) {
        sessionLog.info('Superseded obsolete human handoff for direct continuation', {
            sessionId: managed.id,
            closedPermissionRequests: pendingPermissionCount,
            userInputChanged,
        });
    }
    return {
        changed,
        userInputChanged,
        rollbackFailedDurability: () => {
            // Permission/provider cancellation and auth/credential invalidation are
            // irreversible once callbacks have been closed. Never recreate those
            // capabilities. Restore only the local question state and a
            // recoveryRequired permission marker, which is non-authorizing Retry
            // context, when this exact send still owns the cancellation epoch.
            if (sessionOperationContext.state.shuttingDown || sessionOperationContext.state.sessions.get(managed.id) !== managed
                || managed.stopRequested
                || (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== cancellationEpoch)
                return false;
            let restored = false;
            for (const { request, answeredAt, cancelledAt } of cancelledUserInputs) {
                if (request.status !== 'cancelled' || request.answeredAt !== cancelledAt
                    || request.answers || request.responseMessageId
                    || sessionOperationContext.state.userInputResponsesInFlight.has(request.id))
                    continue;
                request.status = 'pending';
                if (answeredAt === undefined)
                    delete request.answeredAt;
                else
                    request.answeredAt = answeredAt;
                restored = true;
            }
            if (previousPermissionWait && !managed.pendingTurnRecovery?.waitingForPermission) {
                managed.pendingTurnRecovery = omitUndefined<PendingTurnRecovery>({
                    ...(managed.pendingTurnRecovery ?? previousRecovery!),
                    waitingForPermission: { ...previousPermissionWait, recoveryRequired: true },
                    // The old provider/tool capability was denied above. Its dispatch
                    // must never be revived by an in-memory or later durable rollback.
                    recoveryDispatch: undefined,
                });
                restored = true;
            }
            return restored;
        },
    };
}

export { sessionOpResolveObjectiveMutationAuthority as resolveObjectiveMutationAuthority };
export { sessionOpResolveRuntimeObjectiveMutationAuthority as resolveRuntimeObjectiveMutationAuthority };
export { sessionOpReconcileRetainedTerminalMachineInbox as reconcileRetainedTerminalMachineInbox };
export { sessionOpSupersedeHumanHandoffsForDirectContinuation as supersedeHumanHandoffsForDirectContinuation };
