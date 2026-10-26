import type { SessionOperationContext } from '../operation-context.ts';
import type { AgentEvent } from '@craft-agent/shared/agent';
import type { ManagedSession } from '../managed-session.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation } from './track-session-operation.ts';
import { handleAgentTextDelta, handleAgentTextDiscard, handleAgentTextComplete, handleAgentPiTurnAnchor, handleAgentSteerUndelivered } from './agent-text-events.ts';
import { handleAgentToolStart } from './agent-tool-start.ts';
import { handleAgentToolResult } from './agent-tool-result.ts';
import { handleAgentStatus, handleAgentInfo, handleAgentRuntimeInterrupted, handleAgentTypedError } from './agent-notifications.ts';
import { handleAgentTaskBackgrounded, handleAgentWorkflowAgentCompleted, handleAgentTaskProgress, handleAgentTaskCompleted, handleAgentShellBackgrounded } from './agent-task-events.ts';
import { handleAgentSourceActivated } from './agent-source-activation.ts';
import { handleAgentComplete, handleAgentUsageUpdate } from './agent-usage-events.ts';
import { TERMINAL_RECONCILIATION_CAPABILITY_FIELD } from '@craft-agent/shared/agent';
import { sessionLog } from '../runtime-platform.ts';
import { persistToolResultAfterPermissionExpiry as sessionOpPersistToolResultAfterPermissionExpiry } from './persist-tool-result-after-permission-expiry.ts';
import { generateMessageId } from '@craft-agent/shared/protocol';
import type { Message } from '@craft-agent/core/types';
import { redactSecretLikeMaterial } from '@craft-agent/shared/utils';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { attemptAuthRetry as sessionOpAttemptAuthRetry } from './perform-cancel-processing.ts';

function sessionOpProcessEvent(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: AgentEvent, processingGeneration?: number): Promise<void> {
    if (sessionOperationContext.state.retiringSessions.has(managed) || sessionOperationContext.state.sessions.get(managed.id) !== managed) {
        return Promise.resolve();
    }
    const admitShutdownTerminalResult = sessionOperationContext.state.shuttingDown
        && event.type === 'tool_result'
        && sessionOperationContext.state.shutdownTerminalResultAdmissionOpen;
    if (sessionOperationContext.state.shuttingDown && !admitShutdownTerminalResult)
        return Promise.resolve();
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpProcessEventImpl(sessionOperationContext, managed, event, processingGeneration), admitShutdownTerminalResult);
}

async function sessionOpProcessEventImpl(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: AgentEvent, processingGeneration?: number): Promise<void> {
    if ((event.type === 'tool_start' || event.type === 'tool_result')
        && event.input && Object.prototype.hasOwnProperty.call(event.input, TERMINAL_RECONCILIATION_CAPABILITY_FIELD)) {
        // The invocation ticket is a host transport secret, not tool input or
        // evidence. Remove it before logs, automation, renderer and persistence.
        const { [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: _capability, ...safeInput } = event.input;
        event = { ...event, input: safeInput } as AgentEvent;
    }
    const sessionId = managed.id;
    const workspaceId = managed.workspace.id;
    const generationKey = processingGeneration ?? managed.processingGeneration;
    if (sessionOperationContext.state.shuttingDown && event.type !== 'tool_result')
        return;
    const deniedPermissionTools = sessionOperationContext.state.permissionDeniedToolUseIdsByGeneration
        .get(managed)?.get(generationKey);
    if ((event.type === 'tool_start' || event.type === 'tool_result')
        && deniedPermissionTools?.has(event.toolUseId)) {
        sessionLog.info('Ignoring provider event for a denied permission request', {
            sessionId,
            generation: generationKey,
            eventType: event.type,
            toolUseId: event.toolUseId,
        });
        return;
    }
    // Permission expiry terminalizes this exact generation before tearing down
    // its provider runtime. Ignore every late provider event from that closed
    // generation: in particular, a denial result must not overwrite the
    // host-observed non-executed receipt and a late tool_start must not begin a
    // second action while cleanup is in flight.
    if (sessionOperationContext.state.permissionExpiryStopGenerations.get(managed) === generationKey) {
        if (event.type === 'tool_result'
            && deniedPermissionTools
            && sessionOpPersistToolResultAfterPermissionExpiry(sessionOperationContext, managed, event, deniedPermissionTools))
            return;
        sessionLog.info('Ignoring provider event after permission expiry', {
            sessionId,
            generation: generationKey,
            eventType: event.type,
            ...('toolUseId' in event ? { toolUseId: event.toolUseId } : {}),
        });
        return;
    }
    switch (event.type) {
        case 'text_delta':
            return handleAgentTextDelta(sessionOperationContext, managed, event, sessionId, workspaceId);
        case 'text_discard':
            return handleAgentTextDiscard(sessionOperationContext, managed, event, sessionId, workspaceId);
        case 'text_complete':
            return handleAgentTextComplete(sessionOperationContext, managed, event, sessionId, workspaceId);
        case 'pi_turn_anchor':
            return handleAgentPiTurnAnchor(sessionOperationContext, managed, event, sessionId);
        case 'tool_start':
            return handleAgentToolStart(sessionOperationContext, managed, event, sessionId, workspaceId, generationKey);
        case 'tool_result':
            return handleAgentToolResult(sessionOperationContext, managed, event, sessionId, workspaceId, generationKey);
        case 'status':
            return handleAgentStatus(sessionOperationContext, managed, event, sessionId, workspaceId, generationKey);
        case 'info':
            return handleAgentInfo(sessionOperationContext, managed, event, sessionId, workspaceId, generationKey);
        case 'error':
            return handleAgentError(sessionOperationContext, managed, event, sessionId, workspaceId, generationKey);
        case 'runtime_interrupted':
            return handleAgentRuntimeInterrupted(event, sessionId, generationKey);
        case 'typed_error':
            return handleAgentTypedError(sessionOperationContext, managed, event, sessionId, workspaceId, generationKey);
        case 'task_backgrounded':
            return handleAgentTaskBackgrounded(sessionOperationContext, managed, event, sessionId, workspaceId);
        case 'workflow_agent_completed':
            return handleAgentWorkflowAgentCompleted(sessionOperationContext, managed, event, sessionId, workspaceId);
        case 'task_progress':
            return handleAgentTaskProgress(sessionOperationContext, managed, event, sessionId, workspaceId);
        case 'task_completed':
            return handleAgentTaskCompleted(sessionOperationContext, managed, event, sessionId, workspaceId);
        case 'shell_backgrounded':
            return handleAgentShellBackgrounded(sessionOperationContext, managed, event, sessionId, workspaceId);
        case 'source_activated':
            return handleAgentSourceActivated(sessionOperationContext, managed, event, sessionId, workspaceId, generationKey);
        case 'complete':
            return handleAgentComplete(sessionOperationContext, managed, event, sessionId, workspaceId, generationKey);
        case 'usage_update':
            return handleAgentUsageUpdate(sessionOperationContext, managed, event, workspaceId);
        case 'steer_undelivered':
            return handleAgentSteerUndelivered(sessionOperationContext, managed, event, sessionId);
        // Note: working_directory_changed is user-initiated only (via updateWorkingDirectory),
        // the agent no longer has a change_working_directory tool
    }
}

export async function handleAgentError(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'error' }>, sessionId: string, workspaceId: string, generationKey: number): Promise<void> {
    {
        // Skip errors after handoff (plan submission, auth request) — the SDK may emit
        // an error from the interrupted query after we've already stopped processing.
        if (!managed.isProcessing || managed.stopRequested || generationKey !== managed.processingGeneration) {
            sessionLog.info('Skipping error event after handoff/stop:', event.message);
            return;
        }
        const errorObjective = managed.activeObjective;
        // Skip abort errors - these are expected when force-aborting via Query.close()
        if (event.message.includes('aborted') || event.message.includes('AbortError')) {
            sessionLog.info('Skipping abort error event (expected during interrupt)');
            return;
        }
        // Defensive: detect auth-expiry text in plain errors that weren't classified
        // as typed_error (e.g. Pi SDK error path or future provider changes).
        const lowerErr = event.message.toLowerCase();
        const isPlainAuthError = lowerErr.includes('token is expired') ||
            lowerErr.includes('authentication token is expired') ||
            lowerErr.includes('please try signing in again') ||
            (lowerErr.includes('401') && (lowerErr.includes('unauthorized') || lowerErr.includes('auth')));
        const refreshAlreadyFailed = /OAuth (?:session expired and could not be refreshed|access token has expired.*Re-authenticate to continue)/i.test(event.message);
        if (refreshAlreadyFailed && managed.terminalErrorGeneration === generationKey) return;
        if (isPlainAuthError && !refreshAlreadyFailed && sessionOpAttemptAuthRetry(sessionOperationContext, sessionId, managed, workspaceId, undefined, generationKey)) {
            return;
        }
        // Normalize recognizable transient failures into the bounded same-provider recovery path.
        if (/(usage limit|quota|rate.?limit|\b429\b|\b50[23]\b|network|fetch failed|temporar)/i.test(event.message)) {
            await sessionOpProcessEvent(sessionOperationContext, managed, { type: 'typed_error', error: { code: 'provider_error', title: 'Provider unavailable', message: event.message, canRetry: true, actions: [] } }, generationKey);
            return;
        }
        if (sessionOperationContext.state.shuttingDown || managed.stopRequested || !managed.isProcessing
            || generationKey !== managed.processingGeneration || managed.activeObjective !== errorObjective)
            return;
        sessionLog.error('Agent event failed', {
            sessionId,
            generation: generationKey,
            error: redactSecretLikeMaterial(event.message).slice(0, 4000),
        });
        // AgentEvent uses `message` not `error`
        const errorMessage: Message = {
            id: generateMessageId(),
            role: 'error',
            content: event.message,
            timestamp: sessionOpMonotonic(sessionOperationContext)
        };
        managed.messages.push(errorMessage);
        managed.terminalErrorGeneration = generationKey;
        sessionOperationContext.owner["sendEvent"]({ type: 'error', sessionId, error: event.message, timestamp: errorMessage.timestamp }, workspaceId);
        sessionOperationContext.owner["finishGenerationTelemetry"](managed, generationKey, 'generation.failed', { errorCode: 'agent_error' });
        return;
    }
}

export { sessionOpProcessEvent as processEvent };
export { sessionOpProcessEventImpl as processEventImpl };
