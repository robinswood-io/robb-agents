import type { SessionOperationContext } from '../operation-context.ts';
import { persistenceRootFor } from '../policy.ts';
import { permissionModeAfterPlanApproval } from '@craft-agent/shared/agent';
import { loadSession as loadStoredSession, updateSessionMetadata } from '@craft-agent/shared/sessions';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { PLAN_APPROVAL_MESSAGE } from '../runtime-policy.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation } from './track-session-operation.ts';

/**
 * Dispatch a plan approval for a session, equivalent to the desktop
 * "Accept plan" button. Plan approval never grants blanket mutation rights:
 * Explore moves to Ask, preserving a per-operation permission boundary.
 */
async function sessionOpAcceptPlan(sessionOperationContext: SessionOperationContext, sessionId: string, _planPath?: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        sessionLog.warn(`acceptPlan: session ${sessionId} not found`);
        return;
    }
    const currentMode = managed.permissionMode ?? 'ask';
    const approvedMode = permissionModeAfterPlanApproval(currentMode);
    if (approvedMode !== currentMode) {
        sessionOperationContext.owner.setSessionPermissionMode(sessionId, approvedMode);
    }
    await sessionOperationContext.owner.sendMessage(sessionId, PLAN_APPROVAL_MESSAGE);
}

// ============================================
// Session Sharing
// ============================================
/**
 * Share session to the web viewer
 * Uploads session data and returns shareable URL
 */
async function sessionOpShareToViewer(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        return { success: false, error: 'Session not found' };
    }
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpPerformShareToViewer(sessionOperationContext, managed));
}

async function sessionOpPerformShareToViewer(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const sessionId = managed.id;
    // Signal async operation start for shimmer effect
    managed.isAsyncOperationOngoing = true;
    sessionOperationContext.owner["sendEvent"]({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id);
    try {
        // Load session directly from disk (already in correct format)
        const storedSession = loadStoredSession(persistenceRootFor(managed), sessionId);
        if (!storedSession) {
            return { success: false, error: 'Session file not found' };
        }
        const { VIEWER_URL } = await import('@craft-agent/shared/branding');
        const response = await fetch(`${VIEWER_URL}/s/api`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(storedSession)
        });
        if (!response.ok) {
            sessionLog.error(`Share failed with status ${response.status}`);
            if (response.status === 413) {
                return { success: false, error: 'Session file is too large to share' };
            }
            return { success: false, error: 'Failed to upload session' };
        }
        const data = await response.json() as {
            id: string;
            url: string;
        };
        // Store shared info in session
        managed.sharedUrl = data.url;
        managed.sharedId = data.id;
        await updateSessionMetadata(persistenceRootFor(managed), sessionId, {
            sharedUrl: data.url,
            sharedId: data.id,
        }, managed.persistenceRootIdentity);
        sessionLog.info(`Session ${sessionId} shared at ${data.url}`);
        // Notify all windows for this workspace
        sessionOperationContext.owner["sendEvent"]({ type: 'session_shared', sessionId, sharedUrl: data.url }, managed.workspace.id);
        return { success: true, url: data.url };
    }
    catch (error) {
        sessionLog.error('Share error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
    finally {
        // Signal async operation end
        managed.isAsyncOperationOngoing = false;
        sessionOperationContext.owner["sendEvent"]({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id);
    }
}

/**
 * Update an existing shared session
 * Re-uploads session data to the same URL
 */
async function sessionOpUpdateShare(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        return { success: false, error: 'Session not found' };
    }
    if (!managed.sharedId) {
        return { success: false, error: 'Session not shared' };
    }
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpPerformUpdateShare(sessionOperationContext, managed));
}

async function sessionOpPerformUpdateShare(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const sessionId = managed.id;
    // Signal async operation start for shimmer effect
    managed.isAsyncOperationOngoing = true;
    sessionOperationContext.owner["sendEvent"]({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id);
    try {
        // Load session directly from disk (already in correct format)
        const storedSession = loadStoredSession(persistenceRootFor(managed), sessionId);
        if (!storedSession) {
            return { success: false, error: 'Session file not found' };
        }
        const { VIEWER_URL } = await import('@craft-agent/shared/branding');
        const response = await fetch(`${VIEWER_URL}/s/api/${managed.sharedId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(storedSession)
        });
        if (!response.ok) {
            sessionLog.error(`Update share failed with status ${response.status}`);
            if (response.status === 413) {
                return { success: false, error: 'Session file is too large to share' };
            }
            return { success: false, error: 'Failed to update shared session' };
        }
        sessionLog.info(`Session ${sessionId} share updated at ${managed.sharedUrl}`);
        return { success: true, url: managed.sharedUrl };
    }
    catch (error) {
        sessionLog.error('Update share error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
    finally {
        // Signal async operation end
        managed.isAsyncOperationOngoing = false;
        sessionOperationContext.owner["sendEvent"]({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id);
    }
}

/**
 * Revoke a shared session
 * Deletes from viewer and clears local shared state
 */
async function sessionOpRevokeShare(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        return { success: false, error: 'Session not found' };
    }
    if (!managed.sharedId) {
        return { success: false, error: 'Session not shared' };
    }
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpPerformRevokeShare(sessionOperationContext, managed));
}

async function sessionOpPerformRevokeShare(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<import('@craft-agent/shared/protocol').ShareResult> {
    const sessionId = managed.id;
    // Signal async operation start for shimmer effect
    managed.isAsyncOperationOngoing = true;
    sessionOperationContext.owner["sendEvent"]({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id);
    try {
        const { VIEWER_URL } = await import('@craft-agent/shared/branding');
        const response = await fetch(`${VIEWER_URL}/s/api/${managed.sharedId}`, { method: 'DELETE' });
        if (!response.ok) {
            sessionLog.error(`Revoke failed with status ${response.status}`);
            return { success: false, error: 'Failed to revoke share' };
        }
        // Clear shared info
        delete managed.sharedUrl;
        delete managed.sharedId;
        await updateSessionMetadata(persistenceRootFor(managed), sessionId, {
            sharedUrl: undefined,
            sharedId: undefined,
        }, managed.persistenceRootIdentity);
        sessionLog.info(`Session ${sessionId} share revoked`);
        // Notify all windows for this workspace
        sessionOperationContext.owner["sendEvent"]({ type: 'session_unshared', sessionId }, managed.workspace.id);
        return { success: true };
    }
    catch (error) {
        sessionLog.error('Revoke error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
    finally {
        // Signal async operation end
        managed.isAsyncOperationOngoing = false;
        sessionOperationContext.owner["sendEvent"]({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id);
    }
}

export { sessionOpAcceptPlan as acceptPlan };
export { sessionOpShareToViewer as shareToViewer };
export { sessionOpPerformShareToViewer as performShareToViewer };
export { sessionOpUpdateShare as updateShare };
export { sessionOpPerformUpdateShare as performUpdateShare };
export { sessionOpRevokeShare as revokeShare };
export { sessionOpPerformRevokeShare as performRevokeShare };
