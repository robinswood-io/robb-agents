import type { SessionEvent } from '../../../../../shared/src/protocol/dto/session-events.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import { getAdminRememberKey } from '../policy.ts';
import { randomUUID } from 'node:crypto';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { generateMessageId } from '@craft-agent/shared/protocol';
import { pendingPermissionWatchdogRemainingMs } from '../../permission-request-lifecycle';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { MAX_ADMIN_REMEMBER_MINUTES } from '../runtime-policy.ts';
import type { AgentInstance } from '../runtime-types.ts';
import { clearPermissionWait as sessionOpClearPermissionWait } from './downgrade-cold-auth-resume-permission.ts';
import { deniedPermissionToolUseIds as sessionOpDeniedPermissionToolUseIds } from './message-authority.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';

function sessionOpStoreAdminRememberApproval(sessionOperationContext: SessionOperationContext, sessionId: string, commandHash: string, sourceRequestId: string, rememberForMinutes: number): void {
    const boundedMinutes = Math.min(Math.max(Math.floor(rememberForMinutes), 1), MAX_ADMIN_REMEMBER_MINUTES);
    const now = Date.now();
    const expiresAt = now + boundedMinutes * 60 * 1000;
    sessionOperationContext.state.adminRememberApprovals.set(getAdminRememberKey(sessionId, commandHash), {
        createdAt: now,
        expiresAt,
        sourceRequestId,
    });
    sessionOperationContext.state.privilegedExecutionBroker.auditEvent('privileged_remember_window_stored', {
        sessionId,
        commandHash,
        sourceRequestId,
        rememberForMinutes: boundedMinutes,
        createdAt: now,
        expiresAt,
    });
}

function sessionOpClearAdminRememberApprovalsForSession(sessionOperationContext: SessionOperationContext, sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of sessionOperationContext.state.adminRememberApprovals.keys()) {
        if (key.startsWith(prefix)) {
            sessionOperationContext.state.adminRememberApprovals.delete(key);
        }
    }
}

function sessionOpClearPendingPermissionRequestsForSession(sessionOperationContext: SessionOperationContext, sessionId: string): void {
    for (const [requestId, metadata] of sessionOperationContext.state.pendingPermissionRequests.entries()) {
        if (metadata.sessionId === sessionId) {
            clearTimeout(metadata.timeout);
            sessionOperationContext.state.pendingPermissionRequests.delete(requestId);
            sessionOpRejectPendingPrivilegedApproval(sessionOperationContext, requestId, metadata);
            // Resolve the provider-side Promise before discarding host metadata so
            // session deletion/runtime disposal cannot leave an agent hung forever.
            sessionOpDenyPermissionOnRecordedRuntime(sessionOperationContext, requestId, metadata);
        }
    }
}

function sessionOpRejectPendingPrivilegedApproval(sessionOperationContext: SessionOperationContext, requestId: string, metadata: {
    sessionId: string;
    type?: string;
    commandHash?: string;
}): void {
    if (metadata.type !== 'admin_approval')
        return;
    const result = sessionOperationContext.state.privilegedExecutionBroker.resolveApproval(requestId, false, omitUndefined({
        expectedCommandHash: metadata.commandHash,
        expectedSessionId: metadata.sessionId,
    }));
    if (!result.ok) {
        sessionLog.warn(`Could not close privileged approval ${requestId}: ${result.reason}`);
    }
}

function sessionOpDenyPermissionOnRecordedRuntime(sessionOperationContext: SessionOperationContext, requestId: string, metadata: {
    sessionId: string;
    runtimeAgent?: AgentInstance | undefined;
}): void {
    const runtimeAgent = metadata.runtimeAgent ?? sessionOperationContext.state.sessions.get(metadata.sessionId)?.agent;
    try {
        runtimeAgent?.respondToPermission(requestId, false, false);
    }
    catch (error) {
        sessionLog.warn('Could not deny provider permission request', {
            sessionId: metadata.sessionId,
            requestId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

function sessionOpExpirePendingPermissionRequest(sessionOperationContext: SessionOperationContext, requestId: string): void {
    const metadata = sessionOperationContext.state.pendingPermissionRequests.get(requestId);
    if (!metadata)
        return;
    // One expired approval closes the whole generation. Otherwise concurrent
    // requests remain unclickable behind the blocked marker and keep explicit
    // Retry disabled until their (possibly much longer) individual TTLs fire.
    // Delete the complete cohort before notifying the provider so callbacks or
    // UI clicks cannot win a partially-closed generation.
    const cohort = [...sessionOperationContext.state.pendingPermissionRequests.entries()].filter(([, candidate]) => (candidate.sessionId === metadata.sessionId
        && candidate.processingGeneration === metadata.processingGeneration));
    for (const [cohortRequestId, candidate] of cohort) {
        sessionOperationContext.state.pendingPermissionRequests.delete(cohortRequestId);
        clearTimeout(candidate.timeout);
        sessionOpRejectPendingPrivilegedApproval(sessionOperationContext, cohortRequestId, candidate);
    }
    const managed = sessionOperationContext.state.sessions.get(metadata.sessionId);
    if (!managed)
        return;
    const expiryGeneration = metadata.processingGeneration;
    const expiryObjective = managed.activeObjective;
    const terminalized = sessionOpTerminalizeExpiredPermissionWait(sessionOperationContext, managed, requestId, metadata);
    for (const [cohortRequestId, candidate] of cohort) {
        if (cohortRequestId !== requestId) {
            sessionOpTerminalizeExpiredPermissionWait(sessionOperationContext, managed, cohortRequestId, candidate);
        }
    }
    if (!terminalized)
        sessionOpClearPermissionWait(sessionOperationContext, managed, requestId);
    const deniedToolUseIds = sessionOpDeniedPermissionToolUseIds(sessionOperationContext, managed, expiryGeneration);
    for (const [, candidate] of cohort) {
        if (candidate.toolUseId)
            deniedToolUseIds.add(candidate.toolUseId);
    }
    sessionLog.warn('Permission request expired', {
        sessionId: metadata.sessionId,
        requestId,
        toolName: metadata.toolName,
        toolUseId: metadata.toolUseId,
        closedGenerationRequests: cohort.length,
    });
    for (const [cohortRequestId, candidate] of cohort) {
        sessionOperationContext.owner["emitExecutionTelemetry"](managed, {
            schemaVersion: 1,
            eventId: randomUUID(),
            timestamp: Date.now(),
            name: 'permission.resolved',
            correlation: {
                workspaceId: managed.workspace.id,
                sessionId: managed.id,
            },
            permissionKind: candidate.type ?? candidate.toolName ?? 'unknown',
            resolution: 'denied',
            durationMs: Math.max(0, Date.now() - candidate.requestedAt),
        });
        sessionOpDenyPermissionOnRecordedRuntime(sessionOperationContext, cohortRequestId, candidate);
    }
    if (terminalized) {
        void sessionOpFinishExpiredPermissionWait(sessionOperationContext, managed, expiryGeneration, expiryObjective).catch((error: unknown) => {
            sessionLog.warn('Expired permission terminal handoff failed', {
                sessionId: managed.id,
                requestId,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }
    sessionOperationContext.owner["sendEvent"]({
        type: 'info',
        sessionId: metadata.sessionId,
        message: 'The authorization request expired. The action was not executed, and the task is blocked until you explicitly retry it.',
        level: 'warning',
        timestamp: sessionOpMonotonic(sessionOperationContext),
    }, managed.workspace.id);
}

/** Permission expiry is a human handoff, not a transport failure. Publish the
 * denied pre-execution receipt and stop the generation before the watchdog
 * can allocate an automatic retry of the same mutation. */
function sessionOpMarkPermissionToolNotExecuted(sessionOperationContext: SessionOperationContext, managed: ManagedSession, metadata: {
    toolName?: string | undefined;
    toolUseId?: string | undefined;
}): boolean {
    if (!metadata.toolUseId)
        return false;
    let toolMessage = managed.messages.find(message => (message.role === 'tool' && message.toolUseId === metadata.toolUseId));
    // Pi can request permission before its asynchronously formatted tool_start
    // reaches the host. Materialize the host-observed denial now so a crash or
    // a delayed start cannot leave an unaccounted external-effect boundary.
    if (!toolMessage) {
        toolMessage = {
            id: generateMessageId(),
            role: 'tool',
            content: `Running ${metadata.toolName ?? 'unknown'}...`,
            timestamp: sessionOpMonotonic(sessionOperationContext),
            toolName: metadata.toolName ?? 'unknown',
            toolUseId: metadata.toolUseId,
            toolStatus: 'executing',
        };
        managed.messages.push(toolMessage);
    }
    if (toolMessage?.toolStatus !== 'executing' || toolMessage.toolResult !== undefined)
        return false;
    toolMessage.toolStatus = 'error';
    toolMessage.toolResult = 'Authorization closed before execution. The action was not executed.';
    toolMessage.toolExecuted = false;
    toolMessage.isError = true;
    try {
        sessionOperationContext.owner["sendEvent"](omitUndefined<Extract<SessionEvent, { type: 'tool_result' }>>({
            type: 'tool_result',
            sessionId: managed.id,
            toolUseId: metadata.toolUseId,
            toolName: toolMessage.toolName ?? metadata.toolName ?? 'unknown',
            result: toolMessage.toolResult,
            turnId: toolMessage.turnId,
            parentToolUseId: toolMessage.parentToolUseId,
            isError: true,
            executed: false,
            timestamp: toolMessage.timestamp,
        }), managed.workspace.id);
    }
    catch (error) {
        // Renderer delivery is best-effort. It must never strand the provider or
        // prevent the stronger non-execution fact from reaching durable storage.
        sessionLog.warn('Could not publish denied permission receipt', {
            sessionId: managed.id,
            toolUseId: metadata.toolUseId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
    return true;
}

/** Record a live denial before releasing the provider-side permission wait.
 * The provider can emit its tool result and final response asynchronously, or
 * be torn down before either event reaches the host. Persisting the exact
 * non-execution fact first prevents a later retry from treating the missing
 * provider receipt as an ambiguous external effect. */
async function sessionOpRecordDeniedPermissionBeforeProviderResume(sessionOperationContext: SessionOperationContext, managed: ManagedSession, metadata: {
    toolName?: string | undefined;
    toolUseId?: string | undefined;
    processingGeneration: number;
}): Promise<void> {
    if (!metadata.toolUseId)
        return;
    sessionOpDeniedPermissionToolUseIds(sessionOperationContext, managed, metadata.processingGeneration).add(metadata.toolUseId);
    if (!sessionOpMarkPermissionToolNotExecuted(sessionOperationContext, managed, metadata))
        return;
    try {
        sessionOperationContext.owner["persistSession"](managed);
    }
    catch (error) {
        sessionLog.warn('Failed to enqueue denied permission receipt', {
            sessionId: managed.id,
            toolUseId: metadata.toolUseId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
    try {
        await sessionOperationContext.owner.flushSession(managed.id);
    }
    catch (error) {
        sessionLog.warn('Failed to flush denied permission receipt', {
            sessionId: managed.id,
            toolUseId: metadata.toolUseId,
            error: error instanceof Error ? error.message : String(error),
        });
        // A failed queue write consumes its pending snapshot. Re-enqueue the
        // now-final non-execution state so a later/background shutdown flush can
        // retry it instead of durably reviving an `executing` tool row.
        try {
            sessionOperationContext.owner["persistSession"](managed);
        }
        catch (persistError) {
            sessionLog.warn('Failed to re-enqueue denied permission receipt', {
                sessionId: managed.id,
                toolUseId: metadata.toolUseId,
                error: persistError instanceof Error ? persistError.message : String(persistError),
            });
        }
    }
}

function sessionOpDenyPermissionRequestDuringShutdown(sessionOperationContext: SessionOperationContext, managed: ManagedSession, request: {
    requestId: string;
    toolName?: string;
    toolUseId?: string;
}, runtimeAgent?: AgentInstance): void {
    const metadata = {
        toolName: request.toolName,
        toolUseId: request.toolUseId,
        processingGeneration: runtimeAgent
            ? sessionOperationContext.state.runtimeProcessingGenerations.get(runtimeAgent) ?? managed.processingGeneration
            : managed.processingGeneration,
    };
    // Register the denied tool synchronously before the first await, then make
    // the receipt durable before releasing the provider-side permission wait.
    void sessionOpRecordDeniedPermissionBeforeProviderResume(sessionOperationContext, managed, metadata)
        .catch((error: unknown) => {
        sessionLog.warn('Could not record shutdown permission denial', {
            sessionId: managed.id,
            requestId: request.requestId,
            toolUseId: request.toolUseId,
            error: error instanceof Error ? error.message : String(error),
        });
    })
        .finally(() => {
        try {
            runtimeAgent?.respondToPermission(request.requestId, false, false);
        }
        catch (error) {
            sessionLog.warn('Could not deny provider permission request during shutdown', {
                sessionId: managed.id,
                requestId: request.requestId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}

function sessionOpTerminalizeExpiredPermissionWait(sessionOperationContext: SessionOperationContext, managed: ManagedSession, requestId: string, metadata: {
    toolName?: string;
    toolUseId?: string;
    processingGeneration: number;
    objectiveId?: string;
    runtimeAgent?: AgentInstance | undefined;
    requestedAt: number;
}): boolean {
    const pending = managed.pendingTurnRecovery;
    const waiting = pending?.waitingForPermission;
    const exactWaiting = waiting?.requestId === requestId ? waiting : undefined;
    const toolUseId = metadata.toolUseId ?? exactWaiting?.toolUseId;
    const receiptChanged = sessionOpMarkPermissionToolNotExecuted(sessionOperationContext, managed, {
        ...(metadata.toolName !== undefined ? { toolName: metadata.toolName } : {}),
        ...(toolUseId !== undefined ? { toolUseId: toolUseId } : {}),
    });
    const objective = managed.activeObjective;
    const objectiveId = objective?.objectiveId ?? objective?.userMessageId;
    const ownsGeneration = !!pending
        && managed.isProcessing
        && !managed.stopRequested
        && managed.processingGeneration === metadata.processingGeneration
        && !!metadata.runtimeAgent
        && managed.agent === metadata.runtimeAgent
        && objective?.terminalState === 'active'
        && (!metadata.objectiveId || metadata.objectiveId === objectiveId);
    if (!ownsGeneration || !objective) {
        if (receiptChanged)
            sessionOperationContext.owner["persistSession"](managed);
        return false;
    }
    managed.pendingTurnRecovery = {
        ...pending,
        waitingForPermission: {
            requestId,
            requestedAt: metadata.requestedAt,
            toolName: metadata.toolName ?? exactWaiting?.toolName ?? 'unknown',
            ...(toolUseId ? { toolUseId } : {}),
            recoveryRequired: true,
        },
    };
    objective.terminalState = 'blocked_human';
    objective.completedAt = Date.now();
    sessionOperationContext.state.permissionExpiryStopGenerations.set(managed, metadata.processingGeneration);
    sessionOperationContext.owner["persistSession"](managed);
    return true;
}

async function sessionOpFinishExpiredPermissionWait(sessionOperationContext: SessionOperationContext, managed: ManagedSession, generation: number, objective: ActiveSessionObjective | undefined): Promise<void> {
    const ownsExpiry = () => !sessionOperationContext.state.shuttingDown && sessionOperationContext.state.sessions.get(managed.id) === managed
        && managed.processingGeneration === generation && managed.activeObjective === objective
        && managed.activeObjective?.terminalState === 'blocked_human';
    if (!ownsExpiry())
        return;
    await sessionOperationContext.owner["onProcessingStopped"](managed.id, 'error', generation, true);
}

function sessionOpPendingPermissionWatchdogRemainingMs(sessionOperationContext: SessionOperationContext, sessionId: string): number | undefined {
    const remaining = [...sessionOperationContext.state.pendingPermissionRequests.values()]
        .filter(request => request.sessionId === sessionId)
        .map(request => pendingPermissionWatchdogRemainingMs(request.expiresAt));
    return remaining.length ? Math.max(...remaining) : undefined;
}

/**
 * Manually notify the ConfigWatcher of a file change.
 * Workaround for Bun's fs.watch on Linux not detecting atomic renames.
 */
function sessionOpNotifyConfigFileChange(sessionOperationContext: SessionOperationContext, workspaceRootPath: string, relativePath: string): void {
    const watcher = sessionOperationContext.state.configWatchers.get(workspaceRootPath);
    watcher?.notifyFileChange(relativePath);
}

export { sessionOpStoreAdminRememberApproval as storeAdminRememberApproval };
export { sessionOpClearAdminRememberApprovalsForSession as clearAdminRememberApprovalsForSession };
export { sessionOpClearPendingPermissionRequestsForSession as clearPendingPermissionRequestsForSession };
export { sessionOpRejectPendingPrivilegedApproval as rejectPendingPrivilegedApproval };
export { sessionOpDenyPermissionOnRecordedRuntime as denyPermissionOnRecordedRuntime };
export { sessionOpExpirePendingPermissionRequest as expirePendingPermissionRequest };
export { sessionOpMarkPermissionToolNotExecuted as markPermissionToolNotExecuted };
export { sessionOpRecordDeniedPermissionBeforeProviderResume as recordDeniedPermissionBeforeProviderResume };
export { sessionOpDenyPermissionRequestDuringShutdown as denyPermissionRequestDuringShutdown };
export { sessionOpTerminalizeExpiredPermissionWait as terminalizeExpiredPermissionWait };
export { sessionOpFinishExpiredPermissionWait as finishExpiredPermissionWait };
export { sessionOpPendingPermissionWatchdogRemainingMs as pendingPermissionWatchdogRemainingMs };
export { sessionOpNotifyConfigFileChange as notifyConfigFileChange };
