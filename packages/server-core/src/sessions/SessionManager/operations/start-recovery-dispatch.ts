import type { SessionOperationContext } from '../operation-context.ts';
import { nextRecoveryDispatch, validAllocatedRecoveryDispatch } from '../policy.ts';
import { isWorkspaceAutomaticToolFallbackEnabled, loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions';
import type { SendMessageOptions } from '@craft-agent/shared/protocol';
import { DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS } from '../../turn-recovery';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { MAX_CLEAN_RETRY_SETUP_BACKOFF_MS } from '../user-input-authority.ts';
import { buildRecoveryDispatchMessage as sessionOpBuildRecoveryDispatchMessage } from './user-input-recovery.ts';

function sessionOpStartRecoveryDispatch(_sessionOperationContext: SessionOperationContext, pending: PendingTurnRecovery, provenance: NonNullable<SendMessageOptions['automaticRecovery']>, nowMs = Date.now()): PendingTurnRecovery {
    const expectedOrigin = provenance.cause === 'app_restart'
        ? 'restart' as const
        : provenance.cause === 'user_retry'
            ? 'retry' as const
            : 'automatic' as const;
    const suppliedOriginValid = provenance.dispatchOrigin === expectedOrigin
        || (provenance.dispatchOrigin === 'restart'
            && provenance.cause !== 'app_restart' && provenance.cause !== 'user_retry');
    const hasSuppliedDispatchProvenance = [
        provenance.dispatchId,
        provenance.dispatchAttempt,
        provenance.dispatchOrigin,
        provenance.dispatchAllocatedAt,
    ].some(value => value !== undefined);
    const suppliedDispatch = typeof provenance.dispatchId === 'string'
        && provenance.dispatchId.trim().length > 0
        && Number.isSafeInteger(provenance.dispatchAttempt) && provenance.dispatchAttempt! > 0
        && provenance.dispatchAttempt! >= pending.attempts
        && suppliedOriginValid
        && Number.isFinite(provenance.dispatchAllocatedAt) && provenance.dispatchAllocatedAt! > 0
        ? {
            schemaVersion: 1 as const,
            id: provenance.dispatchId,
            attempt: provenance.dispatchAttempt!,
            cause: provenance.cause,
            origin: provenance.dispatchOrigin!,
            allocatedAt: provenance.dispatchAllocatedAt!,
            phase: 'allocated' as const,
            ...(provenance.cleanContinuationId
                && /^clean-continuation-v1-[a-f0-9]{24}$/.test(provenance.cleanContinuationId)
                ? { cleanContinuationId: provenance.cleanContinuationId }
                : {}),
        }
        : undefined;
    if (provenance.cleanContinuationId && suppliedDispatch?.cleanContinuationId !== provenance.cleanContinuationId) {
        throw new Error('The clean recovery continuation identity is malformed');
    }
    if (hasSuppliedDispatchProvenance && !suppliedDispatch) {
        throw new Error('The recovery dispatch allocation is malformed or has mismatched provenance');
    }
    const currentDispatch = pending.recoveryDispatch;
    const suppliedDispatchOwnsAllocation = suppliedDispatch && currentDispatch?.phase === 'allocated'
        && currentDispatch.id === suppliedDispatch.id
        && currentDispatch.attempt === suppliedDispatch.attempt
        && currentDispatch.cause === suppliedDispatch.cause
        && currentDispatch.origin === suppliedDispatch.origin
        && currentDispatch.allocatedAt === suppliedDispatch.allocatedAt
        && (!provenance.cleanContinuationId
            || currentDispatch.cleanContinuationId === suppliedDispatch.cleanContinuationId);
    if (suppliedDispatch && provenance.cause !== 'user_retry' && !suppliedDispatchOwnsAllocation) {
        throw new Error('The queued recovery dispatch no longer owns this allocation');
    }
    if (suppliedDispatch && currentDispatch?.id === suppliedDispatch.id && currentDispatch.phase === 'started') {
        throw new Error('The recovery dispatch has already started');
    }
    const allocatedDispatch = suppliedDispatchOwnsAllocation
        ? currentDispatch
        : suppliedDispatch ?? nextRecoveryDispatch(pending, provenance.cause, expectedOrigin, nowMs);
    return {
        ...pending,
        lastCause: provenance.cause,
        recoveryDispatch: {
            ...allocatedDispatch,
            phase: 'started',
            startedAt: Math.max(nowMs, allocatedDispatch.allocatedAt),
            // This transition and its exact prompt are synchronously flushed before
            // provider handoff, so even an older durable allocation can safely opt
            // into the new pre-execution receipt protocol at this boundary.
            preToolExecutionReceiptVersion: 1,
        },
    };
}

/** The clean-boundary FIFO is transient reconstruction, never authority on
 * its own. Authenticate every field against the one durable allocation and
 * rebuild the prompt from host-owned objective state before dequeue. */
function sessionOpIsExactQueuedCleanRecoveryDispatch(sessionOperationContext: SessionOperationContext, managed: ManagedSession, pending: PendingTurnRecovery, dispatch: NonNullable<PendingTurnRecovery['recoveryDispatch']>, item: ManagedSession['messageQueue'][number]): boolean {
    const provenance = item.options?.automaticRecovery;
    const allowedOptionKeys = new Set(['hidden', 'automaticRecovery', 'internalOrigin']);
    const allowedRecoveryKeys = new Set([
        'originalUserMessageId', 'cause', 'dispatchId', 'dispatchAttempt',
        'dispatchOrigin', 'dispatchAllocatedAt', 'cleanContinuationId',
    ]);
    if (!dispatch.cleanContinuationId || item.options?.hidden !== true || !provenance
        || Object.keys(item.options).some(key => !allowedOptionKeys.has(key))
        || Object.keys(provenance).some(key => !allowedRecoveryKeys.has(key))
        || (item.attachments?.length ?? 0) > 0 || (item.storedAttachments?.length ?? 0) > 0
        || item.optimisticMessageId !== undefined
        || provenance.originalUserMessageId !== pending.userMessageId
        || provenance.cause !== dispatch.cause
        || provenance.dispatchId !== dispatch.id
        || provenance.dispatchAttempt !== dispatch.attempt
        || provenance.dispatchOrigin !== dispatch.origin
        || provenance.dispatchAllocatedAt !== dispatch.allocatedAt
        || provenance.cleanContinuationId !== dispatch.cleanContinuationId
        || (dispatch.fallbackIntent
            ? item.options.internalOrigin?.kind !== 'browser-fallback'
            : item.options.internalOrigin !== undefined))
        return false;
    let expected: string;
    try {
        expected = sessionOpBuildRecoveryDispatchMessage(sessionOperationContext, managed, pending, dispatch);
    }
    catch {
        return false;
    }
    if (item.message !== expected)
        return false;
    if (!item.messageId)
        return true;
    if (item.messageId !== dispatch.id)
        return false;
    const rows = managed.messages.filter(message => message.id === item.messageId);
    const row = rows[0];
    return rows.length === 1 && !!row && row.role === 'user' && row.hidden === true
        && row.isQueued === true && !row.isPending && !row.agentDelivery
        && (row.attachments?.length ?? 0) === 0 && (row.badges?.length ?? 0) === 0
        && row.content === expected
        && (dispatch.fallbackIntent
            ? row.internalOrigin?.kind === 'browser-fallback'
            : row.internalOrigin === undefined);
}

/** A channel fallback allocated while its dedicated switch was ON must not survive an
 * OFF toggle or cold restart. Preserve the bounded generic recovery attempt
 * and its identity, but remove the browser/structured retargeting intent. */
function sessionOpStripDisabledAllocatedRoutingFallback(sessionOperationContext: SessionOperationContext, managed: ManagedSession, pending: PendingTurnRecovery): {
    pending: PendingTurnRecovery;
    changed: boolean;
} {
    const dispatch = pending.recoveryDispatch;
    if (isWorkspaceAutomaticToolFallbackEnabled(loadWorkspaceConfig(managed.workspace.rootPath))
        || dispatch?.phase !== 'allocated' || !dispatch.fallbackIntent) {
        return { pending, changed: false };
    }
    const recoveryDispatch = { ...dispatch };
    delete recoveryDispatch.fallbackIntent;
    const sanitized = { ...pending, recoveryDispatch };
    if (managed.pendingTurnRecovery === pending)
        managed.pendingTurnRecovery = sanitized;
    const prompt = sessionOpBuildRecoveryDispatchMessage(sessionOperationContext, managed, sanitized, recoveryDispatch);
    for (const message of managed.messages) {
        if (message.id !== recoveryDispatch.id || message.role !== 'user' || !message.hidden
            || message.isQueued !== true || message.agentDelivery)
            continue;
        message.content = prompt;
        if (message.internalOrigin?.kind === 'browser-fallback')
            delete message.internalOrigin;
    }
    for (const item of managed.messageQueue) {
        if (item.options?.automaticRecovery?.dispatchId !== recoveryDispatch.id)
            continue;
        item.message = prompt;
        if (item.options.internalOrigin?.kind === 'browser-fallback') {
            const { internalOrigin: _disabledFallbackOrigin, ...options } = item.options;
            item.options = options;
        }
    }
    return { pending: sanitized, changed: true };
}

function sessionOpRequeueAllocatedRecoveryDispatch(sessionOperationContext: SessionOperationContext, managed: ManagedSession, pending: PendingTurnRecovery): boolean {
    pending = sessionOpStripDisabledAllocatedRoutingFallback(sessionOperationContext, managed, pending).pending;
    const dispatch = validAllocatedRecoveryDispatch(pending);
    if (!dispatch || sessionOperationContext.state.queuedMessageDispatches.has(managed.id))
        return false;
    const alreadyQueued = managed.messageQueue.some(item => dispatch.cleanContinuationId
        ? sessionOpIsExactQueuedCleanRecoveryDispatch(sessionOperationContext, managed, pending, dispatch, item)
        : item.options?.automaticRecovery?.dispatchId === dispatch.id
            && item.options.automaticRecovery.originalUserMessageId === pending.userMessageId);
    if (alreadyQueued)
        return true;
    const queuedRecovery: ManagedSession['messageQueue'][number] = {
        message: sessionOpBuildRecoveryDispatchMessage(sessionOperationContext, managed, pending, dispatch),
        options: {
            hidden: true,
            ...(dispatch.fallbackIntent ? { internalOrigin: { kind: 'browser-fallback' as const } } : {}),
            automaticRecovery: {
                originalUserMessageId: pending.userMessageId,
                cause: dispatch.cause,
                dispatchId: dispatch.id,
                dispatchAttempt: dispatch.attempt,
                dispatchOrigin: dispatch.origin,
                dispatchAllocatedAt: dispatch.allocatedAt,
                ...(dispatch.cleanContinuationId
                    ? { cleanContinuationId: dispatch.cleanContinuationId }
                    : {}),
            },
        },
    };
    // A clean provider boundary must be the first provider turn. Earlier
    // machine inbox records remain durable behind it; sending one through the
    // freshly detached context would fail the boundary authentication and can
    // incorrectly consume an agent-delivery attempt before provider work.
    if (dispatch.cleanContinuationId)
        managed.messageQueue.unshift(queuedRecovery);
    else
        managed.messageQueue.push(queuedRecovery);
    sessionLog.warn('Requeued durable automatic turn recovery allocation', {
        sessionId: managed.id,
        originalUserMessageId: pending.userMessageId,
        cause: dispatch.cause,
        attempt: dispatch.attempt,
        dispatchId: dispatch.id,
        origin: dispatch.origin,
    });
    return true;
}

/** A persisted turn marker cannot mint a fresh automatic lease merely
 * because the host restarted long after the original work. A recent durable
 * allocation is different: it proves the host accepted one exact dispatch
 * immediately before the crash and may therefore be rebuilt once. */
function sessionOpColdAutomaticRecoveryLeaseExpired(_sessionOperationContext: SessionOperationContext, pending: PendingTurnRecovery, nowMs = Date.now()): boolean {
    const allocated = validAllocatedRecoveryDispatch(pending);
    if (allocated && allocated.allocatedAt <= nowMs
        && nowMs - allocated.allocatedAt < DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS)
        return false;
    if (!Number.isFinite(pending.startedAt) || pending.startedAt <= 0
        || !Number.isFinite(nowMs) || nowMs < pending.startedAt)
        return true;
    const coldLeaseExpiresAt = pending.startedAt + DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS;
    if (!Number.isFinite(coldLeaseExpiresAt)
        || pending.leaseExpiresAt !== undefined && !Number.isFinite(pending.leaseExpiresAt))
        return true;
    const effectiveLeaseExpiresAt = pending.leaseExpiresAt === undefined
        ? coldLeaseExpiresAt
        : Math.min(coldLeaseExpiresAt, pending.leaseExpiresAt);
    return nowMs >= effectiveLeaseExpiresAt;
}

function sessionOpClearDeferredAutomaticRetry(sessionOperationContext: SessionOperationContext, sessionId: string): void {
    const timer = sessionOperationContext.state.deferredAutomaticRetryTimers.get(sessionId);
    if (timer)
        clearTimeout(timer);
    sessionOperationContext.state.deferredAutomaticRetryTimers.delete(sessionId);
    sessionOperationContext.state.deferredAutomaticRetryAttempts.delete(sessionId);
}

function sessionOpScheduleDeferredAutomaticRetry(sessionOperationContext: SessionOperationContext, sessionId: string, minimumDelayMs = 0): void {
    if (sessionOperationContext.state.shuttingDown || sessionOperationContext.state.deferredAutomaticRetryTimers.has(sessionId))
        return;
    const attempt = (sessionOperationContext.state.deferredAutomaticRetryAttempts.get(sessionId) ?? 0) + 1;
    sessionOperationContext.state.deferredAutomaticRetryAttempts.set(sessionId, attempt);
    const boundedMinimumDelayMs = Number.isFinite(minimumDelayMs)
        ? Math.min(MAX_CLEAN_RETRY_SETUP_BACKOFF_MS, Math.max(0, Math.floor(minimumDelayMs)))
        : 0;
    const delayMs = Math.max(boundedMinimumDelayMs, Math.min(30000, 250 * (2 ** Math.min(attempt - 1, 7))));
    const timer = setTimeout(() => {
        sessionOperationContext.state.deferredAutomaticRetryTimers.delete(sessionId);
        if (sessionOperationContext.state.shuttingDown || !sessionOperationContext.state.deferredAutomaticSessions.has(sessionId)) {
            sessionOperationContext.state.deferredAutomaticRetryAttempts.delete(sessionId);
            return;
        }
        sessionOperationContext.owner["scheduleDeferredAutomaticSessions"]();
    }, delayMs);
    timer.unref?.();
    sessionOperationContext.state.deferredAutomaticRetryTimers.set(sessionId, timer);
    sessionLog.warn('Deferred automatic admission retained for autonomous backoff retry', {
        sessionId,
        attempt,
        delayMs,
    });
}

function sessionOpIsCleanSetupPersistenceFenced(sessionOperationContext: SessionOperationContext, managed: ManagedSession, dispatch: PendingTurnRecovery['recoveryDispatch'] | undefined): boolean {
    return !!dispatch?.cleanContinuationId && (Number.isFinite(dispatch.setupPersistenceFencedAt)
        && dispatch.setupPersistenceFencedAt! > 0
        || sessionOperationContext.state.cleanRetrySetupPersistenceFences.get(managed.id) === dispatch.id);
}

/** Convert an uncertain storage acknowledgement into durable, text-free
 * Retry-only state. Best-effort re-enqueue lets a later healthy disk write
 * carry the fence across restart; provider admission never depends on it. */
function sessionOpFenceCleanSetupPersistence(sessionOperationContext: SessionOperationContext, managed: ManagedSession, dispatchId: string): boolean {
    const pending = managed.pendingTurnRecovery;
    const dispatch = pending && validAllocatedRecoveryDispatch(pending);
    if (!pending || !dispatch || dispatch.id !== dispatchId || !dispatch.cleanContinuationId)
        return false;
    const fencedDispatch = {
        ...dispatch,
        setupPersistenceFencedAt: dispatch.setupPersistenceFencedAt ?? Date.now(),
    };
    managed.pendingTurnRecovery = { ...pending, recoveryDispatch: fencedDispatch };
    sessionOperationContext.state.cleanRetrySetupPersistenceFences.set(managed.id, dispatch.id);
    sessionOpClearDeferredAutomaticRetry(sessionOperationContext, managed.id);
    sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
    sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
    sessionOperationContext.owner["persistSession"](managed);
    return true;
}

export { sessionOpStartRecoveryDispatch as startRecoveryDispatch };
export { sessionOpIsExactQueuedCleanRecoveryDispatch as isExactQueuedCleanRecoveryDispatch };
export { sessionOpStripDisabledAllocatedRoutingFallback as stripDisabledAllocatedRoutingFallback };
export { sessionOpRequeueAllocatedRecoveryDispatch as requeueAllocatedRecoveryDispatch };
export { sessionOpColdAutomaticRecoveryLeaseExpired as coldAutomaticRecoveryLeaseExpired };
export { sessionOpClearDeferredAutomaticRetry as clearDeferredAutomaticRetry };
export { sessionOpScheduleDeferredAutomaticRetry as scheduleDeferredAutomaticRetry };
export { sessionOpIsCleanSetupPersistenceFenced as isCleanSetupPersistenceFenced };
export { sessionOpFenceCleanSetupPersistence as fenceCleanSetupPersistence };
