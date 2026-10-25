import type { SessionOperationContext } from '../operation-context.ts';
import { validAllocatedRecoveryDispatch, cleanRetrySetupFailureSignal } from '../policy.ts';
import { classifyAgentFailure } from '@craft-agent/shared/agent';
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions';
import { loadStatusConfig } from '@craft-agent/shared/statuses/storage';
import { resolveLifecycleStartStatus } from '../../session-status-lifecycle';
import type { SessionLifecycleStopReason } from '../../session-status-lifecycle';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { MAX_CLEAN_RETRY_CONDITIONAL_SETUP_FAILURES, MAX_CLEAN_RETRY_SAFE_SETUP_FAILURES } from '../user-input-authority.ts';
import { resumePendingTurnAfterRestartOnce as sessionOpResumePendingTurnAfterRestartOnce } from './resume-pending-turn-after-restart-once.ts';
import { clearDeferredAutomaticRetry as sessionOpClearDeferredAutomaticRetry, requeueAllocatedRecoveryDispatch as sessionOpRequeueAllocatedRecoveryDispatch, fenceCleanSetupPersistence as sessionOpFenceCleanSetupPersistence } from './start-recovery-dispatch.ts';

async function sessionOpResumePendingTurnAfterRestart(sessionOperationContext: SessionOperationContext, sessionId: string, missionClaimToken?: symbol): Promise<void> {
    if (sessionOperationContext.state.shuttingDown)
        return;
    const candidate = sessionOperationContext.state.sessions.get(sessionId);
    if (candidate
        && sessionOperationContext.state.missionRuntimeOwnedRestoredRecoverySessionIds.has(sessionId)) {
        const claim = sessionOperationContext.state.missionPendingTurnRecoveryClaims.get(sessionId);
        if (!claim || claim.token !== missionClaimToken) {
            sessionLog.info('Refused generic recovery of a MissionRuntime-owned dispatch', {
                sessionId,
                missionId: candidate.missionId,
                missionWorkItemId: candidate.missionWorkItemId,
                missionDispatchId: candidate.missionDispatchId,
            });
            return;
        }
    }
    const running = sessionOperationContext.state.restartRecoveriesInFlight.get(sessionId);
    if (running)
        return running;
    const operation = sessionOpResumePendingTurnAfterRestartOnce(sessionOperationContext, sessionId);
    sessionOperationContext.state.restartRecoveriesInFlight.set(sessionId, operation);
    try {
        await operation;
    }
    finally {
        sessionOperationContext.state.restartRecoveriesInFlight.delete(sessionId);
        const managed = sessionOperationContext.state.sessions.get(sessionId);
        if (!managed?.isProcessing && !sessionOperationContext.state.queuedMessageDispatches.has(sessionId)
            && !sessionOperationContext.state.retryTurnsInFlight.has(sessionId))
            sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
        if (!managed?.pendingTurnRecovery) {
            sessionOperationContext.state.missionPendingTurnRecoveryClaims.delete(sessionId);
            sessionOperationContext.state.missionRuntimeOwnedRestoredRecoverySessionIds.delete(sessionId);
            sessionOperationContext.owner["scheduleDeferredAutomaticSessions"]();
        }
    }
}

/** Retain the same pre-provider clean allocation while bounding setup
 * failures independently from the model recovery budget. Persistence wins
 * before any timer is armed; a failed fsync leaves an in-memory admission
 * fence instead of racing another provider preparation. */
async function sessionOpRetainFailedCleanRetrySetup(sessionOperationContext: SessionOperationContext, managed: ManagedSession, dispatchId: string, error: unknown): Promise<void> {
    const pending = managed.pendingTurnRecovery;
    const dispatch = pending && validAllocatedRecoveryDispatch(pending);
    if (!pending || !dispatch || dispatch.id !== dispatchId || !dispatch.cleanContinuationId
        || sessionOperationContext.state.sessions.get(managed.id) !== managed || managed.stopRequested)
        return;
    const failure = classifyAgentFailure(cleanRetrySetupFailureSignal(error));
    const setupFailureCount = (dispatch.setupFailureCount ?? 0) + 1;
    const failureLimit = failure.retryability === 'never'
        ? 1
        : failure.retryability === 'conditional'
            ? MAX_CLEAN_RETRY_CONDITIONAL_SETUP_FAILURES
            : failure.failureClass === 'rate-limited'
                ? MAX_CLEAN_RETRY_CONDITIONAL_SETUP_FAILURES
                : MAX_CLEAN_RETRY_SAFE_SETUP_FAILURES;
    const blocked = setupFailureCount >= failureLimit;
    const setupBackoffMs = 250 * (2 ** Math.min(setupFailureCount - 1, 7));
    const setupRetryDelayMs = Math.max(setupBackoffMs, failure.retryAfterMs ?? 0);
    const setupFailureAt = Date.now();
    const boundedSetupRetryDelayMs = Math.min(Math.max(0, setupRetryDelayMs), Number.MAX_SAFE_INTEGER - setupFailureAt);
    const setupRetryNotBefore = setupFailureAt + boundedSetupRetryDelayMs;
    const recoveryDispatch: NonNullable<PendingTurnRecovery['recoveryDispatch']> = {
        ...dispatch,
        setupFailureCount,
        lastSetupFailureClass: failure.failureClass,
        ...(blocked
            ? { setupRetryBlockedAt: setupFailureAt, setupRetryNotBefore: undefined }
            : { setupRetryBlockedAt: undefined, setupRetryNotBefore }),
    };
    const retained: PendingTurnRecovery = { ...pending, recoveryDispatch };
    managed.pendingTurnRecovery = retained;
    managed.messageQueue = managed.messageQueue.filter(item => (item.options?.automaticRecovery?.dispatchId !== dispatch.id));
    sessionOpClearDeferredAutomaticRetry(sessionOperationContext, managed.id);
    sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
    sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
    if (!blocked)
        sessionOpRequeueAllocatedRecoveryDispatch(sessionOperationContext, managed, retained);
    sessionOperationContext.state.cleanRetrySetupPersistenceFences.set(managed.id, dispatch.id);
    const setupFailureEnqueued = sessionOperationContext.owner["persistSession"](managed);
    if (!setupFailureEnqueued) {
        sessionOpFenceCleanSetupPersistence(sessionOperationContext, managed, dispatch.id);
        sessionOperationContext.owner["sendEvent"]({
            type: 'typed_error', sessionId: managed.id,
            error: {
                code: 'provider_error', title: 'Recovery state was not persisted',
                message: 'The provider was not started again because the bounded recovery state could not be queued for durable storage. Retry after storage is available.',
                actions: [{ key: 'r', label: 'Retry', action: 'retry' }], canRetry: true,
            },
        }, managed.workspace.id);
        return;
    }
    try {
        await sessionOperationContext.owner.flushSession(managed.id);
    }
    catch (flushError) {
        sessionOpFenceCleanSetupPersistence(sessionOperationContext, managed, dispatch.id);
        sessionLog.warn('Failed to persist bounded clean Retry setup failure; provider admission remains fenced', {
            sessionId: managed.id,
            dispatchId,
            failureClass: failure.failureClass,
            error: flushError instanceof Error ? flushError.message : String(flushError),
        });
        sessionOperationContext.owner["sendEvent"]({
            type: 'typed_error', sessionId: managed.id,
            error: {
                code: 'provider_error',
                title: 'Recovery state was not persisted',
                message: 'The provider was not started again because the bounded recovery state could not be durably saved. Retry after storage is available.',
                actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
                canRetry: true,
            },
        }, managed.workspace.id);
        return;
    }
    if (sessionOperationContext.state.cleanRetrySetupPersistenceFences.get(managed.id) === dispatch.id) {
        sessionOperationContext.state.cleanRetrySetupPersistenceFences.delete(managed.id);
    }
    if (sessionOperationContext.state.sessions.get(managed.id) !== managed || managed.pendingTurnRecovery !== retained
        || managed.stopRequested || managed.isProcessing)
        return;
    if (blocked) {
        sessionOperationContext.owner["sendEvent"]({
            type: 'typed_error', sessionId: managed.id,
            error: {
                code: 'provider_error',
                title: 'Provider setup paused',
                message: failure.retryability === 'never'
                    ? `Automatic recovery paused before provider work (${failure.failureClass}). Resolve the connection, authentication, permission, or configuration issue, then Retry.`
                    : `Automatic recovery paused after ${setupFailureCount} bounded provider setup failures (${failure.failureClass}). Resolve the provider issue, then Retry.`,
                actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
                canRetry: true,
            },
        }, managed.workspace.id);
        return;
    }
    sessionOperationContext.state.deferredAutomaticSessions.add(managed.id);
    sessionOperationContext.owner["scheduleDeferredAutomaticRetry"](managed.id, Math.max(0, setupRetryNotBefore - Date.now()));
}

async function sessionOpReconcileRecoveredTerminalStatus(sessionOperationContext: SessionOperationContext, managed: ManagedSession, reason: SessionLifecycleStopReason): Promise<boolean> {
    const config = loadStatusConfig(managed.workspace.rootPath);
    const inferredOwnedStatus = resolveLifecycleStartStatus(config, managed.sessionStatus);
    // Cold state has no transient ownership token. Recover it only when the
    // persisted status is exactly the configured lifecycle start status; a
    // user/custom status always wins.
    if (!inferredOwnedStatus || managed.sessionStatus !== inferredOwnedStatus)
        return false;
    const previousStatus = managed.sessionStatus;
    const objective = managed.activeObjective;
    managed.turnLifecycleManagedStatus = inferredOwnedStatus;
    try {
        await sessionOperationContext.owner["finishAutomaticSessionStatusLifecycle"](managed, reason, () => {
            if (sessionOperationContext.state.sessions.get(managed.id) !== managed || managed.activeObjective !== objective
                || objective?.terminalState === 'active' || managed.isProcessing) {
                throw new Error('Recovered terminal status superseded by active work');
            }
        });
        return managed.sessionStatus !== previousStatus;
    }
    catch (error) {
        if (sessionOperationContext.state.sessions.get(managed.id) === managed && managed.activeObjective === objective
            && objective?.terminalState !== 'active' && !managed.isProcessing) {
            sessionLog.warn('Recovered terminal status reconciliation failed', {
                sessionId: managed.id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return false;
    }
}

export { sessionOpResumePendingTurnAfterRestart as resumePendingTurnAfterRestart };
export { sessionOpRetainFailedCleanRetrySetup as retainFailedCleanRetrySetup };
export { sessionOpReconcileRecoveredTerminalStatus as reconcileRecoveredTerminalStatus };
