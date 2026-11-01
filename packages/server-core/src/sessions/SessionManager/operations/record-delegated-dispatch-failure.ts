import type { SessionOperationContext } from '../operation-context.ts';
import { acknowledgeDurableDelivery } from '../../agent-delivery.ts';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import type { FileAttachment } from '@craft-agent/shared/protocol';
import { generateMessageId } from '@craft-agent/shared/protocol';
import { redactSecretLikeMaterial } from '@craft-agent/shared/utils';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { ensureDelegatedTerminalResultDelivery as sessionOpEnsureDelegatedTerminalResultDelivery, scheduleDelegatedTerminalResultRetry as sessionOpScheduleDelegatedTerminalResultRetry } from './ensure-delegated-terminal-result-delivery.ts';
import { mintDelegatedDispatchContinuation as sessionOpMintDelegatedDispatchContinuation, consumeDelegatedDispatchContinuation as sessionOpConsumeDelegatedDispatchContinuation } from './message-authority.ts';

async function sessionOpRecordDelegatedDispatchFailure(sessionOperationContext: SessionOperationContext, child: ManagedSession, error: unknown): Promise<void> {
    if (sessionOperationContext.state.sessions.get(child.id) !== child || !child.delegation)
        return;
    await sessionOperationContext.owner["ensureMessagesLoaded"](child);
    if (sessionOperationContext.state.sessions.get(child.id) !== child || !child.delegation)
        return;
    const detail = redactSecretLikeMaterial(error instanceof Error ? error.message : String(error)).slice(0, 4000);
    if (!child.messages.some(message => message.role === 'error'
        && message.errorCode === 'delegated_dispatch_failed')) {
        child.messages.push({
            id: generateMessageId(),
            role: 'error',
            content: `Delegated dispatch failed before the child could reliably start: ${detail}`,
            timestamp: sessionOpMonotonic(sessionOperationContext),
            errorCode: 'delegated_dispatch_failed',
            errorTitle: 'Delegated dispatch failed',
            errorCanRetry: true,
        });
    }
    if (child.activeObjective?.terminalState === 'active') {
        child.activeObjective.terminalState = 'exhausted';
        child.activeObjective.completedAt = sessionOpMonotonic(sessionOperationContext);
    }
    child.pendingTurnRecovery = undefined;
    child.delegation.finishedAt ??= sessionOpMonotonic(sessionOperationContext);
    sessionOperationContext.state.automaticAdmissionReservations.delete(child.id);
    sessionOperationContext.state.deferredAutomaticSessions.delete(child.id);
    sessionOperationContext.owner["persistSession"](child);
    await sessionOperationContext.owner.flushSession(child.id);
    try {
        const delivered = await sessionOpEnsureDelegatedTerminalResultDelivery(sessionOperationContext, child);
        if (!delivered)
            sessionOpScheduleDelegatedTerminalResultRetry(sessionOperationContext, child.id);
    }
    catch (deliveryError) {
        sessionLog.warn('Failed to persist delegated dispatch failure in parent inbox', {
            childSessionId: child.id,
            error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
        });
        sessionOpScheduleDelegatedTerminalResultRetry(sessionOperationContext, child.id);
    }
}

async function sessionOpSendDelegatedDispatch(sessionOperationContext: SessionOperationContext, parent: ManagedSession, child: ManagedSession, objective: ActiveSessionObjective | undefined, prompt: string, attachments: FileAttachment[] | undefined): Promise<string> {
    const token = sessionOpMintDelegatedDispatchContinuation(sessionOperationContext, parent, child, objective);
    return acknowledgeDurableDelivery(ack => sessionOperationContext.owner.sendMessage(child.id, prompt, attachments, undefined, { internalOrigin: { kind: 'spawned-session', senderSessionId: parent.id } }, undefined, undefined, ack, undefined, undefined, undefined, undefined, undefined, undefined, undefined, token).finally(() => {
        // The durable ACK can precede provider preparation. Keep the private
        // parent capability alive until sendMessage either hands off to the
        // provider or rolls the accepted child row back.
        sessionOpConsumeDelegatedDispatchContinuation(sessionOperationContext, token);
    }), error => {
        sessionLog.error('Delegated dispatch failed after durable acceptance', {
            parentSessionId: parent.id,
            childSessionId: child.id,
            error: error instanceof Error ? error.message : String(error),
        });
        void sessionOpRecordDelegatedDispatchFailure(sessionOperationContext, child, error);
    });
}

export { sessionOpRecordDelegatedDispatchFailure as recordDelegatedDispatchFailure };
export { sessionOpSendDelegatedDispatch as sendDelegatedDispatch };
