import type { SessionOperationContext } from '../operation-context.ts';
import { unregisterSessionScopedToolCallbacks } from '@craft-agent/shared/agent';
import { CodedError } from '@craft-agent/shared/protocol';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { withRuntimeDisposeTimeout } from '../runtime-policy.ts';
import type { SessionCompletionEvent } from '../runtime-types.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation } from './track-session-operation.ts';
import { clearDeferredAutomaticRetry as sessionOpClearDeferredAutomaticRetry } from './start-recovery-dispatch.ts';
import { finishManagedAgentRuntimeDisposal as sessionOpFinishManagedAgentRuntimeDisposal } from './evict-idle-session-runtimes.ts';

/** Cancel a Conductor child and wait for the same host completion seam used
 * by the runner. `cancelProcessing` deliberately returns after requesting a
 * soft abort; this stronger primitive proves an old worker/reviewer idle
 * before terminality or a replacement attempt. */
function sessionOpAssertStrongCancellationAdmissionOpen(sessionOperationContext: SessionOperationContext, managed: ManagedSession): void {
    const retirement = sessionOperationContext.state.strongCancellationStops.get(managed.id);
    if (retirement?.managed !== managed)
        return;
    throw new CodedError('CAPABILITY_UNAVAILABLE', 'This session is being retired; wait for the strong Stop proof before starting more work.');
}

async function sessionOpCancelProcessingAndWait(sessionOperationContext: SessionOperationContext, sessionId: string, timeoutMs: number): Promise<SessionCompletionEvent> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        throw new Error(`Session ${sessionId} not found while retiring reviewer`);
    // The strong Stop implementation intentionally uses the silent/untracked
    // cancel path below to avoid nesting a second lease. This outer lease owns
    // the complete stop proof for deletion and shutdown.
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOperationContext.owner["performCancelProcessingAndWait"](managed, timeoutMs));
}

async function sessionOpPerformCancelProcessingAndWait(sessionOperationContext: SessionOperationContext, managed: ManagedSession, timeoutMs: number): Promise<SessionCompletionEvent> {
    const sessionId = managed.id;
    const snapshot = (reason: SessionCompletionEvent['reason'] = 'interrupted'): SessionCompletionEvent => ({
        sessionId: managed.id,
        workspaceId: managed.workspace.id,
        reason,
        ...(managed.lastFinalMessageId ? { finalMessageId: managed.lastFinalMessageId } : {}),
        ...(sessionOperationContext.owner.getSessionFinalText(managed.id) !== undefined
            ? { finalText: sessionOperationContext.owner.getSessionFinalText(managed.id) }
            : {}),
        ...(managed.tokenUsage ? { tokenUsage: { ...managed.tokenUsage } } : {}),
    });
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const timeoutError = () => new Error(`Session ${sessionId} did not stop within ${timeoutMs} ms`);
    const waitWithinDeadline = async <T>(operation: Promise<T>): Promise<T> => {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0)
            throw timeoutError();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                operation,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(timeoutError()), remainingMs);
                }),
            ]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    };
    let retirement = sessionOperationContext.state.strongCancellationStops.get(sessionId);
    // A completed Stop owns exactly one processing generation. If something
    // escaped the admission fence and advanced the session afterwards, the old
    // proof cannot be reused: a later strong caller must issue a fresh Stop.
    if (retirement?.managed === managed && (retirement.stopFailed
        || (retirement.stopCompleted && retirement.generation !== managed.processingGeneration))) {
        sessionOperationContext.state.strongCancellationStops.delete(sessionId);
        retirement.offCompletion();
        retirement = undefined;
    }
    if (retirement?.managed !== managed) {
        retirement?.offCompletion();
        // Defer the Stop by one microtask so the completion listener and
        // coalescing entry exist even if a test/backend completes synchronously.
        const ownedRetirement = {
            managed,
            operation: Promise.resolve(),
            requiresCompletion: false,
            generation: managed.processingGeneration,
            stopCompleted: false,
            stopFailed: false,
            completionEvent: undefined as SessionCompletionEvent | undefined,
            completionGeneration: undefined as number | undefined,
            offCompletion: () => { },
        };
        const operation = Promise.resolve().then(async () => {
            const startedProcessing = managed.isProcessing;
            const startedGeneration = managed.processingGeneration;
            ownedRetirement.requiresCompletion = startedProcessing;
            ownedRetirement.generation = startedGeneration;
            try {
                await sessionOperationContext.owner.cancelProcessing(sessionId, true);
            }
            catch (error) {
                ownedRetirement.stopFailed = true;
                throw error;
            }
            // An idle Stop intentionally advances the generation. For a live Stop,
            // retaining the captured generation binds its completion receipt to the
            // exact turn that was cancelled.
            if (!startedProcessing)
                ownedRetirement.generation = managed.processingGeneration;
            ownedRetirement.stopCompleted = true;
        });
        ownedRetirement.operation = operation;
        retirement = ownedRetirement;
        retirement.offCompletion = sessionOperationContext.owner.onSessionComplete(event => {
            if (event.sessionId !== sessionId)
                return;
            if (managed.processingGeneration !== ownedRetirement.generation)
                return;
            ownedRetirement.completionEvent = event;
            ownedRetirement.completionGeneration = managed.processingGeneration;
        });
        sessionOperationContext.state.strongCancellationStops.set(sessionId, retirement);
        // Keep both successful and rejected transactions owned. Admission stays
        // fenced after a failed Stop; the next strong caller replaces that failed
        // operation and retries it rather than allowing ordinary work through.
        void operation.catch(() => { });
    }
    const releaseRetirement = (): void => {
        if (sessionOperationContext.state.strongCancellationStops.get(sessionId) !== retirement)
            return;
        sessionOperationContext.state.strongCancellationStops.delete(sessionId);
        retirement.offCompletion();
    };
    const revokeRuntimeAdmissions = (): void => {
        sessionOpClearDeferredAutomaticRetry(sessionOperationContext, sessionId);
        sessionOperationContext.state.deferredAutomaticSessions.delete(sessionId);
        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
        sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
    };
    const isQuiescent = (current: ManagedSession): boolean => (!current.isProcessing
        && !sessionOperationContext.state.deferredAutomaticSessions.has(sessionId)
        && !sessionOperationContext.state.automaticAdmissionReservations.has(sessionId)
        && !sessionOperationContext.state.queuedMessageDispatches.has(sessionId)
        && ![...sessionOperationContext.state.queuedAgentDeliveryDispatches.values()]
            .some(dispatch => dispatch.sessionId === sessionId)
        && !sessionOperationContext.state.deferredAutomaticRetryTimers.has(sessionId)
        && !sessionOperationContext.state.retryTurnsInFlight.has(sessionId)
        && !sessionOperationContext.state.coldProviderReconciliationsInFlight.has(sessionId)
        && (sessionOperationContext.state.runtimeDisposalsInFlight.get(sessionId)?.size ?? 0) === 0
        && (sessionOperationContext.state.runtimeDisposalBarriers.get(sessionId)?.size ?? 0) === 0
        && current.processingGeneration === retirement.generation
        // A processing child is not retired merely because cleanup cleared its
        // boolean marker. Its post-provider lifecycle must reach the completion
        // seam, which is emitted only after timeout/error runtime destruction.
        && (!retirement.requiresCompletion || (retirement.completionEvent !== undefined
            && retirement.completionGeneration === retirement.generation))
        && current.autoRetryTimer === undefined
        && (current.autoRetryPending === undefined
            || (current.autoRetryPending.cancelled
                && current.autoRetryPending.committed
                && !current.autoRetryPending.dispatchInFlight)));
    // Always execute (or join) the durable Stop path. An idle session may still
    // own a queued automatic recovery or FIFO admission that can restart spend.
    await waitWithinDeadline(retirement.operation);
    revokeRuntimeAdmissions();
    let retriedRuntimeDisposals = false;
    while (true) {
        const current = sessionOperationContext.state.sessions.get(sessionId);
        if (!current) {
            releaseRetirement();
            throw new Error(`Session ${sessionId} disappeared while retiring reviewer`);
        }
        if (current !== managed) {
            releaseRetirement();
            throw new Error(`Session ${sessionId} was replaced while being retired`);
        }
        if (retirement.stopCompleted && current.processingGeneration !== retirement.generation) {
            // Keep the owned retirement registered. The next strong call detects
            // this generation change, replaces the proof, and reissues Stop.
            throw new Error(`Session ${sessionId} started a newer generation while being retired`);
        }
        const disposalBarriers = sessionOperationContext.state.runtimeDisposalBarriers.get(sessionId);
        if (!retriedRuntimeDisposals && disposalBarriers?.size
            && (sessionOperationContext.state.runtimeDisposalsInFlight.get(sessionId)?.size ?? 0) === 0) {
            retriedRuntimeDisposals = true;
            await waitWithinDeadline(sessionOpRetryManagedAgentRuntimeDisposals(sessionOperationContext, sessionId));
            continue;
        }
        if (isQuiescent(current)) {
            const event = retirement.completionGeneration === retirement.generation
                ? retirement.completionEvent
                : undefined;
            const completed = event
                ?? snapshot(current.activeObjective?.terminalState === 'complete_verified' ? 'complete' : 'interrupted');
            releaseRetirement();
            return completed;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
            // Keep the still-owned retirement registered so the next attempt joins
            // the same Stop and retains its eventual completion receipt.
            throw timeoutError();
        }
        const pendingRetry = sessionOperationContext.state.retryTurnsInFlight.get(sessionId);
        const admissionDrain = sessionOperationContext.state.automaticAdmissionDrain;
        await Promise.race([
            ...(pendingRetry ? [pendingRetry.then(() => undefined, () => undefined)] : []),
            ...(admissionDrain ? [admissionDrain.then(() => undefined, () => undefined)] : []),
            new Promise<void>(resolve => setTimeout(resolve, Math.min(25, remainingMs))),
        ]);
        // A stale callback may briefly restore a marker before it observes the
        // advanced cancellation epoch. Revoke it again before the next proof.
        revokeRuntimeAdmissions();
    }
}

function sessionOpDisposeManagedAgentRuntime(sessionOperationContext: SessionOperationContext, managed: ManagedSession, reason: string): Promise<void> {
    return sessionOpTrackManagedAgentRuntimeDisposal(sessionOperationContext, managed.id, sessionOpPerformManagedAgentRuntimeDisposal(sessionOperationContext, managed, reason));
}

function sessionOpTrackManagedAgentRuntimeDisposal(sessionOperationContext: SessionOperationContext, sessionId: string, operation: Promise<void>): Promise<void> {
    let operations = sessionOperationContext.state.runtimeDisposalsInFlight.get(sessionId);
    if (!operations) {
        operations = new Set();
        sessionOperationContext.state.runtimeDisposalsInFlight.set(sessionId, operations);
    }
    operations.add(operation);
    void operation.then(() => sessionOpFinishManagedAgentRuntimeDisposal(sessionOperationContext, sessionId, operation), () => sessionOpFinishManagedAgentRuntimeDisposal(sessionOperationContext, sessionId, operation));
    return operation;
}

function sessionOpCreateManagedAgentRuntimeDisposalBarrier(sessionOperationContext: SessionOperationContext, sessionId: string, label: string, dispose: () => void | Promise<void>): Promise<void> {
    let barriers = sessionOperationContext.state.runtimeDisposalBarriers.get(sessionId);
    if (!barriers) {
        barriers = new Map();
        sessionOperationContext.state.runtimeDisposalBarriers.set(sessionId, barriers);
    }
    const key = Symbol(label);
    const barrier = { label, dispose, inFlight: undefined as Promise<void> | undefined };
    barriers.set(key, barrier);
    return sessionOpRunManagedAgentRuntimeDisposalBarrier(sessionOperationContext, sessionId, key, barrier);
}

function sessionOpRunManagedAgentRuntimeDisposalBarrier(sessionOperationContext: SessionOperationContext, sessionId: string, key: symbol, barrier: {
    label: string;
    dispose: () => void | Promise<void>;
    inFlight?: Promise<void>;
}): Promise<void> {
    if (barrier.inFlight)
        return barrier.inFlight;
    let rawDisposal: Promise<void>;
    try {
        rawDisposal = Promise.resolve(barrier.dispose());
    }
    catch (error) {
        rawDisposal = Promise.reject(error);
    }
    barrier.inFlight = rawDisposal;
    sessionOpTrackManagedAgentRuntimeDisposal(sessionOperationContext, sessionId, rawDisposal);
    void rawDisposal.then(() => {
        const barriers = sessionOperationContext.state.runtimeDisposalBarriers.get(sessionId);
        if (barriers?.get(key) !== barrier)
            return;
        barrier.inFlight = undefined;
        barriers.delete(key);
        if (barriers.size === 0)
            sessionOperationContext.state.runtimeDisposalBarriers.delete(sessionId);
    }, () => {
        const barriers = sessionOperationContext.state.runtimeDisposalBarriers.get(sessionId);
        if (barriers?.get(key) === barrier)
            barrier.inFlight = undefined;
    });
    return rawDisposal;
}

async function sessionOpRetryManagedAgentRuntimeDisposals(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<void> {
    const barriers = sessionOperationContext.state.runtimeDisposalBarriers.get(sessionId);
    if (!barriers?.size)
        return;
    const entries = [...barriers.entries()];
    const results = await Promise.allSettled(entries.map(([key, barrier]) => (sessionOpRunManagedAgentRuntimeDisposalBarrier(sessionOperationContext, sessionId, key, barrier))));
    const failures = results.flatMap((result, index) => result.status === 'rejected'
        ? [new Error(`${entries[index]![1].label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)]
        : []);
    if (failures.length > 0) {
        throw new AggregateError(failures, `Runtime destruction for session ${sessionId} is not yet proven`);
    }
}

/** Shutdown must prove destruction independently of the fields on
 * ManagedSession: a failed disposer is deliberately detached from those
 * fields and survives only in the retryable barrier maps. */
async function sessionOpProveRuntimeDisposalsForCleanup(sessionOperationContext: SessionOperationContext): Promise<void> {
    const sessionIds = new Set([
        ...sessionOperationContext.state.runtimeDisposalsInFlight.keys(),
        ...sessionOperationContext.state.runtimeDisposalBarriers.keys(),
    ]);
    const failures: Error[] = [];
    await Promise.all([...sessionIds].map(async (sessionId) => {
        try {
            await withRuntimeDisposeTimeout((async () => {
                const inFlight = sessionOperationContext.state.runtimeDisposalsInFlight.get(sessionId);
                if (inFlight?.size)
                    await Promise.allSettled([...inFlight]);
                // Let the raw-disposal completion handlers clear their in-flight
                // marker before retrying the retained callable.
                await Promise.resolve();
                await sessionOpRetryManagedAgentRuntimeDisposals(sessionOperationContext, sessionId);
                const retried = sessionOperationContext.state.runtimeDisposalsInFlight.get(sessionId);
                if (retried?.size)
                    await Promise.allSettled([...retried]);
                await Promise.resolve();
                const remainingBarriers = sessionOperationContext.state.runtimeDisposalBarriers.get(sessionId)?.size ?? 0;
                const remainingDisposals = sessionOperationContext.state.runtimeDisposalsInFlight.get(sessionId)?.size ?? 0;
                if (remainingBarriers > 0 || remainingDisposals > 0) {
                    throw new Error(`Runtime destruction for session ${sessionId} remains unproven `
                        + `(${remainingBarriers} barriers, ${remainingDisposals} disposals)`);
                }
            })(), `Shutdown runtime destruction proof for ${sessionId}`);
        }
        catch (error) {
            failures.push(new Error(`Runtime destruction for session ${sessionId} failed during shutdown: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
        }
    }));
    if (failures.length > 0) {
        throw new AggregateError(failures, 'Shutdown could not prove destruction of every session runtime');
    }
}

async function sessionOpPerformManagedAgentRuntimeDisposal(sessionOperationContext: SessionOperationContext, managed: ManagedSession, reason: string): Promise<void> {
    const sessionId = managed.id;
    // Detach the complete runtime synchronously before awaiting any shutdown
    // hook. A message can arrive while an idle eviction is awaiting a slow
    // subprocess; detaching first makes that message build a fresh runtime and
    // prevents the old disposal from clearing the replacement afterwards.
    const agent = managed.agent;
    const poolServer = managed.poolServer;
    const mcpPool = managed.mcpPool;
    managed.agent = null;
    managed.poolServer = undefined;
    managed.mcpPool = undefined;
    managed.envOverrides = undefined;
    managed.agentReady = undefined;
    managed.agentReadyResolve = undefined;
    managed.backendRuntimeSignature = undefined;
    managed.backendRestartSignature = undefined;
    managed.runtimeLastActiveAt = undefined;
    unregisterSessionScopedToolCallbacks(sessionId);
    if (agent) {
        try {
            const label = `Agent disposal for ${sessionId}`;
            const agentDisposal = sessionOpCreateManagedAgentRuntimeDisposalBarrier(sessionOperationContext, sessionId, label, () => agent.disposeForRestart ? agent.disposeForRestart() : agent.dispose());
            await withRuntimeDisposeTimeout(agentDisposal, label);
        }
        catch (error) {
            sessionLog.warn(`Failed to dispose agent for ${sessionId} during ${reason}: ${error instanceof Error ? error.message : error}`);
        }
    }
    if (poolServer) {
        try {
            const label = `Pool server shutdown for ${sessionId}`;
            const poolServerDisposal = sessionOpCreateManagedAgentRuntimeDisposalBarrier(sessionOperationContext, sessionId, label, () => poolServer.stop());
            await withRuntimeDisposeTimeout(poolServerDisposal, label);
        }
        catch (error) {
            sessionLog.warn(`Failed to stop pool server for ${sessionId} during ${reason}: ${error instanceof Error ? error.message : error}`);
        }
    }
    if (mcpPool) {
        try {
            const label = `MCP pool disconnect for ${sessionId}`;
            const mcpPoolDisposal = sessionOpCreateManagedAgentRuntimeDisposalBarrier(sessionOperationContext, sessionId, label, () => mcpPool.disconnectAll());
            await withRuntimeDisposeTimeout(mcpPoolDisposal, label);
        }
        catch (error) {
            sessionLog.warn(`Failed to disconnect MCP pool for ${sessionId} during ${reason}: ${error instanceof Error ? error.message : error}`);
        }
    }
}

export { sessionOpAssertStrongCancellationAdmissionOpen as assertStrongCancellationAdmissionOpen };
export { sessionOpCancelProcessingAndWait as cancelProcessingAndWait };
export { sessionOpPerformCancelProcessingAndWait as performCancelProcessingAndWait };
export { sessionOpDisposeManagedAgentRuntime as disposeManagedAgentRuntime };
export { sessionOpTrackManagedAgentRuntimeDisposal as trackManagedAgentRuntimeDisposal };
export { sessionOpCreateManagedAgentRuntimeDisposalBarrier as createManagedAgentRuntimeDisposalBarrier };
export { sessionOpRunManagedAgentRuntimeDisposalBarrier as runManagedAgentRuntimeDisposalBarrier };
export { sessionOpRetryManagedAgentRuntimeDisposals as retryManagedAgentRuntimeDisposals };
export { sessionOpProveRuntimeDisposalsForCleanup as proveRuntimeDisposalsForCleanup };
export { sessionOpPerformManagedAgentRuntimeDisposal as performManagedAgentRuntimeDisposal };
