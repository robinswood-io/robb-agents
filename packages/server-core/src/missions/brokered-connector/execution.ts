import { capabilityOperationRequestHash } from "@craft-agent/shared/governance";
import { type MissionExecutionBinding } from "@craft-agent/shared/missions";
import type { ConnectorAuthorizationResult, PreparedConnectorInvocation } from "../../services/connector-execution-runtime.ts";
import type { MissionExecutionInput, MissionExecutionResult } from "../MissionRuntime.ts";
import type { BrokeredMissionConnectorExecutor } from '../BrokeredMissionConnectorExecutor.ts';
import { STATE_SCHEMA_VERSION, requirePack, connectorInvocation, idempotencyKey, resultProof } from './shared.ts';
import type { DurablePendingMissionConnectorApproval } from './shared.ts';

export async function prepare(transportOwner: BrokeredMissionConnectorExecutor, input: MissionExecutionInput): Promise<MissionExecutionBinding> {
    connectorInvocation(input);
    return { executorKind: 'connector-broker', executionId: idempotencyKey(input) };
}

export async function execute(transportOwner: BrokeredMissionConnectorExecutor, input: MissionExecutionInput, binding: MissionExecutionBinding): Promise<MissionExecutionResult> {
    const invocation = connectorInvocation(input);
    const expectedKey = idempotencyKey(input);
    if (binding.executorKind !== 'connector-broker' || binding.executionId !== expectedKey) {
        return transportOwner["failed"]('Mission connector binding mismatch', false);
    }
    let state = transportOwner["store"].read(input.mission.id, input.item.id);
    if (state && !transportOwner["matchesState"](state, input, expectedKey)
        && !(state.status === 'executed' && transportOwner["matchesCompletedIdentity"](state, input, expectedKey))) {
        return transportOwner["failed"]('Durable connector state does not match this Mission dispatch', true);
    }
    if (state?.status === 'executed')
        return transportOwner["submissionFromCompleted"](input, state);
    if (state?.status === 'denied')
        return transportOwner["failed"](state.failureReason ?? 'Connector approval denied', false);
    if (state?.status === 'compensation-required') {
        return transportOwner["failed"](state.failureReason ?? 'Provider reconciliation diverged; explicit compensation is required', true);
    }
    if (state?.status === 'executing') {
        const recovered = await transportOwner["recover"](input, state, invocation);
        if (recovered.result)
            return recovered.result;
        state = recovered.state;
    }
    const approvalExpired = (state?.status === 'waiting-approval'
        && !state.approval
        && Boolean(state.pendingApproval)
        && Date.parse(state.pendingApproval!.expiresAt) <= Date.parse(transportOwner["now"]())) || (state?.status === 'approved'
        && state.approval?.decision === 'approved'
        && Date.parse(state.approval.expiresAt) <= Date.parse(transportOwner["now"]()));
    if (state?.status === 'waiting-approval' && !state.approval && !approvalExpired) {
        return transportOwner["approvalResult"](state);
    }
    let prepared: PreparedConnectorInvocation;
    try {
        prepared = transportOwner["options"].runtime.prepare({
            pack: requirePack(invocation.pack),
            sessionId: binding.executionId,
            operationId: invocation.operationId,
            identity: {
                clientId: transportOwner["options"].clientId ?? 'robb-agents-mission-host',
                missionId: input.mission.id,
                nodeId: input.item.id,
                agentId: input.profile.id,
                actorId: transportOwner["options"].actorId,
            },
            autonomy: invocation.autonomy,
            resourceType: invocation.resourceType,
            ...(invocation.resourceId ? { resourceId: invocation.resourceId } : {}),
            payload: structuredClone(invocation.payload),
            idempotencyKey: expectedKey,
            compensation: invocation.compensation,
            requestedAt: approvalExpired ? transportOwner["now"]() : state?.requestedAt ?? transportOwner["now"](),
        });
    }
    catch (error) {
        return transportOwner["failed"](`Connector preparation failed: ${transportOwner["errorMessage"](error)}`, false);
    }
    const requestHash = capabilityOperationRequestHash(prepared.request);
    if (!state) {
        const createdAt = prepared.request.requestedAt;
        state = transportOwner["store"].initialize({
            schemaVersion: STATE_SCHEMA_VERSION,
            revision: 1,
            workspaceId: transportOwner["options"].workspaceId,
            missionId: input.mission.id,
            workItemId: input.item.id,
            dispatchId: input.dispatchId,
            idempotencyKey: expectedKey,
            requestHash,
            requestedAt: createdAt,
            operationId: invocation.operationId,
            compensation: invocation.compensation,
            status: 'prepared',
            updatedAt: transportOwner["now"](),
        });
        if (state.requestedAt !== createdAt) {
            return transportOwner["failed"]('Connector execution was initialized concurrently; retry recovery', false);
        }
    }
    else if (approvalExpired) {
        state = transportOwner["store"].update(input.mission.id, input.item.id, state.revision, (current) => ({
            ...current,
            status: 'prepared',
            requestHash,
            requestedAt: prepared.request.requestedAt,
            pendingApproval: undefined,
            approval: undefined,
            updatedAt: transportOwner["now"](),
        }));
    }
    if (state.requestHash !== requestHash) {
        return transportOwner["failed"]('Connector request changed after durable preparation; policy or registry drifted', false);
    }
    let authorization: ConnectorAuthorizationResult;
    try {
        authorization = transportOwner["options"].runtime.authorize(prepared.preparationId);
        if (authorization.status === 'approval-required' && state.approval?.decision === 'approved') {
            if (!transportOwner["verifyApproval"](state.approval) || state.approval.requestHash !== authorization.requestHash) {
                return transportOwner["failed"]('Durable connector approval is invalid or bound to another request', false);
            }
            const resolved = transportOwner["options"].runtime.resolveApproval(authorization.approval.approvalId, 'approved', state.approval.resolvedBy);
            if (resolved.status !== 'approved')
                return transportOwner["failed"](`Capability approval failed: ${resolved.reason}`, false);
            authorization = transportOwner["options"].runtime.authorize(prepared.preparationId, authorization.approval.approvalId);
        }
    }
    catch (error) {
        return transportOwner["failed"](`Connector authorization failed: ${transportOwner["errorMessage"](error)}`, false);
    }
    if (authorization.status === 'approval-required') {
        if (!authorization.approval.approvalContext) {
            return transportOwner["failed"]('Connector approval has no value-free consent context', false);
        }
        const unsignedPending: Omit<DurablePendingMissionConnectorApproval, 'bindingSignature'> = {
            missionId: input.mission.id,
            workItemId: input.item.id,
            approvalId: authorization.approval.approvalId,
            requestHash: authorization.requestHash,
            operationId: authorization.approval.operationId,
            risk: authorization.approval.risk,
            approvalContext: structuredClone(authorization.approval.approvalContext),
            expiresAt: authorization.approval.expiresAt,
        };
        state = transportOwner["store"].update(input.mission.id, input.item.id, state.revision, (current) => ({
            ...current,
            status: 'waiting-approval',
            pendingApproval: {
                ...unsignedPending,
                bindingSignature: transportOwner["signPendingApproval"](unsignedPending),
            },
            updatedAt: transportOwner["now"](),
        }));
        return transportOwner["approvalResult"](state);
    }
    if (authorization.status === 'denied') {
        state = transportOwner["store"].update(input.mission.id, input.item.id, state.revision, (current) => ({
            ...current,
            status: 'denied',
            failureReason: `${authorization.code}: ${authorization.reason}`,
            updatedAt: transportOwner["now"](),
        }));
        return transportOwner["failed"](state.failureReason!, false);
    }
    state = transportOwner["store"].update(input.mission.id, input.item.id, state.revision, (current) => ({
        ...current,
        status: 'executing',
        pendingApproval: undefined,
        updatedAt: transportOwner["now"](),
    }));
    try {
        const executed = await transportOwner["options"].runtime.invokeAuthorized(prepared.preparationId);
        return transportOwner["complete"](input, state, resultProof(executed.output));
    }
    catch (error) {
        // The durable executing state is deliberately retained. A later attempt
        // must reconcile by idempotency key before it may decide whether to replay.
        return transportOwner["failed"](`Connector outcome requires recovery reconciliation: ${transportOwner["errorMessage"](error)}`, true);
    }
}
