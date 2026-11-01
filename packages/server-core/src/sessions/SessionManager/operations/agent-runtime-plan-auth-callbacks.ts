import type { PendingTurnRecovery } from '../../../../../shared/src/sessions/types/turn-recovery.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import { getAuthRequestDescription } from '../policy.ts';
import { readFile } from 'fs/promises';
import { AbortReason } from '@craft-agent/shared/agent';
import { generateMessageId } from '@craft-agent/shared/protocol';
import type { Message } from '@craft-agent/core/types';
import { createPendingTurnRecovery } from '../../turn-recovery';
import { releaseBrowserOwnershipOnForcedStop } from '@craft-agent/server-core/domain';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { isManagedSessionYolo as sessionOpIsManagedSessionYolo } from './is-managed-session-yolo.ts';
import { recordAutonomyEvent as sessionOpRecordAutonomyEvent } from './persist-tool-result-after-permission-expiry.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { pendingRecoveryBelongsToCurrentObjective as sessionOpPendingRecoveryBelongsToCurrentObjective } from './pending-recovery-belongs-to-current-objective.ts';

export function installRuntimePlanAuthCallbacks(sessionOperationContext: SessionOperationContext, managed: ManagedSession) {
    // Wire up onPlanSubmitted to add plan message to conversation
    managed.agent!.onPlanSubmitted = async (planPath) => {
        const planGeneration = managed.processingGeneration;
        const planAgent = managed.agent!;
        const ownsPlan = () => !sessionOperationContext.state.shuttingDown && sessionOperationContext.state.sessions.get(managed.id) === managed
            && managed.processingGeneration === planGeneration && managed.agent! === planAgent;
        sessionLog.info(`Plan submitted for session ${managed.id}:`, planPath);
        try {
            // Read the plan file content
            const planContent = await readFile(planPath, 'utf-8');
            if (!ownsPlan())
                return;
            // Mark the SubmitPlan tool message as completed (it won't get a tool_result due to forceAbort)
            const submitPlanMsg = managed.messages.find(m => m.toolName?.includes('SubmitPlan') && m.toolStatus === 'executing');
            if (submitPlanMsg) {
                submitPlanMsg.toolStatus = 'completed';
                submitPlanMsg.content = 'Plan submitted for review';
                submitPlanMsg.toolResult = 'Plan submitted for review';
            }
            // Create a plan message
            const planMessage = {
                id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                role: 'plan' as const,
                content: planContent,
                timestamp: sessionOpMonotonic(sessionOperationContext),
                planPath,
            };
            // Add to session messages
            managed.messages.push(planMessage);
            // Update lastMessageRole for badge display
            managed.lastMessageRole = 'plan';
            // Send event to renderer
            sessionOperationContext.owner["sendEvent"]({
                type: 'plan_submitted',
                sessionId: managed.id,
                message: planMessage,
            }, managed.workspace.id);
            // Interrupt execution - plan presentation is a stopping point
            // The user needs to review and respond before continuing
            if (sessionOpIsManagedSessionYolo(sessionOperationContext, managed)) {
                sessionOperationContext.owner["persistSession"](managed);
                await sessionOperationContext.owner.flushSession(managed.id);
            }
            if (managed.isProcessing && managed.agent! && !sessionOpIsManagedSessionYolo(sessionOperationContext, managed)) {
                sessionLog.info(`Interrupting for plan submission in session ${managed.id}`);
                managed.agent!.interruptForHandoff(AbortReason.PlanSubmitted);
                sessionOperationContext.owner["setProcessing"](managed, false);
                sessionOperationContext.owner["clearPendingTurnRecovery"](managed);
                // Release browser overlay + session binding because the agent is no longer running.
                // Plan submission pauses execution until user review, so browser ownership should not remain locked.
                await releaseBrowserOwnershipOnForcedStop((sid) => sessionOperationContext.owner.getBrowserPaneManagerForSession(sid), managed.id, ownsPlan);
                if (!ownsPlan())
                    return;
                // Send complete event so renderer knows processing stopped (include tokenUsage for real-time updates)
                sessionOperationContext.owner["sendEvent"]({ type: 'complete', sessionId: managed.id, reason: 'interrupted', tokenUsage: managed.tokenUsage, backgroundTasksAlive: sessionOperationContext.state.keepBackgroundTasksAlive }, managed.workspace.id);
                // Persist session state
                sessionOperationContext.owner["persistSession"](managed);
                await sessionOperationContext.owner.flushSession(managed.id);
            }
        }
        catch (error) {
            sessionLog.error(`Failed to read plan file:`, error);
        }
    };
    // Wire up onAuthRequest to add auth message to conversation and pause execution
    managed.agent!.onAuthRequest = (request) => {
        if (sessionOperationContext.state.shuttingDown || sessionOperationContext.state.retiringSessions.has(managed)
            || sessionOperationContext.state.sessions.get(managed.id) !== managed)
            return;
        if (sessionOpIsManagedSessionYolo(sessionOperationContext, managed)) {
            sessionOpRecordAutonomyEvent(sessionOperationContext, managed, { phase: 'diagnosis',
                message: `YOLO authentication unavailable for ${request.sourceSlug}: no interactive request was opened. Use existing access or finish independent work and report the unavailable dependency.` });
            sessionOperationContext.owner["persistSession"](managed);
            void sessionOperationContext.owner.flushSession(managed.id);
            return;
        }
        if (managed.missionCapabilityLock) {
            sessionLog.warn(`Rejected source authentication from specialized Mission session ${managed.id}`);
            return;
        }
        sessionLog.info(`Auth request for session ${managed.id}:`, request.type, request.sourceSlug);
        // Create auth-request message
        const authMessage: Message = {
            id: generateMessageId(),
            role: 'auth-request',
            content: getAuthRequestDescription(request),
            timestamp: sessionOpMonotonic(sessionOperationContext),
            authRequestId: request.requestId,
            authRequestType: request.type,
            authSourceSlug: request.sourceSlug,
            authSourceName: request.sourceName,
            authStatus: 'pending',
            // Copy type-specific fields for credentials
            ...(request.type === 'credential' && {
                authCredentialMode: request.mode,
                ...(request.labels !== undefined ? { authLabels: request.labels } : {}),
                ...(request.description !== undefined ? { authDescription: request.description } : {}),
                ...(request.hint !== undefined ? { authHint: request.hint } : {}),
                ...(request.headerName !== undefined ? { authHeaderName: request.headerName } : {}),
                ...(request.headerNames !== undefined ? { authHeaderNames: request.headerNames } : {}),
                ...(request.sourceUrl !== undefined ? { authSourceUrl: request.sourceUrl } : {}),
                ...(request.passwordRequired !== undefined ? { authPasswordRequired: request.passwordRequired } : {}),
            }),
        };
        // Add to session messages
        managed.messages.push(authMessage);
        // Store pending auth request for later resolution
        managed.pendingAuthRequestId = request.requestId;
        managed.pendingAuthRequest = request;
        // Interrupt execution (like SubmitPlan)
        if (managed.isProcessing && managed.agent!) {
            sessionLog.info(`Interrupting for auth request in session ${managed.id}`);
            managed.agent!.interruptForHandoff(AbortReason.AuthRequest);
            sessionOperationContext.owner["setProcessing"](managed, false);
            const objective = managed.activeObjective;
            if (objective?.terminalState === 'active') {
                const recoveryAnchor = objective.lastUserMessageId ?? objective.userMessageId;
                const retained = managed.pendingTurnRecovery
                    && sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, managed.pendingTurnRecovery)
                    ? managed.pendingTurnRecovery
                    : createPendingTurnRecovery(recoveryAnchor);
                // Keep a durable continuation marker across the human auth handoff.
                // Clearing it here created a crash gap after credentials were saved
                // but before the hidden auth-result turn reached disk.
                managed.pendingTurnRecovery = omitUndefined<PendingTurnRecovery>({
                    ...retained,
                    userMessageId: recoveryAnchor,
                    lastCause: 'app_restart',
                    continuationRequired: true,
                    recoveryDispatch: undefined,
                });
            }
            else {
                sessionOperationContext.owner["clearPendingTurnRecovery"](managed);
            }
            // Release browser overlay + session binding because the agent is paused awaiting user auth.
            void releaseBrowserOwnershipOnForcedStop((sid) => sessionOperationContext.owner.getBrowserPaneManagerForSession(sid), managed.id);
            // Send complete event so renderer knows processing stopped (include tokenUsage for real-time updates)
            sessionOperationContext.owner["sendEvent"]({ type: 'complete', sessionId: managed.id, reason: 'interrupted', tokenUsage: managed.tokenUsage, backgroundTasksAlive: sessionOperationContext.state.keepBackgroundTasksAlive }, managed.workspace.id);
        }
        // Emit auth_request event to renderer
        sessionOperationContext.owner["sendEvent"]({
            type: 'auth_request',
            sessionId: managed.id,
            message: authMessage,
            request: request,
        }, managed.workspace.id);
        // Persist session state
        sessionOperationContext.owner["persistSession"](managed);
        void sessionOperationContext.owner.flushSession(managed.id);
        sessionOperationContext.owner["scheduleDeferredAutomaticSessions"]();
        // OAuth flow is client-driven via performOAuth() (preload).
        // The UI calls window.electronAPI.performOAuth() when user clicks "Sign in".
    };
}


