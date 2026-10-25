import type { SessionOperationContext } from '../operation-context.ts';
import { randomUUID } from 'node:crypto';
import { requirePermissionMode } from '@craft-agent/shared/agent/mode-types';
import { setPermissionMode, hydratePreviousPermissionMode, getPermissionModeDiagnostics } from '@craft-agent/shared/agent';
import type { PermissionMode } from '@craft-agent/shared/agent';
import { providerAlwaysAllowForExternalAction, rememberExternalActionAuthorization } from '../../external-action-authorization';
import { isTerminalReviewSession } from '../review-lifecycle.ts';
import { sessionLog } from '../runtime-platform.ts';
import { rejectPendingPrivilegedApproval as sessionOpRejectPendingPrivilegedApproval, markPermissionToolNotExecuted as sessionOpMarkPermissionToolNotExecuted, denyPermissionOnRecordedRuntime as sessionOpDenyPermissionOnRecordedRuntime, recordDeniedPermissionBeforeProviderResume as sessionOpRecordDeniedPermissionBeforeProviderResume, storeAdminRememberApproval as sessionOpStoreAdminRememberApproval } from './expire-pending-permission-request.ts';
import { clearPermissionWait as sessionOpClearPermissionWait } from './downgrade-cold-auth-resume-permission.ts';
import { isExactPendingAuthRequest as sessionOpIsExactPendingAuthRequest } from './persistence-barriers.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation, assertSessionMutationAdmissionOpen as sessionOpAssertSessionMutationAdmissionOpen, ownsSessionOperation as sessionOpOwnsSessionOperation } from './track-session-operation.ts';
import { completeAuthRequestIfCurrent as sessionOpCompleteAuthRequestIfCurrent } from './authentication.ts';

/**
 * Respond to a pending permission request
 * Returns true if the response was delivered, false if agent/session is gone
 */
function sessionOpRespondToPermission(sessionOperationContext: SessionOperationContext, sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean, options?: import('@craft-agent/shared/protocol').PermissionResponseOptions): boolean {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (sessionOperationContext.state.shuttingDown || managed?.pendingTurnRecovery?.waitingForPermission?.recoveryRequired)
        return false;
    if (managed?.agent) {
        const requestMeta = sessionOperationContext.state.pendingPermissionRequests.get(requestId);
        if (!requestMeta) {
            sessionLog.warn(`Permission response ignored for unknown or closed request ${requestId}`);
            return false;
        }
        if (requestMeta.sessionId !== sessionId) {
            sessionLog.warn(`Permission response session mismatch for ${requestId}`);
            return false;
        }
        const objectiveId = managed.activeObjective?.objectiveId ?? managed.activeObjective?.userMessageId;
        const requestAgent = requestMeta.runtimeAgent;
        const ownsRequest = !!requestAgent
            && Date.now() < requestMeta.expiresAt
            && managed.isProcessing
            && !managed.stopRequested
            && managed.processingGeneration === requestMeta.processingGeneration
            && managed.activeObjective?.terminalState === 'active'
            && (!requestMeta.objectiveId || requestMeta.objectiveId === objectiveId)
            && managed.agent === requestMeta.runtimeAgent
            && sessionOperationContext.state.permissionExpiryStopGenerations.get(managed) !== requestMeta.processingGeneration;
        if (!ownsRequest) {
            sessionOperationContext.state.pendingPermissionRequests.delete(requestId);
            clearTimeout(requestMeta.timeout);
            sessionOpRejectPendingPrivilegedApproval(sessionOperationContext, requestId, requestMeta);
            sessionOpClearPermissionWait(sessionOperationContext, managed, requestId);
            if (sessionOpMarkPermissionToolNotExecuted(sessionOperationContext, managed, requestMeta))
                sessionOperationContext.owner["persistSession"](managed);
            sessionOpDenyPermissionOnRecordedRuntime(sessionOperationContext, requestId, requestMeta);
            sessionLog.warn('Permission response rejected after request ownership changed', {
                sessionId,
                requestId,
                requestGeneration: requestMeta.processingGeneration,
                currentGeneration: managed.processingGeneration,
                currentRuntime: managed.agent === requestMeta.runtimeAgent,
                stopRequested: managed.stopRequested,
                objectiveState: managed.activeObjective?.terminalState,
            });
            return false;
        }
        sessionOperationContext.state.pendingPermissionRequests.delete(requestId);
        sessionOpClearPermissionWait(sessionOperationContext, managed, requestId);
        if (requestMeta)
            clearTimeout(requestMeta.timeout);
        if (requestMeta?.type === 'admin_approval') {
            const brokerResult = sessionOperationContext.state.privilegedExecutionBroker.resolveApproval(requestId, allowed, {
                expectedCommandHash: requestMeta.commandHash,
                expectedSessionId: sessionId,
            });
            if (!brokerResult.ok) {
                sessionLog.warn(`Admin approval rejected by broker for ${requestId}: ${brokerResult.reason}`);
                // Broker rejection should fail closed.
                void sessionOpRecordDeniedPermissionBeforeProviderResume(sessionOperationContext, managed, requestMeta)
                    .catch(error => {
                    sessionLog.warn('Could not record rejected broker permission', {
                        sessionId,
                        requestId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                })
                    .finally(() => {
                    sessionOpDenyPermissionOnRecordedRuntime(sessionOperationContext, requestId, requestMeta);
                });
                sessionOperationContext.owner["emitExecutionTelemetry"](managed, {
                    schemaVersion: 1,
                    eventId: randomUUID(),
                    timestamp: Date.now(),
                    name: 'permission.resolved',
                    correlation: {
                        workspaceId: managed.workspace.id,
                        sessionId,
                    },
                    permissionKind: requestMeta.type ?? requestMeta.toolName ?? 'unknown',
                    resolution: 'denied',
                    durationMs: Math.max(0, Date.now() - requestMeta.requestedAt),
                });
                return false;
            }
            if (allowed && requestMeta.commandHash && options?.rememberForMinutes) {
                sessionOpStoreAdminRememberApproval(sessionOperationContext, sessionId, requestMeta.commandHash, requestId, options.rememberForMinutes);
            }
        }
        // A one-time host approval authorizes only the pending invocation. Persist
        // an exact replay grant solely when the human explicitly chose Always Allow.
        if (allowed && alwaysAllow
            && requestMeta?.sensitiveActionCategory && requestMeta.sensitiveActionTargets?.length) {
            managed.externalActionAuthorizations = rememberExternalActionAuthorization(managed.externalActionAuthorizations, {
                category: requestMeta.sensitiveActionCategory,
                targetCandidates: requestMeta.sensitiveActionTargets,
                toolName: requestMeta.toolName,
                operationHash: requestMeta.sensitiveActionOperationHash,
            });
            sessionOperationContext.owner["persistSession"](managed);
            void sessionOperationContext.owner.flushSession(managed.id).catch(error => {
                sessionLog.warn('Failed to persist scoped sensitive-action authorization', {
                    sessionId: managed.id,
                    requestId,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        }
        const providerAlwaysAllow = providerAlwaysAllowForExternalAction(alwaysAllow, requestMeta?.sensitiveActionCategory);
        sessionLog.info(`Permission response for ${requestId}: allowed=${allowed}, alwaysAllow=${providerAlwaysAllow}`);
        if (requestMeta) {
            sessionOperationContext.owner["emitExecutionTelemetry"](managed, {
                schemaVersion: 1,
                eventId: randomUUID(),
                timestamp: Date.now(),
                name: 'permission.resolved',
                correlation: {
                    workspaceId: managed.workspace.id,
                    sessionId,
                },
                permissionKind: requestMeta.type ?? requestMeta.toolName ?? 'unknown',
                resolution: allowed ? 'approved' : 'denied',
                durationMs: Math.max(0, Date.now() - requestMeta.requestedAt),
            });
        }
        if (!allowed) {
            void sessionOpRecordDeniedPermissionBeforeProviderResume(sessionOperationContext, managed, requestMeta)
                .catch(error => {
                sessionLog.warn('Could not record explicit permission denial', {
                    sessionId,
                    requestId,
                    error: error instanceof Error ? error.message : String(error),
                });
            })
                .finally(() => {
                try {
                    requestAgent!.respondToPermission(requestId, false, providerAlwaysAllow);
                }
                catch (error) {
                    sessionLog.warn('Could not deny provider permission request', {
                        sessionId,
                        requestId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            });
            return true;
        }
        requestAgent!.respondToPermission(requestId, true, providerAlwaysAllow);
        return true;
    }
    else {
        sessionLog.warn(`Cannot respond to permission - no agent for session ${sessionId}`);
        return false;
    }
}

/**
 * Respond to a pending credential request
 * Returns true if the response was delivered, false if no pending request found
 *
 * Supports both:
 * - New unified auth flow (via handleCredentialInput)
 * - Legacy callback flow (via pendingCredentialResolvers)
 */
async function sessionOpRespondToCredential(sessionOperationContext: SessionOperationContext, sessionId: string, requestId: string, response: import('@craft-agent/shared/protocol').CredentialResponse): Promise<boolean> {
    const operationKey = `${sessionId}\u0000${requestId}`;
    const existingOperation = sessionOperationContext.state.credentialResponsesInFlight.get(operationKey);
    if (existingOperation) {
        sessionLog.info(`Credential response already in flight for ${requestId}; joining the one-shot operation`);
        return existingOperation.operation;
    }
    // First, check if this is a new unified auth flow request
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    const request = managed?.pendingAuthRequest;
    if (managed && request && sessionOpIsExactPendingAuthRequest(sessionOperationContext, managed, request) && request.requestId === requestId) {
        sessionLog.info(`Credential response (unified flow) for ${requestId}: cancelled=${response.cancelled}`);
        // Defer execution until after the operation is registered so re-entrant
        // or same-tick submissions can only join it.
        const operation = sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
            await Promise.resolve();
            if (request.type === 'credential') {
                return sessionOperationContext.owner.handleCredentialInput(sessionId, requestId, response, request);
            }
            if (response.cancelled) {
                return sessionOpCompleteAuthRequestIfCurrent(sessionOperationContext, sessionId, {
                    requestId,
                    sourceSlug: request.sourceSlug,
                    success: false,
                    cancelled: true,
                }, request);
            }
            return false;
        });
        const entry = { request, operation };
        sessionOperationContext.state.credentialResponsesInFlight.set(operationKey, entry);
        try {
            return await operation;
        }
        finally {
            if (sessionOperationContext.state.credentialResponsesInFlight.get(operationKey) === entry) {
                sessionOperationContext.state.credentialResponsesInFlight.delete(operationKey);
            }
        }
    }
    if (request || managed?.pendingAuthRequestId) {
        sessionLog.warn(`Cannot respond to credential - request ${requestId} is not the exact pending credential capability`);
        return false;
    }
    // Fall back to legacy callback flow
    const resolver = sessionOperationContext.state.pendingCredentialResolvers.get(requestId);
    if (resolver) {
        sessionLog.info(`Credential response (legacy flow) for ${requestId}: cancelled=${response.cancelled}`);
        sessionOperationContext.state.pendingCredentialResolvers.delete(requestId);
        resolver(response);
        return true;
    }
    else {
        sessionLog.warn(`Cannot respond to credential - no pending request for ${requestId}`);
        return false;
    }
}

/**
 * Set the permission mode for a session ('safe', 'ask', 'allow-all')
 */
function sessionOpSetSessionPermissionMode(sessionOperationContext: SessionOperationContext, sessionId: string, mode: PermissionMode): void {
    mode = requirePermissionMode(mode);
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (managed) {
        sessionOpAssertSessionMutationAdmissionOpen(sessionOperationContext, managed);
        if (isTerminalReviewSession(managed) && mode !== 'safe')
            throw new Error('Independent reviewer sessions must remain in safe mode');
        const previousManagedMode = managed.permissionMode ?? 'ask';
        const diagnosticsBefore = getPermissionModeDiagnostics(sessionId);
        const previousEffectiveMode = diagnosticsBefore.permissionMode;
        // No-op only when BOTH managed state and mode-manager state already match.
        // If managed state matches but diagnostics drifted, heal authoritative mode state.
        if (previousManagedMode === mode && previousEffectiveMode === mode) {
            return;
        }
        if (previousManagedMode === mode && previousEffectiveMode !== mode) {
            sessionLog.warn('Permission mode drift detected on same-mode update; reconciling authoritative mode state', {
                sessionId,
                managedMode: previousManagedMode,
                diagnosticsMode: previousEffectiveMode,
                targetMode: mode,
                modeVersion: diagnosticsBefore.modeVersion,
                changedBy: diagnosticsBefore.lastChangedBy,
            });
        }
        // Update in-memory managed mode first
        managed.permissionMode = mode;
        // Reconcile mode-manager state for this specific session.
        if (previousEffectiveMode !== mode) {
            const changedBy = previousManagedMode === mode ? 'restore' : 'user';
            setPermissionMode(sessionId, mode, { changedBy });
        }
        const diagnostics = getPermissionModeDiagnostics(sessionId);
        managed.previousPermissionMode = diagnostics.previousPermissionMode;
        sessionLog.info('Permission mode changed', {
            sessionId,
            permissionMode: mode,
            modeVersion: diagnostics.modeVersion,
            changedBy: diagnostics.lastChangedBy,
            changedAt: diagnostics.lastChangedAt,
        });
        // Forward to the agent instance so backends can propagate mode changes downstream.
        if (managed.agent) {
            managed.agent.setPermissionMode(mode);
        }
        sessionOperationContext.owner["sendEvent"]({
            type: 'permission_mode_changed',
            sessionId: managed.id,
            permissionMode: mode,
            modeVersion: diagnostics.modeVersion,
            changedBy: diagnostics.lastChangedBy,
            changedAt: diagnostics.lastChangedAt,
            previousPermissionMode: diagnostics.previousPermissionMode,
            transitionDisplay: diagnostics.transitionDisplay,
        }, managed.workspace.id);
        // Persist to disk
        sessionOperationContext.owner["persistSession"](managed);
    }
}

/**
 * Get authoritative permission mode diagnostics for a session.
 * Used by renderer to reconcile optimistic/stale mode state.
 */
function sessionOpGetSessionPermissionModeState(sessionOperationContext: SessionOperationContext, sessionId: string): {
    permissionMode: PermissionMode;
    previousPermissionMode?: PermissionMode;
    transitionDisplay?: string;
    modeVersion: number;
    changedAt: string;
    changedBy: 'user' | 'system' | 'restore' | 'automation' | 'unknown';
} | null {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed || !sessionOpOwnsSessionOperation(sessionOperationContext, managed))
        return null;
    let diagnostics = getPermissionModeDiagnostics(sessionId);
    // Hydrate persisted transition context when mode-manager has been reset (e.g. app restart).
    if (managed.previousPermissionMode && !diagnostics.previousPermissionMode) {
        hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode);
        diagnostics = getPermissionModeDiagnostics(sessionId);
    }
    // Heal restore races where mode-manager still has default state while
    // session metadata already has a persisted non-default mode.
    if (managed.permissionMode && diagnostics.permissionMode !== managed.permissionMode) {
        sessionLog.warn('Permission mode diagnostics mismatch, reconciling to managed session mode', {
            sessionId,
            managedMode: managed.permissionMode,
            diagnosticsMode: diagnostics.permissionMode,
            modeVersion: diagnostics.modeVersion,
            changedBy: diagnostics.lastChangedBy,
        });
        setPermissionMode(sessionId, managed.permissionMode, { changedBy: 'restore' });
        if (managed.previousPermissionMode) {
            hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode);
        }
        diagnostics = getPermissionModeDiagnostics(sessionId);
    }
    managed.previousPermissionMode = diagnostics.previousPermissionMode;
    return {
        permissionMode: diagnostics.permissionMode,
        previousPermissionMode: diagnostics.previousPermissionMode,
        transitionDisplay: diagnostics.transitionDisplay,
        modeVersion: diagnostics.modeVersion,
        changedAt: diagnostics.lastChangedAt,
        changedBy: diagnostics.lastChangedBy,
    };
}

export { sessionOpRespondToPermission as respondToPermission };
export { sessionOpRespondToCredential as respondToCredential };
export { sessionOpSetSessionPermissionMode as setSessionPermissionMode };
export { sessionOpGetSessionPermissionModeState as getSessionPermissionModeState };
