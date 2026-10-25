import type { SessionOperationContext } from '../operation-context.ts';
import { isExactQueuedSourceActivation, cancelSourceActivationPending, releaseSourceActivationClaim, hasAuthenticatedObjectiveRoot } from '../policy.ts';
import { randomUUID } from 'node:crypto';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { deriveTerminalReconciliationInvocationCapability } from '@craft-agent/shared/agent';
import { findObjectiveText, isHostSyntheticObjectiveMessage, isHostSyntheticObjectiveText, reconstructObjectiveForBranch, isExplicitReadOnlyClosureRequest } from '../../objective-contract';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { SOURCE_ACTIVATION_MAX_DISPATCH_ATTEMPTS, SOURCE_ACTIVATION_TOMBSTONE_TTL_MS, isSourceActivationOriginCurrent, rememberAutoRetryTombstone, sourceActivationObjectiveBinding } from '../source-activation.ts';
import { AUTHENTICATED_USER_AUTHORIZATION_MARKER, authenticatedUserInputAnswerAuthoritySegments, legacyUserInputAnswerMessageContent, userInputAnswerMessageContent } from '../user-input-authority.ts';

function sessionOpScheduleSourceActivationDispatch(sessionOperationContext: SessionOperationContext, managed: ManagedSession, dispatchToken: symbol, delayMs = 100): void {
    if (managed.autoRetryTimer)
        clearTimeout(managed.autoRetryTimer);
    managed.autoRetryTimer = setTimeout(() => {
        const current = sessionOperationContext.state.sessions.get(managed.id);
        if (current !== managed)
            return;
        current.autoRetryTimer = undefined;
        const pending = current.autoRetryPending;
        const binding = sourceActivationObjectiveBinding(current.activeObjective);
        const humanFollowUpArrived = !!pending && current.messages
            .slice(pending.messageCountAtSchedule)
            .some(message => message.role === 'user' && !message.hidden && !message.internalOrigin);
        const stillCurrent = !!pending && pending.dispatchToken === dispatchToken
            && !pending.cancelled && !pending.committed && !pending.dispatchInFlight
            && !sessionOperationContext.state.shuttingDown && !current.stopRequested
            && current.processingGeneration === pending.generation
            && (sessionOperationContext.state.turnCancellationEpochs.get(current) ?? 0) === pending.cancellationEpoch
            && !!binding && binding.objectiveId === pending.objectiveId
            && binding.objectiveRevision === pending.objectiveRevision
            && !humanFollowUpArrived;
        if (!stillCurrent) {
            if (pending?.dispatchToken === dispatchToken)
                cancelSourceActivationPending(current, pending);
            return;
        }
        pending.dispatchAttempts++;
        void sessionOperationContext.owner.sendMessage(current.id, pending.content, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, dispatchToken).catch(error => {
            const latest = current.autoRetryPending;
            if (latest?.dispatchToken === dispatchToken && !latest.committed && !latest.cancelled) {
                releaseSourceActivationClaim(current, dispatchToken);
                if (latest.dispatchAttempts < SOURCE_ACTIVATION_MAX_DISPATCH_ATTEMPTS
                    && !sessionOperationContext.state.shuttingDown && !current.stopRequested
                    && (sessionOperationContext.state.turnCancellationEpochs.get(current) ?? 0) === latest.cancellationEpoch) {
                    sessionOpScheduleSourceActivationDispatch(sessionOperationContext, current, dispatchToken);
                }
                else
                    cancelSourceActivationPending(current, latest);
            }
            sessionLog.error(`Auto-retry sendMessage failed for ${current.id}:`, error);
        });
    }, delayMs);
}

function sessionOpInvalidateSourceActivationRestart(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    const changed = cancelSourceActivationPending(managed);
    managed.sourceActivationRestartGeneration = undefined;
    managed.sourceActivationTurn = undefined;
    return changed;
}

/** Remove only deferred source-activation rows. Completed history remains
 * intact, while legacy/unbound rows and rows for another objective can never
 * be promoted into a real user turn during restore or dequeue. */
function sessionOpDropDeferredSourceActivations(sessionOperationContext: SessionOperationContext, managed: ManagedSession, supersededByHuman = false): boolean {
    let changed = false;
    const currentBinding = sourceActivationObjectiveBinding(managed.activeObjective);
    if (managed.autoRetryPending && (supersededByHuman || !currentBinding
        || managed.autoRetryPending.objectiveId !== currentBinding.objectiveId
        || managed.autoRetryPending.objectiveRevision !== currentBinding.objectiveRevision)) {
        if (cancelSourceActivationPending(managed))
            changed = true;
    }
    const removedIds = new Set<string>();
    for (let index = managed.messages.length - 1; index >= 0; index--) {
        const message = managed.messages[index]!;
        if (message.role !== 'user' || message.internalOrigin?.kind !== 'source-activation')
            continue;
        const pendingPreparation = managed.autoRetryPending?.messageId === message.id
            && managed.autoRetryPending.providerStarted !== true;
        if (message.isQueued !== true && !pendingPreparation)
            continue;
        if (!supersededByHuman
            && message.hidden === true && !message.isPending && !message.agentDelivery
            && isSourceActivationOriginCurrent(managed.activeObjective, message.internalOrigin))
            continue;
        rememberAutoRetryTombstone(managed, message.content, Date.now(), Math.max(Date.now() + 1, message.timestamp + SOURCE_ACTIVATION_TOMBSTONE_TTL_MS));
        removedIds.add(message.id);
        managed.messages.splice(index, 1);
        changed = true;
    }
    const retained = managed.messageQueue.filter(item => {
        if (item.options?.internalOrigin?.kind !== 'source-activation')
            return true;
        const keep = !supersededByHuman && !removedIds.has(item.messageId ?? '')
            && isExactQueuedSourceActivation(managed, item);
        if (!keep)
            changed = true;
        return keep;
    });
    if (retained.length !== managed.messageQueue.length)
        managed.messageQueue = retained;
    return changed;
}

/** Return only transcript-backed authority text. Durable objective metadata is
 * routing state, not a substitute for an accepted human (or authenticated
 * automation/delegation root) row. */
function sessionOpAuthenticatedObjectiveAuthorizationSegments(sessionOperationContext: SessionOperationContext, owner: ManagedSession, objective: ActiveSessionObjective): {
    authorizationSegments: string[];
    authenticatedUserAuthorizationSegments: string[];
} {
    const empty = { authorizationSegments: [], authenticatedUserAuthorizationSegments: [] };
    if (objective.terminalState !== 'active' || !hasAuthenticatedObjectiveRoot(owner, objective))
        return empty;
    const rootMatches = owner.messages.filter(message => message.id === objective.userMessageId);
    const root = rootMatches.length === 1 ? rootMatches[0] : undefined;
    const rootText = findObjectiveText(owner.messages, objective);
    if (!root || !rootText || root.content !== rootText || isHostSyntheticObjectiveText(rootText))
        return empty;
    const rootIndex = owner.messages.indexOf(root);
    const seenIds = new Set<string>([root.id]);
    const segments: Array<{
        text: string;
        index: number;
        order: number;
    }> = [{
            text: rootText, index: rootIndex, order: 0,
        }];
    const authenticatedUserAuthorizationSegments: string[] = [];
    for (const amendment of objective.amendments ?? []) {
        if (seenIds.has(amendment.messageId)
            || !amendment.text.trim() || isHostSyntheticObjectiveText(amendment.text)
            || isExplicitReadOnlyClosureRequest(amendment.text))
            continue;
        seenIds.add(amendment.messageId);
        const matches = owner.messages.filter(message => message.id === amendment.messageId);
        const message = matches.length === 1 ? matches[0] : undefined;
        const messageIndex = message ? owner.messages.indexOf(message) : -1;
        if (!message || message.role !== 'user' || message.hidden || message.isQueued || message.isPending
            || message.agentDelivery || message.internalOrigin || message.content !== amendment.text
            || isHostSyntheticObjectiveMessage(message) || messageIndex <= rootIndex)
            continue;
        segments.push({ text: amendment.text, index: messageIndex, order: 0 });
    }
    for (const request of owner.userInputRequests ?? []) {
        if (request.objectiveUserMessageId !== objective.userMessageId
            || request.sessionId !== owner.id
            || request.originWorkspaceId !== owner.workspace.id
            || !request.responseMessageId || seenIds.has(request.responseMessageId))
            continue;
        const matches = owner.messages.filter(message => message.id === request.responseMessageId);
        const message = matches.length === 1 ? matches[0] : undefined;
        const messageIndex = message ? owner.messages.indexOf(message) : -1;
        if (!message || message.role !== 'user' || message.hidden !== true
            || message.isQueued || message.isPending || message.agentDelivery
            || message.internalOrigin?.kind !== 'user-input'
            || messageIndex <= rootIndex || !request.answers?.length
            || ![
                userInputAnswerMessageContent(request.id, request.questions, request.answers),
                legacyUserInputAnswerMessageContent(request.id, request.questions, request.answers),
            ].includes(message.content))
            continue;
        const answerSegments = authenticatedUserInputAnswerAuthoritySegments(request);
        if (answerSegments.length === 0)
            continue;
        seenIds.add(message.id);
        answerSegments.forEach((text, order) => {
            segments.push({ text, index: messageIndex, order });
            if (text.startsWith(`${AUTHENTICATED_USER_AUTHORIZATION_MARKER}\n`)) {
                authenticatedUserAuthorizationSegments.push(text);
            }
        });
    }
    const authorizationSegments = segments.sort((left, right) => (left.index - right.index || left.order - right.order)).map(segment => segment.text);
    return { authorizationSegments, authenticatedUserAuthorizationSegments };
}

/**
 * Mint a short-lived, in-memory key for one PreToolUse decision. The key is
 * never sent to the tool; the shared gate derives an input-bound digest from
 * it. Handlers consume that digest exactly once and re-check this immutable
 * runtime/objective snapshot before any effect.
 */
function sessionOpMintTerminalInvocationCapabilityKey(sessionOperationContext: SessionOperationContext, managed: ManagedSession, objective: ActiveSessionObjective, scope: {
    allowInitialCriteriaRegistration: boolean;
    allowReviewerSpawn: boolean;
    waitReviewerSessionIds: readonly string[];
}): string {
    const now = Date.now();
    for (const [key, capability] of sessionOperationContext.state.terminalInvocationCapabilities) {
        if (capability.expiresAt <= now)
            sessionOperationContext.state.terminalInvocationCapabilities.delete(key);
    }
    while (sessionOperationContext.state.terminalInvocationCapabilities.size >= 256) {
        const oldest = sessionOperationContext.state.terminalInvocationCapabilities.keys().next().value as string | undefined;
        if (!oldest)
            break;
        sessionOperationContext.state.terminalInvocationCapabilities.delete(oldest);
    }
    const key = randomUUID();
    sessionOperationContext.state.terminalInvocationCapabilities.set(key, {
        managed,
        agent: managed.agent,
        generation: managed.processingGeneration,
        authorityEpoch: sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0,
        objective,
        scope: {
            allowInitialCriteriaRegistration: scope.allowInitialCriteriaRegistration,
            allowReviewerSpawn: scope.allowReviewerSpawn,
            waitReviewerSessionIds: [...scope.waitReviewerSessionIds],
        },
        expiresAt: now + 60000,
    });
    return key;
}

function sessionOpConsumeTerminalInvocationCapability(sessionOperationContext: SessionOperationContext, managed: ManagedSession, toolName: string, input: Record<string, unknown>, presented: string | undefined): boolean {
    if (!presented)
        return false;
    const suffix = toolName.replace(/^(?:mcp__session__|session__)/u, '');
    const toolAliases = new Set([
        toolName,
        suffix,
        `session__${suffix}`,
        `mcp__session__${suffix}`,
    ]);
    const now = Date.now();
    for (const [key, capability] of sessionOperationContext.state.terminalInvocationCapabilities) {
        if (capability.expiresAt <= now) {
            sessionOperationContext.state.terminalInvocationCapabilities.delete(key);
            continue;
        }
        const matches = [...toolAliases].some(alias => (deriveTerminalReconciliationInvocationCapability(key, alias, input) === presented));
        if (!matches)
            continue;
        // Consume before checking freshness. A stale/foreign invocation never
        // gets a second attempt and the digest is not reusable after an error.
        sessionOperationContext.state.terminalInvocationCapabilities.delete(key);
        const requestedSessionIds = Array.isArray(input.sessionIds) ? input.sessionIds : [];
        const scopeAllows = suffix === 'set_completion_criteria'
            ? capability.scope.allowInitialCriteriaRegistration
            : suffix === 'spawn_session'
                ? capability.scope.allowReviewerSpawn
                : suffix === 'wait_sessions'
                    ? requestedSessionIds.length > 0 && requestedSessionIds.every(id => (typeof id === 'string' && capability.scope.waitReviewerSessionIds.includes(id)))
                    : false;
        return capability.managed === managed
            && scopeAllows
            && capability.agent === managed.agent
            && capability.generation === managed.processingGeneration
            && capability.authorityEpoch === (sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0)
            && capability.objective === managed.activeObjective
            && capability.objective.terminalState === 'active'
            && !!capability.objective.terminalReconciliation;
    }
    return false;
}

/**
 * Migrate only a demonstrably non-authoritative root. The human transcript is
 * replayed to recover its semantic constraints; verification criteria and
 * accounting remain context, but cannot grant mutation authority themselves.
 */
function sessionOpRepairLegacySyntheticObjectiveAuthority(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    const previous = managed.activeObjective;
    if (!previous)
        return false;
    const rootMatches = managed.messages.filter(message => message.id === previous.userMessageId);
    const persistedSyntheticText = !!previous.originalText && isHostSyntheticObjectiveMessage({
        id: previous.userMessageId,
        role: 'user',
        content: previous.originalText,
        timestamp: previous.startedAt,
    });
    // A durable contract can legitimately outlive a locally compacted root
    // message. Migrate only when the persisted text itself is an exact host
    // envelope, or when one concrete transcript row proves non-human origin.
    if (!persistedSyntheticText && (rootMatches.length !== 1
        || hasAuthenticatedObjectiveRoot(managed, previous)))
        return false;
    const authorityMessages = managed.messages.filter(message => {
        if (message.internalOrigin?.kind === 'spawned-session') {
            return !!managed.parentSessionId
                && managed.parentSessionId !== managed.id
                && message.internalOrigin.senderSessionId === managed.parentSessionId;
        }
        if (message.internalOrigin?.kind === 'automation')
            return !!managed.triggeredBy;
        return true;
    });
    const recovered = reconstructObjectiveForBranch({
        messages: authorityMessages,
        sourceObjective: previous,
        completeSourceHistory: false,
    });
    if (!recovered || !hasAuthenticatedObjectiveRoot(managed, recovered)) {
        managed.activeObjective = undefined;
        managed.pendingTurnRecovery = undefined;
        return true;
    }
    const lineageIds = new Set([
        recovered.userMessageId,
        recovered.lastUserMessageId,
        ...(recovered.amendments ?? []).map(amendment => amendment.messageId),
    ].filter((id): id is string => !!id));
    const registrationRevision = previous.acceptanceRegisteredRevision ?? previous.acceptanceRevision;
    const preserveAcceptance = !!previous.acceptanceCriteria?.length
        && !!registrationRevision
        && lineageIds.has(registrationRevision)
        && (!previous.acceptanceRevision || lineageIds.has(previous.acceptanceRevision));
    managed.activeObjective = {
        ...recovered,
        // Do not charge the recovered human objective again for work performed
        // while the legacy synthetic root was active.
        budgetBaselineUsd: previous.budgetBaselineUsd,
        tokenBaseline: previous.tokenBaseline,
        terminalState: previous.terminalState,
        ...(previous.completedAt !== undefined ? { completedAt: previous.completedAt } : {}),
        ...(previous.lastOutcome ? { lastOutcome: previous.lastOutcome } : {}),
        ...(previous.automaticModelTier
            ? { automaticModelTier: previous.automaticModelTier } : {}),
        ...(previous.model ? { model: previous.model } : {}),
        ...(previous.thinkingLevel ? { thinkingLevel: previous.thinkingLevel } : {}),
        ...(previous.procedure ? { procedure: previous.procedure } : {}),
        ...(preserveAcceptance ? {
            requiresAcceptanceCriteria: true,
            acceptanceCriteria: previous.acceptanceCriteria,
            ...(previous.acceptanceRegisteredAt !== undefined
                ? { acceptanceRegisteredAt: previous.acceptanceRegisteredAt } : {}),
            ...(previous.acceptanceRegisteredAtById
                ? { acceptanceRegisteredAtById: previous.acceptanceRegisteredAtById } : {}),
            ...(previous.acceptanceRevision ? { acceptanceRevision: previous.acceptanceRevision } : {}),
            ...(previous.acceptanceRegisteredRevision
                ? { acceptanceRegisteredRevision: previous.acceptanceRegisteredRevision } : {}),
            ...(previous.acceptanceNeedsReview !== undefined
                ? { acceptanceNeedsReview: previous.acceptanceNeedsReview } : {}),
            ...(previous.acceptanceHistory ? { acceptanceHistory: previous.acceptanceHistory } : {}),
        } : {}),
        ...(preserveAcceptance && recovered.terminalReconciliation ? {
            terminalReconciliation: {
                messageId: recovered.terminalReconciliation.messageId,
                timestamp: recovered.terminalReconciliation.timestamp,
                ...(previous.terminalReconciliation?.messageId === recovered.terminalReconciliation.messageId
                    && previous.terminalReconciliation.initialAcceptanceRegistrationRequired === true
                    ? { initialAcceptanceRegistrationRequired: true as const } : {}),
            },
        } : {}),
    };
    if (managed.pendingTurnRecovery
        && !lineageIds.has(managed.pendingTurnRecovery.userMessageId)) {
        managed.pendingTurnRecovery = undefined;
    }
    return true;
}

/** Only explicit terminal states are terminal. Legacy objectives with no
 * state remain recoverable instead of being silently treated as completed. */
function sessionOpHasTerminalObjectiveState(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    const state = managed.activeObjective?.terminalState as string | null | undefined;
    return state != null && state !== 'active';
}

function sessionOpHasPendingDecision(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    return !!(managed.pendingAuthRequestId || managed.pendingAuthRequest || managed.pendingTurnRecovery?.waitingForPermission
        || [...sessionOperationContext.state.pendingPermissionRequests.values()].some(request => request.sessionId === managed.id));
}

/** Delete approval capabilities before any redirect/await; durable markers
 * are reconciled later inside the serialized continuation fence. */
function sessionOpRevokePendingToolPermissionsForDirectContinuation(sessionOperationContext: SessionOperationContext, managed: ManagedSession): void {
    const generations = new Set([...sessionOperationContext.state.pendingPermissionRequests.values()]
        .filter(request => request.sessionId === managed.id)
        .map(request => request.processingGeneration));
    for (const generation of generations) {
        // closePendingPermissionRequestsForStop removes every request from the
        // broker map synchronously before its first await.
        void sessionOperationContext.owner["closePendingPermissionRequestsForStop"](managed, generation);
    }
}

export { sessionOpScheduleSourceActivationDispatch as scheduleSourceActivationDispatch };
export { sessionOpInvalidateSourceActivationRestart as invalidateSourceActivationRestart };
export { sessionOpDropDeferredSourceActivations as dropDeferredSourceActivations };
export { sessionOpAuthenticatedObjectiveAuthorizationSegments as authenticatedObjectiveAuthorizationSegments };
export { sessionOpMintTerminalInvocationCapabilityKey as mintTerminalInvocationCapabilityKey };
export { sessionOpConsumeTerminalInvocationCapability as consumeTerminalInvocationCapability };
export { sessionOpRepairLegacySyntheticObjectiveAuthority as repairLegacySyntheticObjectiveAuthority };
export { sessionOpHasTerminalObjectiveState as hasTerminalObjectiveState };
export { sessionOpHasPendingDecision as hasPendingDecision };
export { sessionOpRevokePendingToolPermissionsForDirectContinuation as revokePendingToolPermissionsForDirectContinuation };
