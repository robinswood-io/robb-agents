import type { SessionEvent } from '../../../../../shared/src/protocol/dto/session-events.ts';
import {setOptional, omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import { queuedDirectHumanContinuationIndex, persistenceRootFor, formatAuthResultMessage, ordinaryMissionSourceBuildOptions } from '../policy.ts';
import { basename } from 'path';
import type { AuthRequest, AuthResult, CredentialAuthRequest } from '@craft-agent/shared/agent';
import { getSessionPath as getSessionStoragePath } from '@craft-agent/shared/sessions';
import { loadAllSources, isSourceUsable } from '@craft-agent/shared/sources';
import { getCredentialManager } from '@craft-agent/shared/credentials';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { InternalContinuationSupersededError } from '../runtime-policy.ts';
import { sourceActivationObjectiveBinding } from '../source-activation.ts';
import { buildServersFromSources } from '../source-build.ts';
import { isExactPendingAuthRequest as sessionOpIsExactPendingAuthRequest } from './persistence-barriers.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation } from './track-session-operation.ts';
import { getCollectionSummarizer as sessionOpGetCollectionSummarizer } from './try-refresh-agent-runtime.ts';
import { mintAuthenticatedInternalContinuation as sessionOpMintAuthenticatedInternalContinuation } from './message-authority.ts';
import { hasPendingDecision as sessionOpHasPendingDecision } from './repair-legacy-synthetic-objective-authority.ts';

/** Validate the current server-owned OAuth capability without exposing its
 * contents. OAuth handlers call this on both sides of their async boundaries. */
function sessionOpIsPendingOAuthRequest(sessionOperationContext: SessionOperationContext, sessionId: string, requestId: string, sourceSlug: string, workspaceId: string): boolean {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    const request = managed?.pendingAuthRequest;
    const operationKey = `${sessionId}\u0000${requestId}`;
    let claim = sessionOperationContext.state.oauthResponsesInFlight.get(operationKey);
    if (claim && claim.expiresAt <= Date.now()) {
        sessionOperationContext.state.oauthResponsesInFlight.delete(operationKey);
        claim = undefined;
    }
    return !!managed && managed.workspace.id === workspaceId
        && !!request && request.type !== 'credential'
        && request.requestId === requestId && request.sourceSlug === sourceSlug
        && (!claim || claim.request === request)
        && sessionOpIsExactPendingAuthRequest(sessionOperationContext, managed, request);
}

function sessionOpClaimPendingOAuthRequest(sessionOperationContext: SessionOperationContext, sessionId: string, requestId: string, sourceSlug: string, workspaceId: string, flowId: string, expiresAt = Date.now() + 5 * 60 * 1000): boolean {
    if (!sessionOperationContext.owner.isPendingOAuthRequest(sessionId, requestId, sourceSlug, workspaceId))
        return false;
    const operationKey = `${sessionId}\u0000${requestId}`;
    const existing = sessionOperationContext.state.oauthResponsesInFlight.get(operationKey);
    if (existing) {
        const ownsClaim = existing.flowId === flowId
            && existing.request === sessionOperationContext.state.sessions.get(sessionId)?.pendingAuthRequest;
        if (ownsClaim)
            existing.expiresAt = Math.max(existing.expiresAt, expiresAt);
        return ownsClaim;
    }
    sessionOperationContext.state.oauthResponsesInFlight.set(operationKey, {
        request: sessionOperationContext.state.sessions.get(sessionId)!.pendingAuthRequest!,
        flowId,
        expiresAt,
    });
    return true;
}

function sessionOpReleasePendingOAuthRequest(sessionOperationContext: SessionOperationContext, sessionId: string, requestId: string, flowId: string): void {
    const operationKey = `${sessionId}\u0000${requestId}`;
    if (sessionOperationContext.state.oauthResponsesInFlight.get(operationKey)?.flowId === flowId) {
        sessionOperationContext.state.oauthResponsesInFlight.delete(operationKey);
    }
}

/**
 * Complete only the currently pending auth capability. The pending state is
 * consumed synchronously before the first await, making completion one-shot
 * against duplicate callbacks and concurrent human continuation.
 */
function sessionOpCompleteAuthRequestIfCurrent(sessionOperationContext: SessionOperationContext, sessionId: string, result: AuthResult, expectedRequest?: AuthRequest): Promise<boolean> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        sessionLog.warn(`Cannot complete auth request - session ${sessionId} not found`);
        return Promise.resolve(false);
    }
    // Auth completion can rebuild bridge configuration and dispatch a hidden
    // continuation. Treat that whole sequence as one session-owned operation
    // so deletion drains it before moving the session directory.
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpPerformCompleteAuthRequestIfCurrent(sessionOperationContext, managed, sessionId, result, expectedRequest));
}

async function sessionOpPerformCompleteAuthRequestIfCurrent(sessionOperationContext: SessionOperationContext, managed: ManagedSession, sessionId: string, result: AuthResult, expectedRequest?: AuthRequest): Promise<boolean> {
    const ownsSession = (): boolean => !sessionOperationContext.state.shuttingDown
        && !sessionOperationContext.state.retiringSessions.has(managed)
        && sessionOperationContext.state.sessions.get(sessionId) === managed;
    const pendingRequest = managed.pendingAuthRequest;
    if (!ownsSession()
        || managed.pendingAuthRequestId !== result.requestId
        || pendingRequest?.requestId !== result.requestId
        || pendingRequest.sessionId !== sessionId
        || pendingRequest.sourceSlug !== result.sourceSlug
        || (expectedRequest === undefined && pendingRequest.type === 'credential')
        || (expectedRequest !== undefined && pendingRequest !== expectedRequest)) {
        sessionLog.warn('Ignored stale auth completion', {
            sessionId,
            requestId: result.requestId,
            pendingRequestId: managed.pendingAuthRequestId,
        });
        return false;
    }
    const objectiveAtCompletion = managed.activeObjective;
    const objectiveBindingAtCompletion = sourceActivationObjectiveBinding(objectiveAtCompletion);
    const authorityEpochAtCompletion = sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0;
    // Consume the exact capability before any async work. Neither a repeated UI
    // submit nor an obsolete OAuth callback may complete a later request.
    sessionOperationContext.state.oauthResponsesInFlight.delete(`${sessionId}\u0000${result.requestId}`);
    managed.pendingAuthRequestId = undefined;
    managed.pendingAuthRequest = undefined;
    // Find and update the pending auth-request message
    const authMessage = managed.messages.find(m => m.role === 'auth-request' &&
        m.authRequestId === result.requestId &&
        m.authStatus === 'pending');
    if (authMessage) {
        authMessage.authStatus = result.success ? 'completed' :
            result.cancelled ? 'cancelled' : 'failed';
        setOptional(authMessage, "authError", result.error);
        setOptional(authMessage, "authEmail", result.email);
        setOptional(authMessage, "authWorkspace", result.workspace);
    }
    // Emit auth_completed event to update UI
    sessionOperationContext.owner["sendEvent"](omitUndefined<Extract<SessionEvent, { type: 'auth_completed' }>>({
        type: 'auth_completed',
        sessionId,
        requestId: result.requestId,
        success: result.success,
        cancelled: result.cancelled,
        error: result.error,
    }), managed.workspace.id);
    // Create faked user message with result
    const resultContent = formatAuthResultMessage(result);
    // Auto-enable the source in the session after successful auth
    if (result.success && result.sourceSlug) {
        const slugSet = new Set(managed.enabledSourceSlugs || []);
        if (!slugSet.has(result.sourceSlug)) {
            slugSet.add(result.sourceSlug);
            managed.enabledSourceSlugs = Array.from(slugSet);
            managed.inheritsWorkspaceSourceSlugs = false;
            sessionLog.info(`Auto-enabled source ${result.sourceSlug} in session ${sessionId} after auth`);
        }
        // Clear any refresh cooldown so the source is immediately usable
        managed.tokenRefreshManager.clearCooldown(result.sourceSlug);
    }
    // Persist session with updated auth message and enabled sources
    sessionOperationContext.owner["persistSession"](managed);
    const refreshAgent = managed.agent;
    if (result.success && result.sourceSlug && refreshAgent && ownsSession()) {
        const workspaceRootPath = managed.workspace.rootPath;
        const sessionPath = getSessionStoragePath(persistenceRootFor(managed), managed.id);
        const enabledSlugs = managed.enabledSourceSlugs || [];
        const allSources = loadAllSources(workspaceRootPath);
        const enabledSources = allSources.filter(s => enabledSlugs.includes(s.config.slug) && isSourceUsable(s));
        try {
            await buildServersFromSources(enabledSources, sessionPath, managed.tokenRefreshManager, sessionOpGetCollectionSummarizer(sessionOperationContext, managed), managed.missionCapabilityLock ? () => sessionOperationContext.owner["assertSpecializedMissionCapabilities"](managed) : undefined, managed.missionCapabilityLock, ordinaryMissionSourceBuildOptions(managed));
            if (ownsSession() && managed.agent === refreshAgent) {
            }
            else {
                sessionLog.info('Skipped source bridge refresh for a retired auth session', {
                    sessionId,
                    requestId: result.requestId,
                });
            }
        }
        catch (error) {
            // Auth has already been accepted. A bridge refresh failure must not
            // strand the conversation or make a retry consume the capability twice.
            sessionLog.warn(`Failed to refresh source bridge after auth for ${result.sourceSlug}:`, error);
        }
    }
    // Deletion may detach the session while bridge preparation is awaiting.
    // The deletion barrier still waits for this operation, but no runtime or
    // scheduler mutation may be applied to the detached object.
    if (!ownsSession()) {
        sessionLog.info('Auth result completed without resuming a deleted session', {
            sessionId,
            requestId: result.requestId,
        });
        return true;
    }
    // Send the result as a new message to resume conversation
    // Use empty arrays for attachments since this is a system-generated message
    const currentBinding = sourceActivationObjectiveBinding(managed.activeObjective);
    const sameObjectiveRevision = objectiveBindingAtCompletion === undefined
        ? currentBinding === undefined
        : !!currentBinding
            && currentBinding.objectiveId === objectiveBindingAtCompletion.objectiveId
            && currentBinding.objectiveRevision === objectiveBindingAtCompletion.objectiveRevision;
    try {
        if (ownsSession()
            && managed.activeObjective === objectiveAtCompletion
            && sameObjectiveRevision
            && (sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0) === authorityEpochAtCompletion
            && queuedDirectHumanContinuationIndex(managed) < 0) {
            const continuationToken = sessionOpMintAuthenticatedInternalContinuation(sessionOperationContext, managed, 'auth-result');
            if (continuationToken) {
                try {
                    await sessionOperationContext.owner.sendAuthenticatedInternalContinuation(managed, resultContent, 'auth-result', continuationToken);
                }
                catch (error) {
                    if (!(error instanceof InternalContinuationSupersededError))
                        throw error;
                    sessionLog.info('Auth result persisted without injecting a continuation into the newer objective', {
                        sessionId,
                        requestId: result.requestId,
                    });
                }
            }
        }
        else {
            sessionLog.info('Auth result persisted without resuming a superseded objective', {
                sessionId,
                requestId: result.requestId,
            });
        }
    }
    finally {
        // Bridge/provider preparation can still fail after the auth receipt is
        // durable. Retain and wake the exact objective without waiting for an
        // unrelated UI, parent, or sibling event.
        if (ownsSession() && managed.activeObjective?.terminalState === 'active'
            && managed.pendingTurnRecovery && !managed.isProcessing
            && !sessionOpHasPendingDecision(sessionOperationContext, managed) && !sessionOperationContext.owner["hasPendingUserInput"](managed)) {
            sessionOperationContext.state.deferredAutomaticSessions.add(managed.id);
            // The authenticated continuation can fail before sendMessage reaches
            // its own durable append boundary (runtime setup, bridge refresh,
            // provider construction). Persist the retained recovery before its
            // scheduler wake so a process exit cannot turn that wake into a lost
            // child objective and let the parent appear complete.
            sessionOperationContext.owner["persistSession"](managed);
            try {
                await sessionOperationContext.owner.flushSession(managed.id);
            }
            catch (error) {
                sessionLog.warn('Failed to flush retained auth recovery before scheduling', {
                    sessionId: managed.id,
                    requestId: result.requestId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        if (ownsSession())
            sessionOperationContext.owner["scheduleDeferredAutomaticSessions"]();
    }
    sessionLog.info(`Auth request completed for ${result.sourceSlug}: ${result.success ? 'success' : 'failed'}`);
    return true;
}

/**
 * Complete an auth request and send result back to agent.
 * Stale or duplicate completions are ignored fail-closed.
 */
async function sessionOpCompleteAuthRequest(sessionOperationContext: SessionOperationContext, sessionId: string, result: AuthResult): Promise<void> {
    await sessionOpCompleteAuthRequestIfCurrent(sessionOperationContext, sessionId, result);
}

/**
 * Handle credential input from the UI (for non-OAuth auth)
 * Called when user submits credentials via the inline form
 */
async function sessionOpHandleCredentialInput(sessionOperationContext: SessionOperationContext, sessionId: string, requestId: string, response: import('@craft-agent/shared/protocol').CredentialResponse, expectedRequest?: CredentialAuthRequest): Promise<boolean> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed?.pendingAuthRequest) {
        sessionLog.warn(`Cannot handle credential input - no pending auth request for session ${sessionId}`);
        return false;
    }
    const request = managed.pendingAuthRequest;
    if (request.type !== 'credential'
        || request.requestId !== requestId
        || (expectedRequest !== undefined && request !== expectedRequest)
        || !sessionOpIsExactPendingAuthRequest(sessionOperationContext, managed, request)) {
        sessionLog.warn(`Credential request ID mismatch: expected ${request.requestId}, got ${requestId}`);
        return false;
    }
    if (managed.missionCapabilityLock) {
        sessionLog.warn(`Rejected credential mutation for specialized Mission source ${request.sourceSlug}`);
        return false;
    }
    if (response.cancelled) {
        return sessionOpCompleteAuthRequestIfCurrent(sessionOperationContext, sessionId, {
            requestId,
            sourceSlug: request.sourceSlug,
            success: false,
            cancelled: true,
        }, request);
    }
    try {
        // Store credentials using existing workspace ID extraction pattern
        const credManager = getCredentialManager();
        // Extract workspace ID from root path (last segment of path)
        const wsId = basename(managed.workspace.rootPath) || managed.workspace.id;
        if (request.mode === 'basic') {
            // Store value as JSON string {username, password} - credential-manager.ts parses it for basic auth
            await credManager.set({ type: 'source_basic', workspaceId: wsId, sourceId: request.sourceSlug }, { value: JSON.stringify({ username: response.username, password: response.password }) });
        }
        else if (request.mode === 'bearer') {
            await credManager.set({ type: 'source_bearer', workspaceId: wsId, sourceId: request.sourceSlug }, { value: response.value! });
        }
        else if (request.mode === 'multi-header') {
            // Store multi-header credentials as JSON { "DD-API-KEY": "...", "DD-APPLICATION-KEY": "..." }
            await credManager.set({ type: 'source_apikey', workspaceId: wsId, sourceId: request.sourceSlug }, { value: JSON.stringify(response.headers) });
        }
        else {
            // header or query - both use API key storage
            await credManager.set({ type: 'source_apikey', workspaceId: wsId, sourceId: request.sourceSlug }, { value: response.value! });
        }
        if (!sessionOpIsExactPendingAuthRequest(sessionOperationContext, managed, request)) {
            sessionLog.info(`Credential request ${requestId} became stale while saving; skipping completion`);
            return false;
        }
        // Update source config to mark as authenticated
        const { markSourceAuthenticated } = await import('@craft-agent/shared/sources');
        if (!sessionOpIsExactPendingAuthRequest(sessionOperationContext, managed, request)) {
            sessionLog.info(`Credential request ${requestId} became stale before source activation`);
            return false;
        }
        markSourceAuthenticated(managed.workspace.rootPath, request.sourceSlug);
        // Mark source as unseen so fresh guide is injected on next message
        if (managed.agent) {
            managed.agent.markSourceUnseen(request.sourceSlug);
        }
        return sessionOpCompleteAuthRequestIfCurrent(sessionOperationContext, sessionId, {
            requestId,
            sourceSlug: request.sourceSlug,
            success: true,
        }, request);
    }
    catch (error) {
        sessionLog.error(`Failed to save credentials for ${request.sourceSlug}:`, error);
        if (!sessionOpIsExactPendingAuthRequest(sessionOperationContext, managed, request))
            return false;
        return sessionOpCompleteAuthRequestIfCurrent(sessionOperationContext, sessionId, {
            requestId,
            sourceSlug: request.sourceSlug,
            success: false,
            error: error instanceof Error ? error.message : 'Failed to save credentials',
        }, request);
    }
}

export { sessionOpIsPendingOAuthRequest as isPendingOAuthRequest };
export { sessionOpClaimPendingOAuthRequest as claimPendingOAuthRequest };
export { sessionOpReleasePendingOAuthRequest as releasePendingOAuthRequest };
export { sessionOpCompleteAuthRequestIfCurrent as completeAuthRequestIfCurrent };
export { sessionOpPerformCompleteAuthRequestIfCurrent as performCompleteAuthRequestIfCurrent };
export { sessionOpCompleteAuthRequest as completeAuthRequest };
export { sessionOpHandleCredentialInput as handleCredentialInput };
