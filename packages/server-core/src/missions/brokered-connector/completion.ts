import { omitUndefined } from '@craft-agent/shared/utils/json';
import { canonicalOperationValue, parseSignedExecutionProof, type SignedExecutionProof } from "@craft-agent/shared/governance";
import type { MissionExecutionInput, MissionExecutionResult } from "../MissionRuntime.ts";
import type { BrokeredMissionConnectorExecutor } from '../BrokeredMissionConnectorExecutor.ts';
import { RECEIPT_SCHEMA_VERSION, connectorInvocation, bindingFor } from './shared.ts';
import type { ConnectorExecutionState, MutationReceipt } from './shared.ts';

export function complete(transportOwner: BrokeredMissionConnectorExecutor, input: MissionExecutionInput, state: ConnectorExecutionState, proofValue: SignedExecutionProof): MissionExecutionResult {
    const proof = parseSignedExecutionProof(proofValue);
    const verification = transportOwner["options"].verifyExecutionProof(proof, {
        ...bindingFor(input),
        workspaceId: transportOwner["options"].workspaceId,
    });
    if (!verification.allowed) {
        const reason = `${verification.code}: ${verification.reason}`;
        const next = transportOwner["store"].update(input.mission.id, input.item.id, state.revision, (current) => ({
            ...current,
            status: 'compensation-required',
            proof,
            failureReason: `${reason}; compensation=${connectorInvocation(input).compensation.strategy}`,
            updatedAt: transportOwner["now"](),
        }));
        return transportOwner["failed"](next.failureReason!, true);
    }
    const invocation = connectorInvocation(input);
    const receipt: MutationReceipt = {
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        kind: 'brokered-connector-mutation',
        workspaceId: transportOwner["options"].workspaceId,
        missionId: input.mission.id,
        workItemId: input.item.id,
        connectorPack: invocation.pack,
        operationId: invocation.operationId,
        requestHash: state.requestHash,
        idempotencyKey: state.idempotencyKey,
        compensation: invocation.compensation,
        proof,
        issuedAt: transportOwner["now"](),
    };
    const receiptUri = transportOwner["store"].writeReceipt(input.mission.id, input.item.id, receipt);
    const completed = transportOwner["store"].update(input.mission.id, input.item.id, state.revision, (current) => (omitUndefined<ConnectorExecutionState>({
        ...current,
        status: 'executed',
        proof,
        receiptUri,
        failureReason: undefined,
        updatedAt: transportOwner["now"](),
    })));
    return transportOwner["submissionFromCompleted"](input, completed);
}

export function submissionFromCompleted(transportOwner: BrokeredMissionConnectorExecutor, input: MissionExecutionInput, state: ConnectorExecutionState): MissionExecutionResult {
    if (!state.proof || !state.receiptUri)
        return transportOwner["failed"]('Completed connector state is missing its proof receipt', true);
    const expectedReceipt = `missions/${input.mission.id}/connector-executions/${input.item.id}.receipt.json`;
    if (state.receiptUri !== expectedReceipt)
        return transportOwner["failed"]('Completed connector receipt path is not canonical', true);
    const verification = transportOwner["options"].verifyExecutionProof(state.proof, {
        workspaceId: transportOwner["options"].workspaceId,
        missionId: input.mission.id,
        nodeId: input.item.id,
        idempotencyKey: state.idempotencyKey,
    });
    if (!verification.allowed)
        return transportOwner["failed"](`Stored connector proof rejected: ${verification.code}`, true);
    const invocation = connectorInvocation(input);
    const receipt = transportOwner["store"].readReceipt(input.mission.id, input.item.id);
    if (!receipt)
        return transportOwner["failed"]('Completed connector proof receipt is unavailable', true);
    if (receipt.requestHash !== state.requestHash
        || receipt.idempotencyKey !== state.idempotencyKey
        || receipt.connectorPack !== invocation.pack
        || receipt.operationId !== invocation.operationId
        || canonicalOperationValue(receipt.compensation) !== canonicalOperationValue(invocation.compensation)
        || canonicalOperationValue(receipt.proof) !== canonicalOperationValue(state.proof)) {
        return transportOwner["failed"]('Completed connector proof receipt does not match durable execution state', true);
    }
    return {
        status: 'submission',
        submission: {
            summary: `Host broker executed and reconciled ${invocation.pack}/${invocation.operationId}.`,
            outputRefs: [state.receiptUri],
            evidence: [{
                    requirementId: invocation.receiptRequirementId,
                    uri: state.receiptUri,
                    kind: 'receipt',
                    description: 'Host-issued brokered connector execution and reconciliation receipt',
                }],
        },
    };
}
