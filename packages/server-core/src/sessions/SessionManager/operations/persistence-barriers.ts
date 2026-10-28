import type { SessionOperationContext } from '../operation-context.ts';
import { persistenceRootFor } from '../policy.ts';
import type { AuthRequest } from '@craft-agent/shared/agent';
import { sessionPersistenceQueue, pickSessionFields } from '@craft-agent/shared/sessions';
import type { StoredSession } from '@craft-agent/shared/sessions';
import type { FileAttachment, SendMessageOptions } from '@craft-agent/shared/protocol';
import { messageToStored } from '@craft-agent/core/types';
import type { StoredAttachment } from '@craft-agent/core/types';
import { getPlatformSessionAppProvenance } from '../../session-app-provenance';
import type { ManagedSession } from '../managed-session.ts';
import { _platform, sessionLog } from '../runtime-platform.ts';
import { DEFAULT_TOKEN_USAGE } from '../session-presentation.ts';
import { sourceActivationObjectiveBinding } from '../source-activation.ts';
import { sessionSourceSlugsForPersistence } from '../source-selection.ts';

// Build the StoredSession snapshot and hand it to the persistence queue.
// Caller must ensure `managed.messagesLoaded` is true.
function sessionOpEnqueuePersist(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    if (sessionOperationContext.state.retiringSessions.has(managed))
        return false;
    try {
        // Filter out transient status messages (progress indicators like "Compacting...")
        // Error messages are now persisted with rich fields for diagnostics
        const persistableMessages = managed.messages.filter(m => m.role !== 'status');
        const currentApp = getPlatformSessionAppProvenance(_platform);
        if (currentApp)
            managed.lastUsedByApp = currentApp;
        managed.pendingQueuedMessageIds = managed.messages.filter(m => m.role === 'user' && m.isQueued).map(m => m.id);
        managed.pendingAgentDeliveryIds = managed.messages
            .filter(m => (m.agentDelivery
            ? m.isQueued || m.agentDelivery.status === 'processing'
            : m.isQueued && m.internalOrigin?.kind === 'user-input'))
            .map(m => m.id);
        const persistentFields = pickSessionFields(managed);
        const persistedSourceSlugs = sessionSourceSlugsForPersistence(managed);
        if (persistedSourceSlugs === undefined) {
            // The effective list is runtime state. Keeping the header absent makes
            // a later workspace-default edit take effect after this unrelated save.
            delete persistentFields.enabledSourceSlugs;
        }
        else {
            persistentFields.enabledSourceSlugs = persistedSourceSlugs;
        }
        const storedSession: StoredSession = {
            ...persistentFields,
            workspaceRootPath: managed.workspace.rootPath,
            createdAt: managed.createdAt ?? Date.now(),
            lastUsedAt: Date.now(),
            messages: persistableMessages.map(messageToStored),
            tokenUsage: managed.tokenUsage ?? DEFAULT_TOKEN_USAGE,
        } as StoredSession;
        // Queue for async persistence with debouncing
        sessionPersistenceQueue.enqueue(storedSession, persistenceRootFor(managed), managed.persistenceRootIdentity);
        sessionOperationContext.state.sessionPersistenceEpochs.set(managed, (sessionOperationContext.state.sessionPersistenceEpochs.get(managed) ?? 0) + 1);
        return true;
    }
    catch (error) {
        sessionLog.error(`Failed to queue session ${managed.id} for persistence:`, error);
        return false;
    }
}

// Flush a specific session immediately (call on session close/switch).
// Cold-persist hydration is synchronous, so by the time we reach here the
// queue already has an entry whenever persistSession was just called.
async function sessionOpFlushSession(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        return;
    await sessionPersistenceQueue.flush(sessionId, persistenceRootFor(managed));
}

/** Power-loss durability barrier reserved for exact provider dispatch state. */
async function sessionOpFlushSessionDurably(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        throw new Error(`Cannot durably flush unknown session: ${sessionId}`);
    await sessionPersistenceQueue.flushDurable(sessionId, persistenceRootFor(managed));
}

/** Persist callback-owned identity changes without leaking a rejected promise. */
function sessionOpFlushSessionPersistenceInBackground(_sessionOperationContext: SessionOperationContext, managed: ManagedSession, reason: string): void {
    let persistenceRootPath: string;
    try {
        persistenceRootPath = persistenceRootFor(managed);
    }
    catch (error) {
        sessionLog.error(`Failed to resolve session ${managed.id} persistence root after ${reason}:`, error);
        return;
    }
    void sessionPersistenceQueue.flush(managed.id, persistenceRootPath).catch((error: unknown) => {
        sessionLog.error(`Failed to flush session ${managed.id} after ${reason}:`, error);
    });
}

// Flush all pending sessions (call on app quit).
async function sessionOpFlushAllSessions(_sessionOperationContext: SessionOperationContext): Promise<void> {
    await sessionPersistenceQueue.flushAll();
}

function sessionOpSendAuthenticatedInternalContinuation(sessionOperationContext: SessionOperationContext, managed: ManagedSession, message: string, kind: 'auth-result' | 'auth-retry', token: symbol, input?: {
    attachments?: FileAttachment[];
    storedAttachments?: StoredAttachment[];
    options?: SendMessageOptions;
    existingMessageId?: string;
    isAuthRetry?: boolean;
}): Promise<void> {
    const binding = sourceActivationObjectiveBinding(managed.activeObjective);
    return sessionOperationContext.owner.sendMessage(managed.id, message, input?.attachments, input?.storedAttachments, {
        ...input?.options,
        hidden: true,
        internalOrigin: {
            kind,
            ...(binding ?? {}),
        },
    }, input?.existingMessageId, input?.isAuthRetry, undefined, undefined, undefined, undefined, undefined, undefined, undefined, token);
}

function sessionOpIsExactPendingAuthRequest(sessionOperationContext: SessionOperationContext, managed: ManagedSession, request: AuthRequest): boolean {
    return !sessionOperationContext.state.shuttingDown
        && sessionOperationContext.state.sessions.get(managed.id) === managed
        && request.sessionId === managed.id
        && managed.pendingAuthRequestId === request.requestId
        && managed.pendingAuthRequest === request;
}

export { sessionOpEnqueuePersist as enqueuePersist };
export { sessionOpFlushSession as flushSession };
export { sessionOpFlushSessionDurably as flushSessionDurably };
export { sessionOpFlushSessionPersistenceInBackground as flushSessionPersistenceInBackground };
export { sessionOpFlushAllSessions as flushAllSessions };
export { sessionOpSendAuthenticatedInternalContinuation as sendAuthenticatedInternalContinuation };
export { sessionOpIsExactPendingAuthRequest as isExactPendingAuthRequest };
