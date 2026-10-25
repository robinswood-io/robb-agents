import type { SessionOperationContext } from '../operation-context.ts';
import { persistenceRootFor } from '../policy.ts';
import { setPendingPlanExecution as setStoredPendingPlanExecution, markCompactionComplete as markStoredCompactionComplete, markPendingPlanExecutionDispatched as markStoredPendingPlanExecutionDispatched, clearPendingPlanExecution as clearStoredPendingPlanExecution, getPendingPlanExecution as getStoredPendingPlanExecution } from '@craft-agent/shared/sessions';
import type { ManagedSession } from '../managed-session.ts';
import { hasImmutableMissionRoute } from '../mission-route.ts';
import { sessionLog } from '../runtime-platform.ts';
import { resolveSupportsBranching } from '../source-selection.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation, assertSessionOperationOwner as sessionOpAssertSessionOperationOwner, ownsSessionOperation as sessionOpOwnsSessionOperation } from './track-session-operation.ts';
import { generateRemoteTransferSummary as sessionOpGenerateRemoteTransferSummary } from './session-transfer.ts';

/**
 * Set the LLM connection for a session.
 *
 * Upstream locks the provider after the first message. Robinswood keeps that
 * safety while a turn is running, but allows an explicit provider handoff
 * between turns: summarize context best-effort, dispose the current backend,
 * clear provider-native resume state, and let the next send create a fresh
 * backend on the selected connection with a one-shot summary injection.
 */
async function sessionOpSetSessionConnection(sessionOperationContext: SessionOperationContext, sessionId: string, connectionSlug: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        sessionLog.warn(`setSessionConnection: session ${sessionId} not found`);
        throw new Error(`Session ${sessionId} not found`);
    }
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpPerformSetSessionConnection(sessionOperationContext, managed, connectionSlug));
}

async function sessionOpPerformSetSessionConnection(sessionOperationContext: SessionOperationContext, managed: ManagedSession, connectionSlug: string): Promise<void> {
    const sessionId = managed.id;
    if (hasImmutableMissionRoute(managed)) {
        throw new Error('Mission session route is immutable');
    }
    // Validate connection exists before mutating runtime state.
    const { getLlmConnection } = await import('@craft-agent/shared/config/storage');
    sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    const connection = getLlmConnection(connectionSlug);
    if (!connection) {
        sessionLog.warn(`setSessionConnection: connection "${connectionSlug}" not found`);
        throw new Error(`LLM connection "${connectionSlug}" not found`);
    }
    const hasStarted = (managed.messages?.length ?? 0) > 0;
    const isSameConnection = managed.llmConnection === connectionSlug;
    if (hasStarted && (managed.isProcessing || managed.agent?.isProcessing())) {
        sessionLog.warn(`setSessionConnection: cannot hand off provider while session is processing (${sessionId})`);
        throw new Error('Cannot change connection while session is processing');
    }
    if (hasStarted && !isSameConnection) {
        sessionLog.info(`Provider handoff for session ${sessionId}: ${managed.llmConnection ?? '(default)'} -> ${connectionSlug}`);
        let summary: string | null | undefined;
        try {
            summary = await sessionOpGenerateRemoteTransferSummary(sessionOperationContext, managed);
        }
        catch (error) {
            sessionLog.warn(`Provider handoff summary failed for session ${sessionId}: ${error instanceof Error ? error.message : error}`);
        }
        sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
        if (summary?.trim()) {
            managed.transferredSessionSummary = [
                'Context summary from before a manual provider handoff:',
                summary.trim(),
            ].join('\n\n');
            managed.transferredSessionSummaryApplied = false;
            sessionLog.info(`Provider handoff summary prepared for session ${sessionId}: ${summary.length} chars`);
        }
        // Provider-native SDK session ids are not portable across backends. Clear
        // them so the next agent starts cleanly and uses the one-shot handoff
        // summary instead of attempting an incompatible resume.
        managed.sdkSessionId = undefined;
        managed.branchFromSdkSessionId = undefined;
        managed.branchFromSdkCwd = undefined;
        managed.branchFromSdkTurnId = undefined;
        managed.pendingRoutingReason = 'manual-handoff';
        await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'manual provider handoff');
        sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    }
    managed.llmConnection = connectionSlug;
    managed.connectionRoutePinned = true;
    if (!isSameConnection) {
        // A manual provider change selects that connection's configured default;
        // never carry an incompatible model from the previous provider.
        managed.model = connection.defaultModel;
        managed.modelRoutePinned = false;
        sessionOperationContext.owner["sendEvent"]({
            type: 'session_model_changed',
            sessionId,
            model: managed.model ?? null,
            modelRoutePinned: false,
        }, managed.workspace.id);
    }
    managed.connectionLocked = true;
    // Persist in-memory state directly to avoid race with pending queue writes.
    sessionOperationContext.owner["persistSession"](managed);
    await sessionOperationContext.owner.flushSession(managed.id);
    sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    sessionLog.info(`Set LLM connection for session ${sessionId} to ${connectionSlug}${hasStarted ? ' (handoff)' : ''}`);
    // Notify UI that connection changed (triggers capabilities refresh)
    sessionOperationContext.owner["sendEvent"]({
        type: 'connection_changed',
        sessionId,
        connectionSlug,
        supportsBranching: resolveSupportsBranching(managed),
    }, managed.workspace.id);
}

// ============================================
// Pending Plan Execution (Accept & Compact)
// ============================================
/**
 * Set pending plan execution state.
 * Called when user clicks "Accept & Compact" to persist the plan path
 * so execution can resume after compaction (even if page reloads).
 */
async function sessionOpSetPendingPlanExecution(sessionOperationContext: SessionOperationContext, sessionId: string, planPath: string, draftInputSnapshot?: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        return;
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
        sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
        await setStoredPendingPlanExecution(persistenceRootFor(managed), sessionId, planPath, draftInputSnapshot, managed.persistenceRootIdentity);
        sessionLog.info(`Session ${sessionId}: set pending plan execution for ${planPath}`);
    });
}

/**
 * Mark compaction as complete for pending plan execution.
 * Called when compaction_complete event fires - allows reload recovery
 * to know that compaction finished and plan can be executed.
 */
async function sessionOpMarkCompactionComplete(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        return;
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
        sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
        await markStoredCompactionComplete(persistenceRootFor(managed), sessionId, managed.persistenceRootIdentity);
        sessionLog.info(`Session ${sessionId}: compaction marked complete for pending plan`);
    });
}

/**
 * Mark pending plan execution as already dispatched from the UI.
 * This prevents reload recovery from double-submitting the same plan if
 * sending succeeded but cleanup failed due a reconnect/disconnect.
 */
async function sessionOpMarkPendingPlanExecutionDispatched(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        return;
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
        sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
        await markStoredPendingPlanExecutionDispatched(persistenceRootFor(managed), sessionId, managed.persistenceRootIdentity);
        sessionLog.info(`Session ${sessionId}: marked pending plan execution as dispatched`);
    });
}

/**
 * Clear pending plan execution state.
 * Called after plan execution is triggered, on new user message,
 * or when the pending execution is no longer relevant.
 */
async function sessionOpClearPendingPlanExecution(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        return;
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
        sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
        await clearStoredPendingPlanExecution(persistenceRootFor(managed), sessionId, managed.persistenceRootIdentity);
        sessionLog.info(`Session ${sessionId}: cleared pending plan execution`);
    });
}

/**
 * Get pending plan execution state for a session.
 * Used on reload/init to check if we need to resume plan execution.
 */
function sessionOpGetPendingPlanExecution(sessionOperationContext: SessionOperationContext, sessionId: string): {
    planPath: string;
    draftInputSnapshot?: string;
    awaitingCompaction: boolean;
    executionDispatched: boolean;
} | null {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed || !sessionOpOwnsSessionOperation(sessionOperationContext, managed))
        return null;
    return getStoredPendingPlanExecution(persistenceRootFor(managed), sessionId, managed.persistenceRootIdentity);
}

export { sessionOpSetSessionConnection as setSessionConnection };
export { sessionOpPerformSetSessionConnection as performSetSessionConnection };
export { sessionOpSetPendingPlanExecution as setPendingPlanExecution };
export { sessionOpMarkCompactionComplete as markCompactionComplete };
export { sessionOpMarkPendingPlanExecutionDispatched as markPendingPlanExecutionDispatched };
export { sessionOpClearPendingPlanExecution as clearPendingPlanExecution };
export { sessionOpGetPendingPlanExecution as getPendingPlanExecution };
