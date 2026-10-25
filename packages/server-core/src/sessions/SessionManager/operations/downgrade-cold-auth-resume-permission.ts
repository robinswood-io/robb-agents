import type { SessionOperationContext } from '../operation-context.ts';
import { setPermissionMode, getPermissionModeDiagnostics } from '@craft-agent/shared/agent';
import type { PermissionMode } from '@craft-agent/shared/agent';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';

/** A normal chat message is an explicit decision to continue the conversation,
 * not an approval of the paused authentication request. Close that obsolete
 * handoff fail-closed so the durable human FIFO can own the next generation. */
function sessionOpCancelPendingAuthForHumanContinuation(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    const pendingMessages = managed.messages.filter(message => (message.role === 'auth-request' && message.authStatus === 'pending'));
    const requestId = managed.pendingAuthRequestId
        ?? managed.pendingAuthRequest?.requestId
        ?? pendingMessages.at(-1)?.authRequestId;
    if (!requestId && !managed.pendingAuthRequest && pendingMessages.length === 0)
        return false;
    for (const message of pendingMessages)
        message.authStatus = 'cancelled';
    if (requestId)
        sessionOperationContext.state.oauthResponsesInFlight.delete(`${managed.id}\u0000${requestId}`);
    managed.pendingAuthRequestId = undefined;
    managed.pendingAuthRequest = undefined;
    if (requestId) {
        sessionOperationContext.owner["sendEvent"]({
            type: 'auth_completed',
            sessionId: managed.id,
            requestId,
            success: false,
            cancelled: true,
        }, managed.workspace.id);
    }
    sessionLog.info('Cancelled obsolete authentication handoff for human continuation', {
        sessionId: managed.id,
        requestId,
    });
    return true;
}

/** A cold restart must not inherit unattended mutation authority across an
 * obsolete auth handoff. Keep the accepted human continuation automatic, but
 * require fresh approval for any external mutation it reaches. */
function sessionOpDowngradeColdAuthResumePermission(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    if (managed.permissionMode !== 'allow-all')
        return false;
    const diagnosticsBefore = getPermissionModeDiagnostics(managed.id);
    // Never relax a stricter authoritative state if metadata and the mode
    // manager somehow drifted during startup.
    const permissionMode: PermissionMode = diagnosticsBefore.permissionMode === 'safe' ? 'safe' : 'ask';
    managed.permissionMode = permissionMode;
    if (diagnosticsBefore.permissionMode === 'allow-all') {
        setPermissionMode(managed.id, 'ask', { changedBy: 'system' });
    }
    const diagnostics = getPermissionModeDiagnostics(managed.id);
    managed.previousPermissionMode = diagnostics.previousPermissionMode;
    managed.agent?.setPermissionMode(permissionMode);
    sessionOperationContext.owner["sendEvent"]({
        type: 'permission_mode_changed',
        sessionId: managed.id,
        permissionMode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
        changedAt: diagnostics.lastChangedAt,
        previousPermissionMode: diagnostics.previousPermissionMode,
        transitionDisplay: diagnostics.transitionDisplay,
    }, managed.workspace.id);
    sessionLog.warn('Downgraded cold auth continuation permission before generation', {
        sessionId: managed.id,
        previousPermissionMode: 'allow-all',
        permissionMode,
    });
    return true;
}

function sessionOpClearPermissionWait(sessionOperationContext: SessionOperationContext, managed: ManagedSession, requestId: string): void {
    if (!sessionOperationContext.state.shuttingDown && managed.pendingTurnRecovery?.waitingForPermission?.requestId === requestId) {
        managed.pendingTurnRecovery = { ...managed.pendingTurnRecovery, waitingForPermission: undefined };
        sessionOperationContext.owner["persistSession"](managed);
        sessionOperationContext.owner["scheduleDeferredAutomaticSessions"]();
    }
}

export { sessionOpCancelPendingAuthForHumanContinuation as cancelPendingAuthForHumanContinuation };
export { sessionOpDowngradeColdAuthResumePermission as downgradeColdAuthResumePermission };
export { sessionOpClearPermissionWait as clearPermissionWait };
