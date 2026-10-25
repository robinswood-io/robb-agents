import type { SessionOperationContext } from '../operation-context.ts';
import type { SessionEvent } from '@craft-agent/shared/protocol';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import type { AutonomyFallbackIntent } from '../../autonomy-browser-fallback';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { DELTA_BATCH_INTERVAL_MS } from '../runtime-policy.ts';

/** Inject a host-owned channel fallback only into the exact live provider
 * turn, arming its tool-admission revocation before redirect() can emit a
 * synchronous follow-up tool. A rejected redirect restores the preceding
 * intent because no new fallback authority was delivered. */
function sessionOpRedirectAutomaticToolFallback(sessionOperationContext: SessionOperationContext, managed: ManagedSession, generation: number, intent: AutonomyFallbackIntent, prompt: string): boolean {
    const agent = managed.agent;
    if (!agent)
        return false;
    const binding = sessionOperationContext.state.runtimeToolAdmissionBindings.get(agent);
    if (!binding
        || binding.pendingRebind
        || binding.managed !== managed
        || binding.sessionId !== managed.id
        || binding.generation !== generation
        || sessionOperationContext.state.runtimeProcessingGenerations.get(agent) !== generation
        || managed.processingGeneration !== generation
        || !managed.isProcessing)
        return false;
    const previousIntent = binding.liveToolFallbackIntent;
    binding.liveToolFallbackIntent = intent;
    let delivered = false;
    try {
        delivered = agent.redirect(prompt);
        return delivered;
    }
    finally {
        if (!delivered && binding.liveToolFallbackIntent === intent) {
            binding.liveToolFallbackIntent = previousIntent;
        }
    }
}

function sessionOpSendEvent(sessionOperationContext: SessionOperationContext, event: SessionEvent, workspaceId?: string): void {
    if (!sessionOperationContext.state.eventSink) {
        sessionLog.warn('Cannot send event - no event sink');
        return;
    }
    if (!workspaceId) {
        sessionLog.warn(`Cannot send ${event.type} event - no workspaceId`);
        return;
    }
    sessionOperationContext.state.eventSink(RPC_CHANNELS.sessions.EVENT, { to: 'workspace', workspaceId }, event);
}

/**
 * Queue a text delta for batched sending (performance optimization)
 * Instead of sending 50+ IPC events per second, batches deltas and flushes every 50ms
 */
function sessionOpQueueDelta(sessionOperationContext: SessionOperationContext, sessionId: string, workspaceId: string, delta: string, turnId?: string): void {
    let existing = sessionOperationContext.state.pendingDeltas.get(sessionId);
    if (existing && existing.turnId !== turnId) {
        sessionOpFlushDelta(sessionOperationContext, sessionId, workspaceId);
        existing = undefined;
    }
    if (existing) {
        // Append to existing batch
        existing.delta += delta;
        // Keep the latest turnId (should be the same, but just in case)
        if (turnId)
            existing.turnId = turnId;
    }
    else {
        // Start new batch
        sessionOperationContext.state.pendingDeltas.set(sessionId, { delta, turnId });
    }
    // Schedule flush if not already scheduled
    if (!sessionOperationContext.state.deltaFlushTimers.has(sessionId)) {
        const timer = setTimeout(() => {
            sessionOpFlushDelta(sessionOperationContext, sessionId, workspaceId);
        }, DELTA_BATCH_INTERVAL_MS);
        sessionOperationContext.state.deltaFlushTimers.set(sessionId, timer);
    }
}

/**
 * Flush any pending deltas for a session (sends batched IPC event)
 * Called on timer or when streaming ends (text_complete)
 */
function sessionOpFlushDelta(sessionOperationContext: SessionOperationContext, sessionId: string, workspaceId: string): void {
    // Clear the timer
    const timer = sessionOperationContext.state.deltaFlushTimers.get(sessionId);
    if (timer) {
        clearTimeout(timer);
        sessionOperationContext.state.deltaFlushTimers.delete(sessionId);
    }
    // Send batched delta if any
    const pending = sessionOperationContext.state.pendingDeltas.get(sessionId);
    if (pending && pending.delta) {
        sessionOperationContext.owner["sendEvent"]({
            type: 'text_delta',
            sessionId,
            delta: pending.delta,
            turnId: pending.turnId
        }, workspaceId);
        sessionOperationContext.state.pendingDeltas.delete(sessionId);
    }
}

export { sessionOpRedirectAutomaticToolFallback as redirectAutomaticToolFallback };
export { sessionOpSendEvent as sendEvent };
export { sessionOpQueueDelta as queueDelta };
export { sessionOpFlushDelta as flushDelta };
