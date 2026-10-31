import type { SessionOperationContext } from '../operation-context.ts';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { objectiveReviewBinding } from '../../objective-contract';
import type { ManagedSession } from '../managed-session.ts';
import { sourceActivationObjectiveBinding } from '../source-activation.ts';
import { hasAcceptedHumanContinuationQueued as sessionOpHasAcceptedHumanContinuationQueued } from './create-autonomous-context-limit-handoff.ts';

async function sessionOpSerializeDirectHumanSupersession<T>(sessionOperationContext: SessionOperationContext, managed: ManagedSession, operation: () => Promise<T>): Promise<T> {
    const previous = sessionOperationContext.state.directHumanSupersessionTransactions.get(managed) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => { }).then(() => turn);
    sessionOperationContext.state.directHumanSupersessionTransactions.set(managed, tail);
    await previous.catch(() => { });
    sessionOperationContext.state.directHumanSupersessionsInFlight.add(managed);
    try {
        return await operation();
    }
    finally {
        sessionOperationContext.state.directHumanSupersessionsInFlight.delete(managed);
        release();
        if (sessionOperationContext.state.directHumanSupersessionTransactions.get(managed) === tail) {
            sessionOperationContext.state.directHumanSupersessionTransactions.delete(managed);
        }
    }
}

async function sessionOpSerializeSourceActivation<T>(sessionOperationContext: SessionOperationContext, managed: ManagedSession, operation: () => Promise<T>): Promise<T> {
    const previous = sessionOperationContext.state.sourceActivationTransactions.get(managed) ?? Promise.resolve();
    let release!: () => void;
    const transaction = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => { }).then(() => transaction);
    sessionOperationContext.state.sourceActivationTransactions.set(managed, tail);
    await previous.catch(() => { });
    try {
        return await operation();
    }
    finally {
        release();
        if (sessionOperationContext.state.sourceActivationTransactions.get(managed) === tail) {
            sessionOperationContext.state.sourceActivationTransactions.delete(managed);
        }
    }
}

function sessionOpMintDelegatedDispatchContinuation(sessionOperationContext: SessionOperationContext, parent: ManagedSession, child: ManagedSession, objective: ActiveSessionObjective | undefined): symbol {
    const now = Date.now();
    for (const [token, capability] of sessionOperationContext.state.delegatedDispatchContinuations) {
        if (capability.expiresAt <= now)
            sessionOperationContext.state.delegatedDispatchContinuations.delete(token);
    }
    const token = Symbol('delegated-dispatch');
    const reviewBinding = child.delegation?.reviewBinding;
    sessionOperationContext.state.delegatedDispatchContinuations.set(token, {
        parent,
        child,
        objective,
        authorityEpoch: sessionOperationContext.state.objectiveAuthorityEpochs.get(parent) ?? 0,
        parentGeneration: parent.processingGeneration,
        ...(reviewBinding ? { reviewBinding: { ...reviewBinding } } : {}),
        expiresAt: now + 60000,
    });
    return token;
}

function sessionOpDelegatedDispatchContinuationCurrent(sessionOperationContext: SessionOperationContext, token: symbol | undefined, child: ManagedSession, senderSessionId: string | undefined): boolean {
    if (!token || !senderSessionId)
        return false;
    const capability = sessionOperationContext.state.delegatedDispatchContinuations.get(token);
    if (!capability || capability.expiresAt <= Date.now()) {
        if (capability)
            sessionOperationContext.state.delegatedDispatchContinuations.delete(token);
        return false;
    }
    const { parent, objective, reviewBinding } = capability;
    const objectiveId = objective?.objectiveId ?? objective?.userMessageId;
    const currentReviewBinding = objective ? objectiveReviewBinding(objective) : undefined;
    return !sessionOperationContext.state.shuttingDown
        && sessionOperationContext.state.sessions.get(parent.id) === parent
        && sessionOperationContext.state.sessions.get(child.id) === child
        && capability.child === child
        && senderSessionId === parent.id
        && child.parentSessionId === parent.id
        && child.workspace.id === parent.workspace.id
        && parent.processingGeneration === capability.parentGeneration
        && parent.activeObjective === objective
        && (!objective || objective.terminalState === 'active')
        && (sessionOperationContext.state.objectiveAuthorityEpochs.get(parent) ?? 0) === capability.authorityEpoch
        && !parent.stopRequested
        && !child.stopRequested
        && !child.delegation?.finishedAt
        && (!objectiveId || child.delegation?.parentObjectiveId === objectiveId)
        && (!reviewBinding || (currentReviewBinding?.objectiveId === reviewBinding.objectiveId
            && currentReviewBinding.acceptanceSha256 === reviewBinding.acceptanceSha256
            && child.delegation?.reviewBinding?.objectiveId === reviewBinding.objectiveId
            && child.delegation.reviewBinding.acceptanceSha256 === reviewBinding.acceptanceSha256));
}

function sessionOpConsumeDelegatedDispatchContinuation(sessionOperationContext: SessionOperationContext, token: symbol | undefined): void {
    if (token)
        sessionOperationContext.state.delegatedDispatchContinuations.delete(token);
}

function sessionOpMintAuthenticatedInternalContinuation(sessionOperationContext: SessionOperationContext, managed: ManagedSession, kind: 'auth-result' | 'auth-retry'): symbol | undefined {
    const objective = managed.activeObjective;
    const binding = sourceActivationObjectiveBinding(objective);
    if (!objective || objective.terminalState !== 'active' || !binding)
        return undefined;
    const now = Date.now();
    for (const [token, capability] of sessionOperationContext.state.authenticatedInternalContinuations) {
        if (capability.expiresAt <= now)
            sessionOperationContext.state.authenticatedInternalContinuations.delete(token);
    }
    const token = Symbol(kind);
    sessionOperationContext.state.authenticatedInternalContinuations.set(token, {
        managed,
        objective,
        objectiveId: binding.objectiveId,
        objectiveRevision: binding.objectiveRevision,
        authorityEpoch: sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0,
        cancellationEpoch: sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0,
        generation: managed.processingGeneration,
        agent: managed.agent,
        kind,
        expiresAt: now + 60000,
    });
    return token;
}

function sessionOpAuthenticatedInternalContinuationCurrent(sessionOperationContext: SessionOperationContext, token: symbol | undefined, managed: ManagedSession, expectedKind: 'auth-result' | 'auth-retry' | undefined): boolean {
    if (!token || !expectedKind)
        return token === undefined && expectedKind === undefined;
    const capability = sessionOperationContext.state.authenticatedInternalContinuations.get(token);
    const binding = sourceActivationObjectiveBinding(managed.activeObjective);
    if (!capability || capability.expiresAt <= Date.now()) {
        if (capability)
            sessionOperationContext.state.authenticatedInternalContinuations.delete(token);
        return false;
    }
    const expectedGeneration = capability.claimedGeneration ?? capability.generation;
    return !sessionOperationContext.state.shuttingDown && sessionOperationContext.state.sessions.get(managed.id) === managed
        && capability.managed === managed && capability.kind === expectedKind
        && managed.activeObjective === capability.objective
        && managed.activeObjective.terminalState === 'active'
        && !!binding && binding.objectiveId === capability.objectiveId
        && binding.objectiveRevision === capability.objectiveRevision
        && (sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0) === capability.authorityEpoch
        && (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) === capability.cancellationEpoch
        && managed.processingGeneration === expectedGeneration
        && (capability.claimedGeneration !== undefined || managed.agent === capability.agent)
        && !managed.stopRequested && !sessionOpHasAcceptedHumanContinuationQueued(sessionOperationContext, managed);
}

function sessionOpClaimAuthenticatedInternalContinuation(sessionOperationContext: SessionOperationContext, token: symbol | undefined, managed: ManagedSession, generation: number): boolean {
    if (!token)
        return false;
    const capability = sessionOperationContext.state.authenticatedInternalContinuations.get(token);
    if (!capability || capability.claimedGeneration !== undefined
        || managed.processingGeneration !== capability.generation)
        return false;
    capability.claimedGeneration = generation;
    return true;
}

function sessionOpConsumeAuthenticatedInternalContinuation(sessionOperationContext: SessionOperationContext, token: symbol | undefined): void {
    if (token)
        sessionOperationContext.state.authenticatedInternalContinuations.delete(token);
}

function sessionOpDeniedPermissionToolUseIds(sessionOperationContext: SessionOperationContext, managed: ManagedSession, generation: number): Set<string> {
    let byGeneration = sessionOperationContext.state.permissionDeniedToolUseIdsByGeneration.get(managed);
    if (!byGeneration) {
        byGeneration = new Map();
        sessionOperationContext.state.permissionDeniedToolUseIdsByGeneration.set(managed, byGeneration);
    }
    let toolUseIds = byGeneration.get(generation);
    if (!toolUseIds) {
        toolUseIds = new Set();
        byGeneration.set(generation, toolUseIds);
    }
    return toolUseIds;
}

export { sessionOpSerializeDirectHumanSupersession as serializeDirectHumanSupersession };
export { sessionOpSerializeSourceActivation as serializeSourceActivation };
export { sessionOpMintDelegatedDispatchContinuation as mintDelegatedDispatchContinuation };
export { sessionOpDelegatedDispatchContinuationCurrent as delegatedDispatchContinuationCurrent };
export { sessionOpConsumeDelegatedDispatchContinuation as consumeDelegatedDispatchContinuation };
export { sessionOpMintAuthenticatedInternalContinuation as mintAuthenticatedInternalContinuation };
export { sessionOpAuthenticatedInternalContinuationCurrent as authenticatedInternalContinuationCurrent };
export { sessionOpClaimAuthenticatedInternalContinuation as claimAuthenticatedInternalContinuation };
export { sessionOpConsumeAuthenticatedInternalContinuation as consumeAuthenticatedInternalContinuation };
export { sessionOpDeniedPermissionToolUseIds as deniedPermissionToolUseIds };
