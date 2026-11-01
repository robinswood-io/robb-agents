import type { SessionOperationContext } from '../operation-context.ts';
import { queuedDirectHumanContinuationIndex } from '../policy.ts';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@craft-agent/shared/agent';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { SOURCE_ACTIVATION_DEDUP_WINDOW_MS, SOURCE_ACTIVATION_TOMBSTONE_TTL_MS, rememberAutoRetryTombstone, sourceActivationObjectiveBinding } from '../source-activation.ts';
import { scheduleSourceActivationDispatch as sessionOpScheduleSourceActivationDispatch } from './repair-legacy-synthetic-objective-authority.ts';

export function handleAgentSourceActivated(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, { type: 'source_activated' }>, sessionId: string, workspaceId: string, generationKey: number): void {
    {
        // The renderer event used to trigger a client-side retry. Validate and
        // arm host provenance first so a stopped/stale event can never cause an
        // old renderer to manufacture a visible objective root.
        const objectiveBinding = sourceActivationObjectiveBinding(managed.activeObjective);
        const sourceTurn = managed.sourceActivationTurn;
        const cancellationEpoch = sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0;
        const validSlug = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(event.sourceSlug)
            && event.sourceSlug.length <= 128;
        const validEvent = !sessionOperationContext.state.shuttingDown && !managed.stopRequested
            && sessionOperationContext.state.sessions.get(sessionId) === managed
            && managed.processingGeneration === generationKey
            && sourceTurn?.generation === generationKey
            && sourceTurn.cancellationEpoch === cancellationEpoch
            && !!objectiveBinding
            && sourceTurn.objectiveId === objectiveBinding.objectiveId
            && sourceTurn.objectiveRevision === objectiveBinding.objectiveRevision
            && !!sourceTurn.rawMessage.trim()
            && validSlug
            && queuedDirectHumanContinuationIndex(managed) < 0;
        if (!validEvent || !objectiveBinding || !sourceTurn) {
            sessionLog.warn(`Ignored stale or unbound source activation for session ${sessionId}`, {
                sourceSlug: event.sourceSlug,
                generation: generationKey,
                currentGeneration: managed.processingGeneration,
                stopRequested: managed.stopRequested,
            });
            return;
        }
        const duplicateActivation = managed.messages.some(message => (message.role === 'user' && message.internalOrigin?.kind === 'source-activation'
            && message.internalOrigin.objectiveId === objectiveBinding.objectiveId
            && message.internalOrigin.objectiveRevision === objectiveBinding.objectiveRevision
            && message.internalOrigin.sourceSlug === event.sourceSlug)) || (managed.autoRetryPending?.objectiveId === objectiveBinding.objectiveId
            && managed.autoRetryPending.objectiveRevision === objectiveBinding.objectiveRevision
            && managed.autoRetryPending.sourceSlug === event.sourceSlug
            && !managed.autoRetryPending.cancelled);
        if (duplicateActivation) {
            sessionLog.warn(`Ignored repeated source activation for ${event.sourceSlug} on the same objective revision`, {
                sessionId,
                objectiveId: objectiveBinding.objectiveId,
                objectiveRevision: objectiveBinding.objectiveRevision,
            });
            return;
        }
        const originalMessage = sourceTurn.rawMessage;
        const messageWithSuffix = `${originalMessage}\n\n[${event.sourceSlug} activated]`;
        const now = Date.now();
        const dispatchToken = Symbol(`source-activation:${event.sourceSlug}`);
        const previousPending = managed.autoRetryPending;
        if (previousPending) {
            rememberAutoRetryTombstone(managed, previousPending.content, now, previousPending.tombstoneExpiresAt);
            if (managed.autoRetryTimer)
                clearTimeout(managed.autoRetryTimer);
        }
        managed.autoRetryPending = {
            content: messageWithSuffix,
            rawMessage: originalMessage,
            deadlineMs: now + SOURCE_ACTIVATION_DEDUP_WINDOW_MS,
            tombstoneExpiresAt: now + SOURCE_ACTIVATION_TOMBSTONE_TTL_MS,
            objectiveId: objectiveBinding.objectiveId,
            objectiveRevision: objectiveBinding.objectiveRevision,
            sourceSlug: event.sourceSlug,
            sourceActivationId: randomUUID(),
            generation: generationKey,
            cancellationEpoch,
            messageCountAtSchedule: managed.messages.length,
            dispatchToken,
            dispatchInFlight: false,
            dispatchAttempts: 0,
            committed: false,
            cancelled: false,
        };
        // Pi and Claude intentionally end this generator. The marker prevents
        // stream-loss recovery from competing with the authenticated restart.
        managed.sourceActivationRestartGeneration = generationKey;
        sessionOpScheduleSourceActivationDispatch(sessionOperationContext, managed, dispatchToken);
        // Feedback is emitted only after the server can reject a mixed-version
        // client retry and only with clean pre-enrichment text.
        sessionOperationContext.owner["sendEvent"]({
            type: 'source_activated',
            sessionId,
            sourceSlug: event.sourceSlug,
            originalMessage,
        }, workspaceId);
        sessionLog.info(`Source "${event.sourceSlug}" activated for session ${sessionId}, scheduling auto-retry`);
        return;
    }
}


