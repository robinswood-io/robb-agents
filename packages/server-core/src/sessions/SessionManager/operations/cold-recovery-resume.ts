import type { ManagedSession } from '../managed-session.ts';
import type { SessionOperationContext } from '../operation-context.ts';
import { generateMessageId } from '@craft-agent/shared/protocol';
import type { Message } from '@craft-agent/core/types';
import { sessionLog } from '../runtime-platform.ts';
import { RECOVERY_BUDGET_UNAVAILABLE_MESSAGE } from '../runtime-policy.ts';
import { preserveInterruptedObjectiveContinuation as sessionOpPreserveInterruptedObjectiveContinuation } from './reconcile-provider-acceptance-unknown-for-retry.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';

export async function resumeColdRecoveryQueue(managed: ManagedSession, sessionOperationContext: SessionOperationContext, queued: boolean, sessionId: string, invalidFinal: boolean, validationGaps: string[] | undefined, restartRecoveryCause: 'app_restart' | 'premature_final' | 'evidence_gate' | 'objective_incomplete' | 'objective_continue'): Promise<void> {
    if (queued && !managed.isProcessing) {
        sessionOperationContext.owner["processNextQueuedMessage"](managed.id);
    }
    else if (!queued && managed.pendingTurnRecovery?.exhaustedAt) {
        // Startup has no live generation to emit an agent error. Surface the
        // bounded stop explicitly instead of leaving a silently active mission.
        if (managed.activeObjective)
            managed.activeObjective.terminalState = 'exhausted';
        if (sessionOpPreserveInterruptedObjectiveContinuation(sessionOperationContext, managed)) {
            sessionOperationContext.owner["sendEvent"]({
                type: 'info', sessionId,
                message: 'Automatic continuation paused after restart at its configured progress limit. Completed work and the reported remaining work were preserved; retry to resume.',
                level: 'warning', timestamp: sessionOpMonotonic(sessionOperationContext),
            }, managed.workspace.id);
            await sessionOperationContext.owner["finishAutomaticSessionStatusLifecycle"](managed, 'interrupted');
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            return;
        }
        const validationDetails = invalidFinal
            ? (managed.pendingTurnRecovery.validationGaps ?? validationGaps ?? []).slice(0, 16).map(gap => gap.slice(0, 500))
            : undefined;
        const errorMessage = invalidFinal
            ? managed.pendingTurnRecovery.budgetHistoryUnavailable
                ? RECOVERY_BUDGET_UNAVAILABLE_MESSAGE
                : 'Automatic continuation stopped because the completion contract still could not be validated within the retry limit. Completed work and tool receipts were preserved. Inspect the reported validation gaps before retrying; a validation failure does not authorize repeating an external action or repairing the host application.'
            : managed.pendingTurnRecovery.budgetHistoryUnavailable
                ? RECOVERY_BUDGET_UNAVAILABLE_MESSAGE
                : 'Automatic continuation stopped after restart because the retry limit was reached or the validation gaps remained unchanged. Completed work and tool receipts were preserved; inspect the validation issue before retrying.';
        const error: Message = {
            id: generateMessageId(), role: 'error', timestamp: sessionOpMonotonic(sessionOperationContext),
            content: invalidFinal ? `Completion could not be verified: ${errorMessage}` : errorMessage,
            ...(invalidFinal ? {
                errorCode: 'objective_validation_failed',
                errorTitle: 'Completion could not be verified',
                ...(validationDetails !== undefined ? { errorDetails: validationDetails } : {}),
                errorCanRetry: true,
            } : {}),
        };
        managed.messages.push(error);
        if (invalidFinal) {
            sessionLog.error('Objective completion validation exhausted after restart', {
                sessionId,
                code: error.errorCode,
                recoveryCause: restartRecoveryCause,
                attempts: managed.pendingTurnRecovery.attempts,
                stagnantAttempts: managed.pendingTurnRecovery.stagnantAttempts,
                budgetHistoryUnavailable: managed.pendingTurnRecovery.budgetHistoryUnavailable === true,
                validationGaps: validationDetails,
            });
            sessionOperationContext.owner["sendEvent"]({
                type: 'typed_error', sessionId,
                error: {
                    code: 'objective_validation_failed',
                    title: error.errorTitle!,
                    message: errorMessage,
                    ...(validationDetails !== undefined ? { details: validationDetails } : {}),
                    actions: [], canRetry: true,
                },
                timestamp: error.timestamp,
            }, managed.workspace.id);
        }
        else {
            sessionOperationContext.owner["sendEvent"]({ type: 'error', sessionId, error: error.content, timestamp: error.timestamp }, managed.workspace.id);
        }
        await sessionOperationContext.owner["finishAutomaticSessionStatusLifecycle"](managed, 'error');
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
    }
}


