import { CodedError } from '@craft-agent/shared/protocol';
import { sessionLog } from '../runtime-platform.ts';
import { claimAutoRetryPending, sourceActivationObjectiveBinding } from '../source-activation.ts';
import type { MessageSourceActivationClaimInput } from './message-source-activation-claim-input.ts';

export function claimMessageSourceActivation(
    input: MessageSourceActivationClaimInput
): boolean | undefined {
    const {
        activeMessageState,
        existingMessageId,
        queuedDispatchToken,
        managed,
        sourceActivationDispatchToken,
        sessionId,
    } = input;
    let authenticatedSourceActivation = false;
// Source-activation auto-retry dedup (craft-agents-oss#804). Matching text
    // from a legacy renderer (or a user) is never provenance. Only the private
    // capability minted by processEvent may preserve the current objective.
    const durableSourceDequeue = activeMessageState.options?.internalOrigin?.kind === 'source-activation'
        && !!existingMessageId && queuedDispatchToken !== undefined;
    const sourceActivationClaim = durableSourceDequeue
        ? 'send'
        : claimAutoRetryPending(managed, activeMessageState.message, Date.now(), sourceActivationDispatchToken);
    if (sourceActivationClaim === 'drop') {
        sessionLog.info(`sendMessage: dropped duplicate source-activation retry for ${sessionId}`);
        return;
    }
    if (sourceActivationClaim === 'reserved') {
        throw new CodedError('CAPABILITY_UNAVAILABLE', 'The terminal "[source activated]" marker is reserved for a server-authenticated source restart');
    }
    if (sourceActivationClaim === 'authenticated') {
        const pending = managed.autoRetryPending;
        const current = sourceActivationObjectiveBinding(managed.activeObjective);
        if (!pending || !current || pending.objectiveId !== current.objectiveId
            || pending.objectiveRevision !== current.objectiveRevision) {
            if (pending) {
                pending.cancelled = true;
                pending.committed = true;
            }
            sessionLog.info(`sendMessage: dropped stale source-activation retry for ${sessionId}`);
            return;
        }
        authenticatedSourceActivation = true;
        activeMessageState.options = {
            ...activeMessageState.options,
            hidden: true,
            internalOrigin: {
                kind: 'source-activation',
                objectiveId: pending.objectiveId,
                objectiveRevision: pending.objectiveRevision,
                sourceSlug: pending.sourceSlug,
                sourceActivationId: pending.sourceActivationId,
            },
        };
    }
    return authenticatedSourceActivation;
}
