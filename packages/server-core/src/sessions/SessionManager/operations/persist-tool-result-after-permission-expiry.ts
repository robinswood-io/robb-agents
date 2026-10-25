import type { SessionOperationContext } from '../operation-context.ts';
import { randomUUID } from 'node:crypto';
import type { AutonomyEvent } from '@craft-agent/core';
import type { AgentEvent } from '@craft-agent/shared/agent';
import { captureProviderContextBaseline } from '../../context-compaction';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import type { AgentInstance } from '../runtime-types.ts';
import { durablyRecordAutomaticRecoveryToolAdmissionLocked as sessionOpDurablyRecordAutomaticRecoveryToolAdmissionLocked } from './durably-record-automatic-recovery-tool-admission-locked.ts';

function sessionOpRecordAutonomyEvent(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Omit<AutonomyEvent, 'id' | 'timestamp'>): void {
    const recorded: AutonomyEvent = { id: randomUUID(), timestamp: Date.now(), ...event };
    managed.autonomyEvents = [...(managed.autonomyEvents ?? []), recorded].slice(-50);
    sessionOperationContext.owner["persistSession"](managed);
    sessionOperationContext.owner["sendEvent"]({ type: 'autonomy_event', sessionId: managed.id, event: recorded }, managed.workspace.id);
}

async function sessionOpDurablyRecordAutomaticRecoveryToolAdmission(sessionOperationContext: SessionOperationContext, managed: ManagedSession, runtimeAgent: AgentInstance, request: {
    toolUseId?: string;
    toolName: string;
    toolInput: Record<string, unknown>;
}): Promise<void> {
    const previous = sessionOperationContext.state.toolAdmissionTransactions.get(managed) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => { }).then(() => turn);
    sessionOperationContext.state.toolAdmissionTransactions.set(managed, tail);
    await previous.catch(() => { });
    try {
        try {
            await sessionOpDurablyRecordAutomaticRecoveryToolAdmissionLocked(sessionOperationContext, managed, runtimeAgent, request);
        }
        catch (error) {
            // The provider receives one fixed fail-closed message, but retain the
            // host-side reason so a boundary/collision regression is diagnosable
            // without weakening the serialized admission contract or logging tool
            // payloads (which may contain secrets).
            sessionLog.warn('Durable tool admission rejected before execution', {
                sessionId: managed.id,
                toolName: request.toolName,
                toolUseId: request.toolUseId,
                generation: sessionOperationContext.state.runtimeProcessingGenerations.get(runtimeAgent),
                recoveryCause: sessionOperationContext.state.runtimeToolAdmissionBindings.get(runtimeAgent)?.automaticRecovery?.cause,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
    finally {
        release();
        if (sessionOperationContext.state.toolAdmissionTransactions.get(managed) === tail) {
            sessionOperationContext.state.toolAdmissionTransactions.delete(managed);
        }
    }
}

/** Replace the post-compaction wait marker with the first provider-scale
 * context measurement and flush it before a later turn can make another
 * compaction decision. */
async function sessionOpCaptureCompactionProviderBaseline(sessionOperationContext: SessionOperationContext, managed: ManagedSession, contextTokens: number | undefined): Promise<void> {
    const previous = managed.contextCompactionAttempt;
    const captured = captureProviderContextBaseline(previous, contextTokens);
    if (!captured || captured === previous)
        return;
    managed.contextCompactionAttempt = captured;
    sessionOperationContext.owner["persistSession"](managed);
    try {
        await sessionOperationContext.owner.flushSession(managed.id);
    }
    catch (error) {
        // The already-flushed wait marker remains fail-closed across a crash;
        // keep the completed provider turn alive and let the persistence queue
        // retry the enriched baseline instead of turning a disk hiccup into an
        // automatic-recovery loop.
        sessionLog.warn('Could not synchronously flush provider context baseline', {
            sessionId: managed.id,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/** Preserve execution truth for work that was already authorized before a
 * sibling permission expired, without running the normal recovery/evidence
 * side effects of an event from the now-closed generation. */
function sessionOpPersistToolResultAfterPermissionExpiry(sessionOperationContext: SessionOperationContext, managed: ManagedSession, event: Extract<AgentEvent, {
    type: 'tool_result';
}>, deniedToolUseIds: Set<string>): boolean {
    if (deniedToolUseIds.has(event.toolUseId))
        return false;
    const message = managed.messages.find(candidate => (candidate.role === 'tool' && candidate.toolUseId === event.toolUseId));
    if (!message)
        return false;
    const maxPersistedResultChars = 200000;
    const rawResult = event.result ?? '';
    const result = rawResult.length > maxPersistedResultChars
        ? `${rawResult.slice(0, maxPersistedResultChars)}\n\n[Truncated for storage: ${rawResult.length.toLocaleString()} chars total]`
        : rawResult;
    const executed = event.executed !== false;
    const isError = executed
        && (event.isError === true || /^\s*(\[ERROR\]|Error:|error:)/.test(result));
    const changed = message.toolResult !== result
        || message.toolExecuted !== executed
        || message.isError !== isError
        || message.toolStatus !== (isError ? 'error' : 'completed');
    message.toolResult = result;
    message.toolStatus = isError ? 'error' : 'completed';
    message.toolExecuted = executed;
    message.isError = isError;
    if (event.checkpoint)
        message.toolCheckpoint = event.checkpoint;
    else if (executed)
        delete message.toolCheckpoint;
    if (!message.parentToolUseId && event.parentToolUseId) {
        message.parentToolUseId = event.parentToolUseId;
    }
    if (!changed)
        return true;
    sessionOperationContext.owner["persistSession"](managed);
    sessionOperationContext.owner["sendEvent"]({
        type: 'tool_result',
        sessionId: managed.id,
        toolUseId: event.toolUseId,
        toolName: event.toolName ?? message.toolName ?? 'unknown',
        result,
        turnId: event.turnId,
        parentToolUseId: message.parentToolUseId,
        isError,
        executed,
        ...(event.checkpoint ? { checkpoint: event.checkpoint } : {}),
        timestamp: message.timestamp,
    }, managed.workspace.id);
    return true;
}

export { sessionOpRecordAutonomyEvent as recordAutonomyEvent };
export { sessionOpDurablyRecordAutomaticRecoveryToolAdmission as durablyRecordAutomaticRecoveryToolAdmission };
export { sessionOpCaptureCompactionProviderBaseline as captureCompactionProviderBaseline };
export { sessionOpPersistToolResultAfterPermissionExpiry as persistToolResultAfterPermissionExpiry };
