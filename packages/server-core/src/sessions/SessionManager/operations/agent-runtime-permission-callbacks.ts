import type { SessionOperationContext } from '../operation-context.ts';
import { randomUUID } from 'node:crypto';
import { getPermissionModeDiagnostics } from '@craft-agent/shared/agent';
import type { ExternalActionAuthorizationCategory } from '@craft-agent/shared/sessions';
import type { PermissionRequest } from '@craft-agent/shared/protocol';
import { hasMatchingExternalActionAuthorization, pruneExternalActionAuthorizations } from '../../external-action-authorization';
import { resolvePermissionRequestTtlMs } from '../../permission-request-lifecycle';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { isManagedSessionYolo as sessionOpIsManagedSessionYolo } from './is-managed-session-yolo.ts';
import { denyPermissionRequestDuringShutdown as sessionOpDenyPermissionRequestDuringShutdown, expirePendingPermissionRequest as sessionOpExpirePendingPermissionRequest } from './expire-pending-permission-request.ts';
import { rejectPermissionRequestOutsideActiveGeneration as sessionOpRejectPermissionRequestOutsideActiveGeneration } from './close-pending-permission-requests-for-stop.ts';
import { recordAutonomyEvent as sessionOpRecordAutonomyEvent } from './persist-tool-result-after-permission-expiry.ts';
import { hasActiveAdminRememberApproval as sessionOpHasActiveAdminRememberApproval } from './runtime-host.ts';

export function installRuntimePermissionCallbacks(sessionOperationContext: SessionOperationContext, managed: ManagedSession, createdAgent: NonNullable<ManagedSession['agent']>) {
    // Set up permission handler to forward requests to renderer
    managed.agent!.onPermissionRequest = (request: {
        requestId: string;
        toolName: string;
        toolUseId?: string;
        command?: string;
        description: string;
        type?: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';
        appName?: string;
        reason?: string;
        impact?: string;
        requiresSystemPrompt?: boolean;
        rememberForMinutes?: number;
        commandHash?: string;
        approvalTtlSeconds?: number;
        sensitiveActionCategory?: ExternalActionAuthorizationCategory;
        sensitiveActionTargets?: string[];
        sensitiveActionOperationHash?: string;
    }) => {
        if (sessionOperationContext.state.shuttingDown || sessionOperationContext.state.retiringSessions.has(managed)
            || sessionOperationContext.state.sessions.get(managed.id) !== managed) {
            sessionOpDenyPermissionRequestDuringShutdown(sessionOperationContext, managed, request, createdAgent);
            return;
        }
        if (sessionOpRejectPermissionRequestOutsideActiveGeneration(sessionOperationContext, managed, request, createdAgent))
            return;
        if (sessionOpIsManagedSessionYolo(sessionOperationContext, managed)) {
            sessionOpRecordAutonomyEvent(sessionOperationContext, managed, { phase: 'diagnosis', toolName: request.toolName,
                message: 'YOLO refused an unexpected interactive permission handoff. No tool was approved or executed; diagnose the exact policy conflict and continue independent work.' });
            createdAgent.respondToPermission(request.requestId, false, false);
            sessionOperationContext.owner["persistSession"](managed);
            void sessionOperationContext.owner.flushSession(managed.id);
            return;
        }
        sessionLog.info(`Permission request for session ${managed.id}:`, request.command);
        let brokerMetadata: {
            commandHash?: string;
            approvalTtlSeconds?: number;
        } = {};
        if (request.type === 'admin_approval' && request.command) {
            const brokerRequest = sessionOperationContext.state.privilegedExecutionBroker.createRequest({
                requestId: request.requestId,
                sessionId: managed.id,
                command: request.command,
                reason: request.reason,
                impact: request.impact,
                approvalTtlSeconds: request.approvalTtlSeconds,
            });
            brokerMetadata = {
                commandHash: brokerRequest.commandHash,
                approvalTtlSeconds: brokerRequest.approvalTtlSeconds,
            };
        }
        const effectiveCommandHash = brokerMetadata.commandHash ?? request.commandHash;
        const requestedAt = Date.now();
        const permissionGeneration = managed.processingGeneration;
        const permissionObjectiveId = managed.activeObjective?.objectiveId ?? managed.activeObjective?.userMessageId;
        const fullRequest: PermissionRequest = {
            ...request,
            ...brokerMetadata,
            sessionId: managed.id,
        };
        sessionOperationContext.owner["emitExecutionTelemetry"](managed, {
            schemaVersion: 1,
            eventId: randomUUID(),
            timestamp: requestedAt,
            name: 'permission.requested',
            correlation: {
                workspaceId: managed.workspace.id,
                sessionId: managed.id,
            },
            permissionKind: request.type ?? request.toolName,
        });
        const activeExternalAuthorizations = pruneExternalActionAuthorizations(managed.externalActionAuthorizations, requestedAt);
        if (activeExternalAuthorizations.length !== (managed.externalActionAuthorizations?.length ?? 0)) {
            managed.externalActionAuthorizations = activeExternalAuthorizations;
            sessionOperationContext.owner["persistSession"](managed);
        }
        if (hasMatchingExternalActionAuthorization(activeExternalAuthorizations, {
            category: request.sensitiveActionCategory,
            targetCandidates: request.sensitiveActionTargets,
            toolName: request.toolName,
            operationHash: request.sensitiveActionOperationHash,
        }, requestedAt)) {
            sessionOperationContext.owner["emitExecutionTelemetry"](managed, {
                schemaVersion: 1,
                eventId: randomUUID(),
                timestamp: Date.now(),
                name: 'permission.resolved',
                correlation: {
                    workspaceId: managed.workspace.id,
                    sessionId: managed.id,
                },
                permissionKind: request.type ?? request.toolName,
                resolution: 'approved',
                durationMs: 0,
            });
            sessionLog.info('Reused scoped sensitive-action authorization', {
                sessionId: managed.id,
                requestId: request.requestId,
                category: request.sensitiveActionCategory,
            });
            managed.agent!?.respondToPermission(request.requestId, true, false);
            return;
        }
        if (request.type === 'admin_approval' && effectiveCommandHash && sessionOpHasActiveAdminRememberApproval(sessionOperationContext, managed.id, effectiveCommandHash)) {
            const brokerResult = sessionOperationContext.state.privilegedExecutionBroker.resolveApproval(request.requestId, true, {
                expectedCommandHash: effectiveCommandHash,
                expectedSessionId: managed.id,
            });
            if (brokerResult.ok) {
                sessionOperationContext.state.privilegedExecutionBroker.auditEvent('privileged_auto_approved_remember_window', {
                    sessionId: managed.id,
                    requestId: request.requestId,
                    commandHash: effectiveCommandHash,
                });
                const liveAgent = managed.agent!;
                if (liveAgent) {
                    sessionOperationContext.owner["emitExecutionTelemetry"](managed, {
                        schemaVersion: 1,
                        eventId: randomUUID(),
                        timestamp: Date.now(),
                        name: 'permission.resolved',
                        correlation: {
                            workspaceId: managed.workspace.id,
                            sessionId: managed.id,
                        },
                        permissionKind: request.type ?? request.toolName,
                        resolution: 'approved',
                        durationMs: 0,
                    });
                    liveAgent.respondToPermission(request.requestId, true, false);
                    return;
                }
            }
            sessionLog.warn(`Remember-window auto-approval skipped for ${request.requestId}: ${brokerResult.reason}`);
        }
        const ttlMs = resolvePermissionRequestTtlMs(fullRequest.approvalTtlSeconds);
        const expiresAt = requestedAt + ttlMs;
        const timeout = setTimeout(() => {
            sessionOpExpirePendingPermissionRequest(sessionOperationContext, request.requestId);
        }, ttlMs);
        timeout.unref?.();
        sessionOperationContext.state.pendingPermissionRequests.set(request.requestId, {
            sessionId: managed.id,
            type: request.type,
            commandHash: effectiveCommandHash,
            toolName: request.toolName,
            toolUseId: request.toolUseId,
            processingGeneration: permissionGeneration,
            objectiveId: permissionObjectiveId,
            runtimeAgent: createdAgent!,
            requestedAt,
            expiresAt,
            request: fullRequest,
            timeout,
            sensitiveActionCategory: request.sensitiveActionCategory,
            sensitiveActionTargets: request.sensitiveActionTargets,
            sensitiveActionOperationHash: request.sensitiveActionOperationHash,
        });
        if (managed.pendingTurnRecovery) {
            managed.pendingTurnRecovery = { ...managed.pendingTurnRecovery,
                waitingForPermission: {
                    requestId: request.requestId,
                    requestedAt,
                    toolName: request.toolName,
                    ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
                } };
            sessionOperationContext.owner["persistSession"](managed);
            void sessionOperationContext.owner.flushSession(managed.id);
        }
        sessionOperationContext.owner["sendEvent"]({
            type: 'permission_request',
            sessionId: managed.id,
            request: fullRequest,
        }, managed.workspace.id);
    };
    // Note: Credential requests now flow through onAuthRequest (unified auth flow)
    // The legacy onCredentialRequest callback has been removed from CraftAgent
    // Auth refresh for mid-session token expiry is handled by the error handler in sendMessage
    // which destroys/recreates the agent to get fresh credentials
    // Set up mode change handlers
    managed.agent!.onPermissionModeChange = (mode) => {
        if (managed.permissionMode === mode) {
            return;
        }
        managed.permissionMode = mode;
        const diagnostics = getPermissionModeDiagnostics(managed.id);
        managed.previousPermissionMode = diagnostics.previousPermissionMode;
        sessionLog.info('Permission mode changed (agent callback)', {
            sessionId: managed.id,
            permissionMode: mode,
            modeVersion: diagnostics.modeVersion,
            changedBy: diagnostics.lastChangedBy,
            changedAt: diagnostics.lastChangedAt,
        });
        sessionOperationContext.owner["sendEvent"]({
            type: 'permission_mode_changed',
            sessionId: managed.id,
            permissionMode: managed.permissionMode,
            modeVersion: diagnostics.modeVersion,
            changedBy: diagnostics.lastChangedBy,
            changedAt: diagnostics.lastChangedAt,
            previousPermissionMode: diagnostics.previousPermissionMode,
            transitionDisplay: diagnostics.transitionDisplay,
        }, managed.workspace.id);
    };
}


