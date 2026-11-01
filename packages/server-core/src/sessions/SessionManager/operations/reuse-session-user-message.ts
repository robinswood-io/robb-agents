import type { ActiveSessionObjective } from '../../../../../shared/src/sessions/types/objectives.ts';
import type { PendingTurnRecovery } from '../../../../../shared/src/sessions/types/turn-recovery.ts';
import {setOptional, omitUndefined } from '@craft-agent/shared/utils/json';
import { resolveAgentCostControlPolicy } from '@craft-agent/shared/config';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { generateMessageId } from '@craft-agent/shared/protocol';
import type { Message } from '@craft-agent/core/types';
import { explicitRetryProgressFingerprint } from '../../explicit-retry-progress';
import { turnRecoveryValidationFingerprint, createPendingTurnRecovery, grantExplicitRetryAllowance, reconstructLegacyTurnRecoveryBudget } from '../../turn-recovery';
import { transitionObjectiveContract } from '../../objective-contract';
import { normalizeRecoveryValidationGapsForProgress } from '../../recovery-progress';
import { assertStrongCancellationAdmissionOpen as sessionOpAssertStrongCancellationAdmissionOpen } from './perform-cancel-processing-and-wait.ts';
import { trackSyntheticAutomaticMessage as sessionOpTrackSyntheticAutomaticMessage, getInterruptedTurnRecovery as sessionOpGetInterruptedTurnRecovery, hasValidationExhaustionMarker as sessionOpHasValidationExhaustionMarker } from './reconcile-provider-acceptance-unknown-for-retry.ts';
import { objectiveContractTextFor as sessionOpObjectiveContractTextFor } from './try-refresh-agent-runtime.ts';
import type { UserMessagePreparationInput, PreparedUserMessage } from './user-message-preparation-input.ts';

export function reuseSessionUserMessage(
    userMessagePreparationInput: UserMessagePreparationInput
): PreparedUserMessage {
    const {
        managed,
        existingMessageId,
        supersedableAutomaticRecovery,
        activeMessageState,
        sessionOperationContext,
        explicitRetry,
        trustedUserInput,
        explicitRetryAllowanceToken,
        ownsActiveTurn,
        sessionId,
        myGeneration,
        assertAuthenticatedInternalContinuation,
    } = userMessagePreparationInput;
    let userMessage: Message;
    let existingTurnRollback: (() => void) | undefined;
// Find existing message (already added when queued)
    userMessage = managed.messages.find(m => m.id === existingMessageId)!;
    if (!userMessage) {
        throw new Error(`Existing message ${existingMessageId} not found`);
    }
    if (supersedableAutomaticRecovery && userMessage.role === 'user' && userMessage.hidden) {
        // A deferred pre-chat recovery reuses its durable message. Adopt the
        // same identity so Stop/human supersession can still remove it, and so
        // the provider boundary below releases the original tracking entry.
        activeMessageState.syntheticAutomaticMessage = userMessage;
        sessionOpTrackSyntheticAutomaticMessage(sessionOperationContext, managed, userMessage);
    }
    if (explicitRetry || trustedUserInput) {
        const previousObjective = managed.activeObjective;
        const previousRecovery = managed.pendingTurnRecovery;
        const previousStatus = managed.sessionStatus;
        const previousQueued = userMessage.isQueued;
        if (explicitRetry) {
            const retryRecovery = previousRecovery ?? sessionOpGetInterruptedTurnRecovery(sessionOperationContext, managed, userMessage.id)
                ?? ((previousObjective?.lastUserMessageId ?? previousObjective?.userMessageId) === userMessage.id
                    ? reconstructLegacyTurnRecoveryBudget(managed.messages, userMessage.id)
                    : undefined);
            managed.activeObjective = previousObjective
                ? omitUndefined<ActiveSessionObjective>({ ...previousObjective, interruptedTurnRecovery: undefined, terminalState: 'active', completedAt: undefined })
                : transitionObjectiveContract({
                    messageId: userMessage.id,
                    text: sessionOpObjectiveContractTextFor(sessionOperationContext, managed, userMessage),
                });
            managed.pendingTurnRecovery = omitUndefined<PendingTurnRecovery>({
                ...(retryRecovery ?? createPendingTurnRecovery(userMessage.id)),
                // A human can retry an old objective, but a missing historical
                // marker cannot grant that objective a new automatic allowance.
                ...(!retryRecovery && previousObjective ? {
                    budgetHistoryUnavailable: true,
                    // Older hosts also recognize this stop if the bundle is rolled back.
                    exhaustedAt: Date.now(),
                } : {}),
                ...(sessionOpHasValidationExhaustionMarker(sessionOperationContext, managed) ? { validationExhausted: true } : {}),
                userMessageId: userMessage.id,
                lastCause: 'user_retry',
                waitingForPermission: undefined,
                userRetryFromMessageCount: managed.messages.length,
                continuationRequired: false,
            });
            if (explicitRetryAllowanceToken && previousObjective) {
                // No await separates capability consumption from the state update.
                // Failed durability rolls back both through existingTurnRollback.
                sessionOperationContext.state.explicitRetryAllowanceTokens.delete(explicitRetryAllowanceToken);
                const recoveryPolicy = resolveAgentCostControlPolicy(loadWorkspaceConfig(managed.workspace.rootPath)?.costControl).recovery;
                const semanticProgressFingerprint = explicitRetryProgressFingerprint(managed.messages, previousObjective.userMessageId);
                managed.pendingTurnRecovery = grantExplicitRetryAllowance(managed.pendingTurnRecovery, {
                    id: generateMessageId(), objectiveId: previousObjective.objectiveId ?? previousObjective.userMessageId,
                    userMessageId: userMessage.id, nowMs: Date.now(), maxAttempts: recoveryPolicy.maxAutomaticAttempts,
                    progressFingerprint: managed.pendingTurnRecovery.validationGaps?.length
                        ? turnRecoveryValidationFingerprint(normalizeRecoveryValidationGapsForProgress(managed.pendingTurnRecovery.validationGaps)) : semanticProgressFingerprint,
                    semanticProgressFingerprint,
                });
            }
        }
        existingTurnRollback = () => {
            if (!ownsActiveTurn())
                return;
            const changedStatus = managed.sessionStatus !== previousStatus;
            managed.activeObjective = previousObjective;
            managed.pendingTurnRecovery = previousRecovery;
            managed.sessionStatus = previousStatus;
            setOptional(userMessage, "isQueued", trustedUserInput ? true : previousQueued);
            managed.turnLifecycleManagedStatus = undefined;
            sessionOperationContext.owner["setProcessing"](managed, false);
            sessionOperationContext.owner["persistSession"](managed);
            if (changedStatus) {
                sessionOperationContext.owner["sendEvent"]({ type: 'session_status_changed', sessionId, sessionStatus: previousStatus ?? 'todo' }, managed.workspace.id);
            }
        };
    }
    sessionOpAssertStrongCancellationAdmissionOpen(sessionOperationContext, managed);
    managed.processingGeneration = myGeneration;
    sessionOperationContext.owner["setProcessing"](managed, true);
    sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
    assertAuthenticatedInternalContinuation();
    return { userMessage, existingTurnRollback, cleanExplicitRetrySetupRollback: undefined, durablyAcknowledged: false, cleanRecoveryProviderStateAtomized: false };
}
