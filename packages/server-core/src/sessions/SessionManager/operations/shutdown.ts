import type { SessionOperationContext } from '../operation-context.ts';
import { AbortReason } from '@craft-agent/shared/agent';
import { sessionLog } from '../runtime-platform.ts';
import { SESSION_RUNTIME_DISPOSE_TIMEOUT_MS } from '../runtime-policy.ts';
import { drainManagerOperations as sessionOpDrainManagerOperations, drainRestartRecoveries as sessionOpDrainRestartRecoveries, drainStrongCancellationStops as sessionOpDrainStrongCancellationStops, drainAllSessionOperations as sessionOpDrainAllSessionOperations } from './track-session-operation.ts';
import { restorePreAckAgentDeliveryDequeues as sessionOpRestorePreAckAgentDeliveryDequeues } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { removeInFlightSyntheticAutomaticMessages as sessionOpRemoveInFlightSyntheticAutomaticMessages } from './reconcile-live-provider-dispatch-uncertainty.ts';
import { proveRuntimeDisposalsForCleanup as sessionOpProveRuntimeDisposalsForCleanup } from './perform-cancel-processing-and-wait.ts';
import { rejectPendingPrivilegedApproval as sessionOpRejectPendingPrivilegedApproval, denyPermissionOnRecordedRuntime as sessionOpDenyPermissionOnRecordedRuntime } from './expire-pending-permission-request.ts';

/**
 * Clean up all resources held by the SessionManager.
 * Should be called on app shutdown to prevent resource leaks.
 */
async function sessionOpCleanup(sessionOperationContext: SessionOperationContext): Promise<void> {
    if (!sessionOperationContext.state.cleanupPromise) {
        // Close every ordinary lease synchronously. Provider runtimes retain one
        // narrow terminal-result channel until their destruction is proven.
        sessionOperationContext.state.shuttingDown = true;
        sessionOperationContext.state.shutdownTerminalResultAdmissionOpen = true;
        const watcherStopErrors: unknown[] = [];
        let beginResourceCleanup!: () => void;
        const watcherStopBarrier = new Promise<void>(resolve => {
            beginResourceCleanup = resolve;
        });
        // Publish the shared cleanup promise before invoking third-party watcher
        // teardown. A synchronous/re-entrant cleanup call must join this exact
        // operation even when one watcher throws.
        sessionOperationContext.state.cleanupPromise = watcherStopBarrier
            .then(() => sessionOpCleanupResources(sessionOperationContext, watcherStopErrors))
            .finally(() => {
            // Also close the gate if an earlier cleanup phase fails unexpectedly.
            sessionOperationContext.state.shutdownTerminalResultAdmissionOpen = false;
        });
        // Watcher callbacks are ordinary admissions. Stop them at the same
        // synchronous boundary as RPC admission so a debounced config event cannot
        // reject an unobserved trackSessionOperation promise or publish after the
        // final persistence barrier.
        for (const [path, watcher] of sessionOperationContext.state.configWatchers) {
            try {
                watcher.stop();
                sessionLog.info(`Stopped config watcher for ${path}`);
            }
            catch (error) {
                watcherStopErrors.push(error);
                sessionLog.error(`Failed to stop config watcher for ${path}; cleanup will continue:`, error);
            }
        }
        sessionOperationContext.state.configWatchers.clear();
        beginResourceCleanup();
    }
    return sessionOperationContext.state.cleanupPromise;
}

async function sessionOpCleanupResources(sessionOperationContext: SessionOperationContext, initialCleanupErrors: readonly unknown[] = []): Promise<void> {
    sessionLog.info('Cleaning up resources...');
    const cleanupErrors: unknown[] = [...initialCleanupErrors];
    const flushPersistenceForCleanup = async (stage: string): Promise<void> => {
        try {
            await sessionOperationContext.owner.flushAllSessions();
        }
        catch (error) {
            cleanupErrors.push(error);
            sessionLog.error(`Failed to flush sessions ${stage}; cleanup will continue:`, error);
        }
    };
    sessionOperationContext.state.retentionStopping = true;
    for (const timer of sessionOperationContext.state.deferredAutomaticRetryTimers.values())
        clearTimeout(timer);
    sessionOperationContext.state.deferredAutomaticRetryTimers.clear();
    sessionOperationContext.state.deferredAutomaticRetryAttempts.clear();
    for (const timer of sessionOperationContext.state.delegatedTerminalResultRetryTimers.values())
        clearTimeout(timer);
    sessionOperationContext.state.delegatedTerminalResultRetryTimers.clear();
    sessionOperationContext.state.delegatedTerminalResultRetryAttempts.clear();
    if (sessionOperationContext.state.completedChatRetentionTimer)
        clearInterval(sessionOperationContext.state.completedChatRetentionTimer);
    await sessionOperationContext.state.completedChatRetentionSweep;
    // Complete create/import operations admitted before the synchronous
    // shutdown boundary before taking any session or persistence snapshot.
    await sessionOpDrainManagerOperations(sessionOperationContext);
    while (sessionOperationContext.state.sessionDeletionsInFlight.size > 0) {
        const deletions = [...sessionOperationContext.state.sessionDeletionsInFlight.entries()];
        const results = await Promise.allSettled(deletions.map(([, operation]) => operation));
        for (let index = 0; index < results.length; index++) {
            const result = results[index]!;
            if (result.status === 'rejected') {
                sessionLog.warn('Session deletion did not commit before shutdown cleanup', {
                    sessionId: deletions[index]![0],
                    error: result.reason instanceof Error ? result.reason.message : String(result.reason),
                });
            }
        }
    }
    await sessionOpDrainRestartRecoveries(sessionOperationContext);
    await sessionOpDrainStrongCancellationStops(sessionOperationContext);
    for (const managed of sessionOperationContext.state.sessions.values()) {
        // Close pre-execution permission waits while their runtime and tool row
        // are still attached. Disposing first can leave a durable `executing`
        // mutation with no receipt even though the host itself denied execution.
        const permissionGenerations = new Set([...sessionOperationContext.state.pendingPermissionRequests.values()]
            .filter(request => request.sessionId === managed.id)
            .map(request => request.processingGeneration));
        for (const generation of permissionGenerations) {
            await sessionOperationContext.owner["closePendingPermissionRequestsForStop"](managed, generation);
        }
        if (sessionOpRestorePreAckAgentDeliveryDequeues(sessionOperationContext, managed, true) > 0) {
            sessionOperationContext.owner["persistSession"](managed);
        }
        // An orderly shutdown owns the same pre-chat cleanup as Stop. Keep a
        // deliberately deferred queued record, but remove a dequeued hidden row
        // that no provider has seen and make its durable allocation replayable.
        if (sessionOpRemoveInFlightSyntheticAutomaticMessages(sessionOperationContext, managed, true) > 0) {
            const startedDispatch = managed.pendingTurnRecovery?.recoveryDispatch;
            if (startedDispatch?.phase === 'started') {
                const allocatedDispatch = { ...startedDispatch, phase: 'allocated' as const };
                delete allocatedDispatch.startedAt;
                managed.pendingTurnRecovery = {
                    ...managed.pendingTurnRecovery!,
                    recoveryDispatch: allocatedDispatch,
                };
            }
            sessionOperationContext.owner["persistSession"](managed);
        }
    }
    await flushPersistenceForCleanup('before runtime disposal');
    if (sessionOperationContext.state.runtimeEvictionTimer) {
        clearInterval(sessionOperationContext.state.runtimeEvictionTimer);
        sessionOperationContext.state.runtimeEvictionTimer = null;
    }
    for (const managed of sessionOperationContext.state.sessions.values()) {
        if (managed.autoRetryTimer) {
            clearTimeout(managed.autoRetryTimer);
            managed.autoRetryTimer = undefined;
        }
        managed.autoRetryPending = undefined;
        sessionOperationContext.owner["finishAllGenerationTelemetry"](managed, 'session_manager_shutdown');
    }
    const disposeAttachedRuntimes = async (reason: string): Promise<void> => {
        // Run in parallel so shutdown remains bounded even with many historical
        // sessions. Abort before detaching: a live chat iterator may own the very
        // operation lease that shutdown must drain after runtime destruction.
        await Promise.allSettled(Array.from(sessionOperationContext.state.sessions.values(), async (managed) => {
            const agent = managed.agent;
            if (agent && typeof agent.forceAbort === 'function') {
                try {
                    agent.forceAbort(AbortReason.UserStop);
                }
                catch (error) {
                    sessionLog.warn(`Failed to abort agent for ${managed.id} during ${reason}: ${error instanceof Error ? error.message : error}`);
                }
            }
            await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, reason);
        }));
    };
    // An already-admitted send can be paused before it attaches its runtime.
    // Revisit teardown while leases drain so a runtime attached after the first
    // snapshot is aborted instead of deadlocking shutdown. If an operation never
    // reaches a cancellable runtime boundary, fail explicitly rather than report
    // a successful cleanup with a live late writer.
    const operationDrainDeadline = Date.now() + SESSION_RUNTIME_DISPOSE_TIMEOUT_MS;
    await disposeAttachedRuntimes('session manager shutdown');
    let runtimeDisposalProofFailed = false;
    try {
        // A failed disposer can be the only mechanism capable of releasing a live
        // chat iterator. Retry its retained callable before waiting on that
        // iterator's session-operation lease.
        await sessionOpProveRuntimeDisposalsForCleanup(sessionOperationContext);
    }
    catch (error) {
        runtimeDisposalProofFailed = true;
        cleanupErrors.push(error);
        sessionLog.error('Session runtime destruction could not be proven during cleanup:', error);
    }
    let operationDrainTimedOut = false;
    while (true) {
        const operations = [...sessionOperationContext.state.sessions.values()].flatMap(managed => ([...(sessionOperationContext.state.sessionOperationsInFlight.get(managed) ?? [])]));
        if (operations.length === 0)
            break;
        if (Date.now() >= operationDrainDeadline) {
            if (!operationDrainTimedOut) {
                operationDrainTimedOut = true;
                const error = new Error('Shutdown session operation drain timed out before runtime destruction was proven');
                cleanupErrors.push(error);
                sessionLog.error(`${error.message}; cleanup will remain fail-closed until every admitted operation drains`);
            }
        }
        await Promise.race([
            Promise.allSettled(operations),
            new Promise<void>(resolve => {
                setTimeout(resolve, 10);
            }),
        ]);
        await disposeAttachedRuntimes('late session runtime during shutdown');
        try {
            await sessionOpProveRuntimeDisposalsForCleanup(sessionOperationContext);
            runtimeDisposalProofFailed = false;
        }
        catch (error) {
            if (!runtimeDisposalProofFailed)
                cleanupErrors.push(error);
            runtimeDisposalProofFailed = true;
            operationDrainTimedOut = true;
            sessionLog.error('Late session runtime destruction could not be proven during cleanup; waiting for admitted operations:', error);
        }
    }
    // Stable second pass: every ordinary operation is now drained and admission
    // is closed, so no new runtime can appear after this teardown snapshot.
    await disposeAttachedRuntimes('post-drain session manager shutdown');
    try {
        // Failed destructors have already nulled ManagedSession runtime fields;
        // retry and drain the independent barrier registries before claiming the
        // shutdown has released subprocesses or MCP clients.
        if (!runtimeDisposalProofFailed)
            await sessionOpProveRuntimeDisposalsForCleanup(sessionOperationContext);
    }
    catch (error) {
        cleanupErrors.push(error);
        sessionLog.error('Session runtime destruction could not be proven during cleanup:', error);
    }
    finally {
        sessionOperationContext.state.shutdownTerminalResultAdmissionOpen = false;
    }
    // Destructors may synchronously emit a final tool_result immediately before
    // resolving. Once the narrow gate is closed this drain is stable.
    await sessionOpDrainAllSessionOperations(sessionOperationContext);
    // Drain saves from tool results produced while the provider was stopping.
    await flushPersistenceForCleanup('after runtime disposal');
    sessionOperationContext.state.agentRefreshLocks.clear();
    // Dispose all AutomationSystems (includes scheduler, handlers, and event loggers)
    for (const [workspacePath, automationSystem] of sessionOperationContext.state.automationSystems) {
        try {
            automationSystem.dispose();
            sessionLog.info(`Disposed AutomationSystem for ${workspacePath}`);
        }
        catch (error) {
            sessionLog.error(`Failed to dispose AutomationSystem for ${workspacePath}:`, error);
        }
    }
    sessionOperationContext.state.automationSystems.clear();
    // Clear all pending delta flush timers
    for (const [_sessionId, timer] of sessionOperationContext.state.deltaFlushTimers) {
        clearTimeout(timer);
    }
    sessionOperationContext.state.deltaFlushTimers.clear();
    sessionOperationContext.state.pendingDeltas.clear();
    // Clear pending credential resolvers (they won't be resolved, but prevents memory leak)
    sessionOperationContext.state.pendingCredentialResolvers.clear();
    sessionOperationContext.state.credentialResponsesInFlight.clear();
    sessionOperationContext.state.oauthResponsesInFlight.clear();
    for (const [requestId, metadata] of sessionOperationContext.state.pendingPermissionRequests.entries()) {
        clearTimeout(metadata.timeout);
        sessionOpRejectPendingPrivilegedApproval(sessionOperationContext, requestId, metadata);
        sessionOpDenyPermissionOnRecordedRuntime(sessionOperationContext, requestId, metadata);
    }
    sessionOperationContext.state.pendingPermissionRequests.clear();
    sessionOperationContext.state.adminRememberApprovals.clear();
    if (cleanupErrors.length === 1) {
        sessionLog.error('Cleanup released resources but one cleanup proof failed');
        throw cleanupErrors[0];
    }
    if (cleanupErrors.length > 1) {
        sessionLog.error('Cleanup released resources but multiple cleanup proofs failed');
        throw new AggregateError(cleanupErrors, 'Session manager cleanup completed with cleanup proof failures');
    }
    sessionLog.info('Cleanup complete');
}

export { sessionOpCleanup as cleanup };
export { sessionOpCleanupResources as cleanupResources };
