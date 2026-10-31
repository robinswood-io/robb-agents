import type { SessionOperationContext } from '../operation-context.ts';
import { AbortReason } from '@craft-agent/shared/agent';
import type { ManagedSession } from '../managed-session.ts';
import { withRuntimeDisposeTimeout } from '../runtime-policy.ts';
import { clearDeferredAutomaticRetry as sessionOpClearDeferredAutomaticRetry } from './start-recovery-dispatch.ts';
import { clearPendingPermissionRequestsForSession as sessionOpClearPendingPermissionRequestsForSession } from './expire-pending-permission-request.ts';
import { drainSessionOperations as sessionOpDrainSessionOperations } from './track-session-operation.ts';
import { retryManagedAgentRuntimeDisposals as sessionOpRetryManagedAgentRuntimeDisposals } from './perform-cancel-processing-and-wait.ts';

async function sessionOpQuiesceSessionForDeletion(sessionOperationContext: SessionOperationContext, managed: ManagedSession, state: {
    effectsStarted: boolean;
    runtimeTeardownStarted: boolean;
    runtimeTeardownProven: boolean;
}, wasProcessingAtEntry: boolean): Promise<void> {
    const sessionId = managed.id;
    // Quiescence mutates admission state before its first await, and an
    // already-admitted operation may itself have mutated this object before
    // the drain completes. From this point onward the session must therefore
    // remain visible only in its fail-closed retired state on rollback.
    state.effectsStarted = true;
    sessionOpClearDeferredAutomaticRetry(sessionOperationContext, sessionId);
    sessionOperationContext.state.deferredAutomaticSessions.delete(sessionId);
    sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
    sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
    for (const [messageId, dispatch] of sessionOperationContext.state.queuedAgentDeliveryDispatches) {
        if (dispatch.sessionId === sessionId)
            sessionOperationContext.state.queuedAgentDeliveryDispatches.delete(messageId);
    }
    // Close provider-side permission promises before tearing down their
    // runtime. A callback arriving after this point is rejected by the retired
    // ManagedSession guards installed on the runtime handlers.
    sessionOpClearPendingPermissionRequestsForSession(sessionOperationContext, sessionId);
    managed.stopRequested = true;
    if (managed.agent)
        managed.agent.forceAbort(AbortReason.UserStop);
    // A send/event/image callback admitted before retirement owns the right to
    // finish. Wait for it before disposing the runtime so it cannot attach a
    // replacement after disposal and recreate session-owned files after the
    // atomic move.
    await withRuntimeDisposeTimeout(sessionOpDrainSessionOperations(sessionOperationContext, managed), `Session operation drain for ${sessionId}`);
    await withRuntimeDisposeTimeout(Promise.allSettled([
        sessionOperationContext.state.directHumanSupersessionTransactions.get(managed),
        sessionOperationContext.state.sourceActivationTransactions.get(managed),
        sessionOperationContext.state.toolAdmissionTransactions.get(managed),
        sessionOperationContext.state.agentRefreshLocks.get(sessionId),
        sessionOperationContext.state.restartRecoveriesInFlight.get(sessionId),
        sessionOperationContext.state.strongCancellationStops.get(sessionId)?.operation,
    ].filter((operation): operation is Promise<void> => operation !== undefined)).then(() => undefined), `Session transaction drain for ${sessionId}`);
    await withRuntimeDisposeTimeout(sessionOpDrainSessionOperations(sessionOperationContext, managed), `Session callback drain for ${sessionId}`);
    // The ordinary stop handler deliberately resolves the current session via
    // this.sessions. Deletion has already detached it, so that callback cannot
    // publish the idle transition. Close the runtime accounting here, exactly
    // once, after every admitted operation has drained and before teardown.
    if (managed.isProcessing)
        sessionOperationContext.owner["setProcessing"](managed, false);
    if (wasProcessingAtEntry)
        managed.wasInterrupted = true;
    state.runtimeTeardownStarted = true;
    await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'session deletion pre-commit');
    await withRuntimeDisposeTimeout(sessionOpDrainSessionOperations(sessionOperationContext, managed), `Session disposal callback drain for ${sessionId}`);
    await withRuntimeDisposeTimeout(sessionOpRetryManagedAgentRuntimeDisposals(sessionOperationContext, sessionId), `Runtime destruction proof for ${sessionId}`);
    const pendingDisposals = sessionOperationContext.state.runtimeDisposalsInFlight.get(sessionId);
    if (pendingDisposals?.size) {
        await withRuntimeDisposeTimeout(Promise.allSettled([...pendingDisposals]).then(() => undefined), `Runtime disposal drain for ${sessionId}`);
    }
    if ((sessionOperationContext.state.runtimeDisposalBarriers.get(sessionId)?.size ?? 0) > 0
        || (sessionOperationContext.state.runtimeDisposalsInFlight.get(sessionId)?.size ?? 0) > 0) {
        throw new Error(`Runtime destruction for session ${sessionId} is not proven`);
    }
    state.runtimeTeardownProven = true;
}

export { sessionOpQuiesceSessionForDeletion as quiesceSessionForDeletion };
