import type { SessionOperationContext } from '../operation-context.ts';
import { startCompactionTelemetry, persistenceRootFor } from '../policy.ts';
import type { AgentEvent } from '@craft-agent/shared/agent';
import { markCompactionComplete as markStoredCompactionComplete } from '@craft-agent/shared/sessions';
import { generateMessageId } from '@craft-agent/shared/protocol';
import type { Message } from '@craft-agent/core/types';
import { redactSecretLikeMaterial } from '@craft-agent/shared/utils';
import { messagesForPendingRecovery, turnStillNeedsRecovery } from '../../turn-recovery';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { finishCompactionTelemetry as sessionOpFinishCompactionTelemetry } from './telemetry.ts';
import { attemptAuthRetry as sessionOpAttemptAuthRetry } from './perform-cancel-processing.ts';

export function handleAgentStatus(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'status' }>, sessionId: string, workspaceId: string, generationKey: number): void {
    if (event.message.includes('Compacting')) {
        startCompactionTelemetry(managed, generationKey);
    }
    sessionOperationContext.owner["sendEvent"]({
        type: 'status',
        sessionId,
        message: event.message,
        statusType: event.message.includes('Compacting') ? 'compacting' : undefined
    }, workspaceId);
    return;
}

export function handleAgentInfo(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'info' }>, sessionId: string, workspaceId: string, generationKey: number): void {
    {
        const isCompactionComplete = event.message.startsWith('Compacted');
        const infoTimestamp = sessionOpMonotonic(sessionOperationContext);
        // Persist compaction messages so they survive reload
        // Other info messages are transient (just sent to renderer)
        if (isCompactionComplete) {
            sessionOpFinishCompactionTelemetry(sessionOperationContext, managed, generationKey, event.message);
            const compactionMessage: Message = {
                id: generateMessageId(),
                role: 'info',
                content: event.message,
                timestamp: infoTimestamp,
                statusType: 'compaction_complete',
            };
            managed.messages.push(compactionMessage);
            // Mark compaction complete in the session state.
            // This is done here (backend) rather than in the renderer so it's
            // not affected by CMD+R during compaction. The frontend reload
            // recovery will see awaitingCompaction=false and trigger execution.
            void markStoredCompactionComplete(persistenceRootFor(managed), sessionId, managed.persistenceRootIdentity);
            sessionLog.info(`Session ${sessionId}: compaction complete, marked pending plan ready`);
            // Emit usage_update so the context count badge refreshes immediately
            // after compaction, without waiting for the next message
            if (managed.tokenUsage) {
                sessionOperationContext.owner["sendEvent"]({
                    type: 'usage_update',
                    sessionId,
                    tokenUsage: {
                        inputTokens: managed.tokenUsage.inputTokens,
                        contextWindow: managed.tokenUsage.contextWindow,
                    },
                }, workspaceId);
            }
        }
        sessionOperationContext.owner["sendEvent"]({
            type: 'info',
            sessionId,
            message: event.message,
            statusType: isCompactionComplete ? 'compaction_complete' : undefined,
            timestamp: infoTimestamp,
        }, workspaceId);
        return;
    }
}

export function handleAgentRuntimeInterrupted(event: Extract<AgentEvent, { type: 'runtime_interrupted' }>, sessionId: string, generationKey: number): void {
    {
        // This event deliberately does not create a terminal error message.
        // The trailing complete keeps the latest turn "incomplete", which
        // routes through enqueueAutomaticTurnRecovery: durable marker, bounded
        // attempts, clean runtime disposal, and side-effect-aware continuation.
        sessionLog.warn('Agent runtime interrupted; deferring to durable recovery', {
            sessionId,
            generation: generationKey,
            code: event.code,
            exitCode: event.exitCode,
            signal: event.signal,
            message: redactSecretLikeMaterial(event.message).slice(0, 4000),
        });
        return;
    }
}

export async function handleAgentTypedError(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'typed_error' }>, sessionId: string, workspaceId: string, generationKey: number): Promise<void> {
    // Skip errors after handoff (plan submission, auth request)
    if (!managed.isProcessing) {
        sessionLog.info('Skipping typed_error event after handoff/stop:', event.error.message || event.error.title);
        return;
    }
    // Skip abort errors - these are expected when force-aborting via Query.close()
    const typedErrorMsg = event.error.message || event.error.title || '';
    if (typedErrorMsg.includes('aborted') || typedErrorMsg.includes('AbortError')) {
        sessionLog.info('Skipping typed abort error event (expected during interrupt)');
        return;
    }
    // Check for auth errors that can be retried by refreshing the token
    // The SDK subprocess caches the token at startup, so if it expires mid-session,
    // we get invalid_api_key errors. We can fix this by:
    // 1. Resetting the summarization client cache
    // 2. Destroying the agent (new agent's postInit() refreshes the token)
    // 3. Retrying the message
    const isAuthError = event.error.code === 'invalid_api_key' ||
        event.error.code === 'expired_oauth_token';
    const refreshAlreadyFailed = /OAuth (?:session expired and could not be refreshed|access token has expired.*Re-authenticate to continue)/i.test(typedErrorMsg);
    if (isAuthError && !refreshAlreadyFailed && sessionOpAttemptAuthRetry(sessionOperationContext, sessionId, managed, workspaceId, event.error.code, generationKey)) {
        return;
    }
    // A transient network or provider/service failure is safe to route through the existing
    // bounded, side-effect-aware continuation path. The hidden recovery
    // prompt requires state verification before repeating mutations, and
    // exhaustion still falls through to the original typed error.
    const isTransientRecoverableTypedError = (event.error.code === 'network_error' ||
        event.error.code === 'service_error' ||
        event.error.code === 'service_unavailable' ||
        event.error.code === 'provider_error' ||
        event.error.code === 'unknown_error') &&
        event.error.canRetry;
    if (isTransientRecoverableTypedError &&
        managed.pendingTurnRecovery &&
        turnStillNeedsRecovery(messagesForPendingRecovery(managed.messages, managed.pendingTurnRecovery), managed.pendingTurnRecovery.userMessageId) &&
        await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, 'runtime_error')) {
        managed.pendingRuntimeProviderFallback = {
            error: new Error(typedErrorMsg),
            generation: generationKey,
        };
        sessionLog.warn('Queued bounded automatic recovery for transient typed error', {
            sessionId,
            generation: generationKey,
            code: event.error.code,
            attempt: managed.pendingTurnRecovery?.attempts,
        });
        return;
    }
    sessionLog.error('Typed agent event failed', {
        sessionId,
        generation: generationKey,
        code: event.error.code,
        title: redactSecretLikeMaterial(event.error.title ?? '').slice(0, 500),
        error: redactSecretLikeMaterial(typedErrorMsg).slice(0, 4000),
    });
    // Build rich error message with all diagnostic fields for persistence and UI display
    const typedErrorMessage: Message = {
        id: generateMessageId(),
        role: 'error',
        // Combine title and message for content display (handles undefined gracefully)
        content: [event.error.title, event.error.message].filter(Boolean).join(': ') || 'An error occurred',
        timestamp: sessionOpMonotonic(sessionOperationContext),
        // Rich error fields for diagnostics and retry functionality
        errorCode: event.error.code,
        errorTitle: event.error.title,
        errorDetails: event.error.details,
        errorOriginal: event.error.originalError,
        errorCanRetry: event.error.canRetry,
    };
    managed.messages.push(typedErrorMessage);
    managed.terminalErrorGeneration = generationKey;
    // Send typed_error event with full structure for renderer to handle
    sessionOperationContext.owner["sendEvent"]({
        type: 'typed_error',
        sessionId,
        error: {
            code: event.error.code,
            title: event.error.title,
            message: event.error.message,
            actions: event.error.actions,
            canRetry: event.error.canRetry,
            details: event.error.details,
            originalError: event.error.originalError,
        },
        timestamp: typedErrorMessage.timestamp,
    }, workspaceId);
    sessionOperationContext.owner["finishGenerationTelemetry"](managed, generationKey, 'generation.failed', { errorCode: event.error.code });
    return;
}


