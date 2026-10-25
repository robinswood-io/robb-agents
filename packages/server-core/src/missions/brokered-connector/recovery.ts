import { type MissionConnectorInvocation } from "@craft-agent/shared/missions";
import type { MissionExecutionInput, MissionExecutionResult } from "../MissionRuntime.ts";
import type { BrokeredMissionConnectorExecutor } from '../BrokeredMissionConnectorExecutor.ts';
import { connectorInvocation } from './shared.ts';
import type { MissionConnectorRecoveryResult, ConnectorExecutionState } from './shared.ts';

export async function recover(transportOwner: BrokeredMissionConnectorExecutor, input: MissionExecutionInput, state: ConnectorExecutionState, invocation: MissionConnectorInvocation): Promise<{
    state: ConnectorExecutionState;
    result?: MissionExecutionResult;
}> {
    let observation: MissionConnectorRecoveryResult;
    try {
        observation = await transportOwner["options"].recoverMutation({
            workspaceId: transportOwner["options"].workspaceId,
            missionId: input.mission.id,
            workItemId: input.item.id,
            requestHash: state.requestHash,
            idempotencyKey: state.idempotencyKey,
            invocation,
        });
    }
    catch (error) {
        return { state, result: transportOwner["failed"](`Recovery reconciliation unavailable: ${transportOwner["errorMessage"](error)}`, true) };
    }
    if (observation.status === 'confirmed') {
        return { state, result: transportOwner["complete"](input, state, observation.proof) };
    }
    if (observation.status === 'absent') {
        const approvalValid = state.approval?.decision === 'approved' && transportOwner["verifyApproval"](state.approval)
            && Date.parse(state.approval.expiresAt) > Date.parse(transportOwner["now"]());
        const next = transportOwner["store"].update(input.mission.id, input.item.id, state.revision, (current) => ({
            ...current,
            status: approvalValid ? 'approved' : 'prepared',
            approval: approvalValid ? current.approval : undefined,
            updatedAt: transportOwner["now"](),
        }));
        return { state: next };
    }
    const reason = observation.status === 'diverged'
        ? `Provider reconciliation diverged: ${observation.reason}`
        : `Provider outcome is unknown: ${observation.reason}`;
    const next = transportOwner["store"].update(input.mission.id, input.item.id, state.revision, (current) => ({
        ...current,
        status: 'compensation-required',
        failureReason: `${reason}; compensation=${invocation.compensation.strategy}`,
        updatedAt: transportOwner["now"](),
    }));
    return { state: next, result: transportOwner["failed"](next.failureReason!, true) };
}

export function matchesState(transportOwner: BrokeredMissionConnectorExecutor, state: ConnectorExecutionState, input: MissionExecutionInput, key: string): boolean {
    return state.workspaceId === transportOwner["options"].workspaceId
        && state.missionId === input.mission.id
        && state.workItemId === input.item.id
        && state.dispatchId === input.dispatchId
        && state.idempotencyKey === key
        && state.operationId === connectorInvocation(input).operationId;
}

/**
   * A journaled replan may invalidate downstream semantics while keeping the
   * exact connector invocation. Reusing a reconciled proof under the same
   * idempotency key is safe across a new Mission dispatch and, critically,
   * avoids issuing the external mutation twice.
   */
export function matchesCompletedIdentity(transportOwner: BrokeredMissionConnectorExecutor, state: ConnectorExecutionState, input: MissionExecutionInput, key: string): boolean {
    return state.workspaceId === transportOwner["options"].workspaceId
        && state.missionId === input.mission.id
        && state.workItemId === input.item.id
        && state.idempotencyKey === key
        && state.operationId === connectorInvocation(input).operationId;
}

export function compensationRequirement(transportOwner: BrokeredMissionConnectorExecutor, missionId: string, workItemId: string): {
    reason: string;
    compensation: MissionConnectorInvocation['compensation'];
} | null {
    const state = transportOwner["store"].read(missionId, workItemId);
    if (state?.status !== 'compensation-required')
        return null;
    // The invocation remains in the signed Mission journal; the state file
    // intentionally stores no raw payload or provider response.
    return {
        reason: state.failureReason ?? 'Provider reconciliation diverged',
        compensation: state.compensation,
    };
}
