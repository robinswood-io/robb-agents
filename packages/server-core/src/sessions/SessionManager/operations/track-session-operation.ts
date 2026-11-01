import type { SessionOperationContext } from '../operation-context.ts';
import type { ManagedSession } from '../managed-session.ts';
import type { AgentInstance } from '../runtime-types.ts';

function sessionOpOwnsSessionOperation(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    return !sessionOperationContext.state.retiringSessions.has(managed) && sessionOperationContext.state.sessions.get(managed.id) === managed;
}

function sessionOpAssertSessionOperationOwner(sessionOperationContext: SessionOperationContext, managed: ManagedSession): void {
    if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed)) {
        throw new Error(`Session ${managed.id} is being deleted`);
    }
}

/** Entry guard for synchronous/public mutations. Do not use this inside an
 * already-admitted async operation: those operations retain their lease while
 * shutdown drains them and must keep using assertSessionOperationOwner(). */
function sessionOpAssertSessionMutationAdmissionOpen(sessionOperationContext: SessionOperationContext, managed: ManagedSession): void {
    if (sessionOperationContext.state.shuttingDown) {
        throw new Error('Cannot start a session operation while the session manager is shutting down');
    }
    sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
}

function sessionOpAssertSessionRuntimeOperationOwner(sessionOperationContext: SessionOperationContext, managed: ManagedSession, agent: AgentInstance): void {
    sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    if (managed.agent !== agent) {
        throw new Error(`Session ${managed.id} runtime changed during source update`);
    }
}

function sessionOpTrackSessionOperation<T>(sessionOperationContext: SessionOperationContext, managed: ManagedSession, operation: () => Promise<T>, allowShutdownTerminalResult = false): Promise<T> {
    if (sessionOperationContext.state.shuttingDown
        && !(allowShutdownTerminalResult && sessionOperationContext.state.shutdownTerminalResultAdmissionOpen)) {
        return Promise.reject(new Error('Cannot start a session operation while the session manager is shutting down'));
    }
    if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed)) {
        return Promise.reject(new Error(`Session ${managed.id} is being deleted`));
    }
    let operations = sessionOperationContext.state.sessionOperationsInFlight.get(managed);
    if (!operations) {
        operations = new Set();
        sessionOperationContext.state.sessionOperationsInFlight.set(managed, operations);
    }
    // Preserve the original synchronous admission semantics of async session
    // methods: several private capabilities are valid only until the first
    // await. Deferring `operation` to a microtask can let their owner finish
    // and revoke them before the guarded method has even entered.
    let tracked: Promise<T>;
    try {
        tracked = Promise.resolve(operation());
    }
    catch (error) {
        tracked = Promise.reject(error);
    }
    operations.add(tracked);
    void tracked.finally(() => {
        const current = sessionOperationContext.state.sessionOperationsInFlight.get(managed);
        current?.delete(tracked);
        if (current?.size === 0)
            sessionOperationContext.state.sessionOperationsInFlight.delete(managed);
    }).catch(() => { });
    return tracked;
}

function sessionOpTrackManagerOperation<T>(sessionOperationContext: SessionOperationContext, operation: () => Promise<T>): Promise<T> {
    if (sessionOperationContext.state.shuttingDown) {
        return Promise.reject(new Error('Cannot start a manager operation while the session manager is shutting down'));
    }
    let tracked: Promise<T>;
    try {
        tracked = Promise.resolve(operation());
    }
    catch (error) {
        tracked = Promise.reject(error);
    }
    sessionOperationContext.state.managerOperationsInFlight.add(tracked);
    void tracked.finally(() => sessionOperationContext.state.managerOperationsInFlight.delete(tracked)).catch(() => { });
    return tracked;
}

async function sessionOpDrainManagerOperations(sessionOperationContext: SessionOperationContext): Promise<void> {
    while (sessionOperationContext.state.managerOperationsInFlight.size > 0) {
        await Promise.allSettled([...sessionOperationContext.state.managerOperationsInFlight]);
    }
}

/** Shutdown closes both scheduler and recovery admission synchronously.
 * Drain the scheduler owner first, then every exact cold-recovery operation,
 * so no hydrated callback can persist or emit beyond the final flush. */
async function sessionOpDrainRestartRecoveries(sessionOperationContext: SessionOperationContext): Promise<void> {
    while (true) {
        const admissionDrain = sessionOperationContext.state.automaticAdmissionDrain;
        if (admissionDrain)
            await Promise.allSettled([admissionDrain]);
        await Promise.resolve();
        const recoveries = [...sessionOperationContext.state.restartRecoveriesInFlight.values()];
        if (recoveries.length === 0 && !sessionOperationContext.state.automaticAdmissionDrain)
            return;
        await Promise.allSettled(recoveries);
    }
}

/** A strong cancellation call may time out for its caller while the durable
 * silent Stop it started is still running. The caller's session lease is then
 * gone, so shutdown/deletion must also drain this retained owner directly. */
async function sessionOpDrainStrongCancellationStops(sessionOperationContext: SessionOperationContext): Promise<void> {
    while (true) {
        const operations = [...new Set([...sessionOperationContext.state.strongCancellationStops.values()].map(retirement => retirement.operation))];
        if (operations.length === 0)
            return;
        await Promise.allSettled(operations);
        await Promise.resolve();
        const current = [...sessionOperationContext.state.strongCancellationStops.values()]
            .map(retirement => retirement.operation);
        if (current.every(operation => operations.includes(operation)))
            return;
    }
}

async function sessionOpDrainSessionOperations(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<void> {
    while (true) {
        const operations = sessionOperationContext.state.sessionOperationsInFlight.get(managed);
        if (!operations?.size)
            return;
        await Promise.allSettled([...operations]);
    }
}

/** Drain every operation owned by a currently managed session. Ordinary
 * admission is closed before shutdown calls this. The second shutdown drain
 * runs after terminal-result admission closes, which makes the empty snapshot
 * a stable barrier rather than a best-effort observation. */
async function sessionOpDrainAllSessionOperations(sessionOperationContext: SessionOperationContext): Promise<void> {
    while (true) {
        const managedSessions = [...sessionOperationContext.state.sessions.values()];
        await Promise.all(managedSessions.map(managed => sessionOpDrainSessionOperations(sessionOperationContext, managed)));
        await Promise.resolve();
        if (managedSessions.every(managed => ((sessionOperationContext.state.sessionOperationsInFlight.get(managed)?.size ?? 0) === 0)))
            return;
    }
}

export { sessionOpOwnsSessionOperation as ownsSessionOperation };
export { sessionOpAssertSessionOperationOwner as assertSessionOperationOwner };
export { sessionOpAssertSessionMutationAdmissionOpen as assertSessionMutationAdmissionOpen };
export { sessionOpAssertSessionRuntimeOperationOwner as assertSessionRuntimeOperationOwner };
export { sessionOpTrackSessionOperation as trackSessionOperation };
export { sessionOpTrackManagerOperation as trackManagerOperation };
export { sessionOpDrainManagerOperations as drainManagerOperations };
export { sessionOpDrainRestartRecoveries as drainRestartRecoveries };
export { sessionOpDrainStrongCancellationStops as drainStrongCancellationStops };
export { sessionOpDrainSessionOperations as drainSessionOperations };
export { sessionOpDrainAllSessionOperations as drainAllSessionOperations };
