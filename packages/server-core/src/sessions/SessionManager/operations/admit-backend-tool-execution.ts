import type { SessionOperationContext } from '../operation-context.ts';
import { assertMissionDispatchWorkingDirectory } from '../policy.ts';
import { yoloHumanHandoffBlock } from '@craft-agent/shared/agent';
import type { ManagedSession } from '../managed-session.ts';
import type { AgentInstance } from '../runtime-types.ts';
import { isManagedSessionYolo as sessionOpIsManagedSessionYolo } from './is-managed-session-yolo.ts';

/**
 * Establish a durable, host-owned receipt before any turn's tool may execute.
 * The backend awaits this from PreToolUse before acknowledging the
 * SDK/subprocess, closing the crash window where an external mutation could
 * happen before its ordinary tool_start event reached durable storage.
 */
async function sessionOpAdmitBackendToolExecution(sessionOperationContext: SessionOperationContext, managed: ManagedSession, runtimeAgent: AgentInstance, request: {
    toolUseId?: string;
    toolName: string;
    toolInput: Record<string, unknown>;
}): Promise<void> {
    const handoffBlock = sessionOpIsManagedSessionYolo(sessionOperationContext, managed)
        ? yoloHumanHandoffBlock(request.toolName, 'allow-all', 'allow-in-execute') : undefined;
    if (handoffBlock)
        throw new Error(handoffBlock);
    // Backend-wide point-of-use barrier: provider-native and MCP tools must
    // validate the sealed Mission envelope before admission or any effect.
    assertMissionDispatchWorkingDirectory(managed);
    await sessionOperationContext.owner["assertSpecializedMissionCapabilities"](managed, request.toolName, request.toolInput);
    await sessionOperationContext.owner["durablyRecordAutomaticRecoveryToolAdmission"](managed, runtimeAgent, request);
}

export { sessionOpAdmitBackendToolExecution as admitBackendToolExecution };
