import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalOperationValue } from "@craft-agent/shared/governance";
import type { MissionExecutionResult } from "../MissionRuntime.ts";
import type { BrokeredMissionConnectorExecutor } from '../BrokeredMissionConnectorExecutor.ts';
import type { DurableApprovalDecision, PendingMissionConnectorApproval, DurablePendingMissionConnectorApproval, ConnectorExecutionState } from './shared.ts';

export function resolveApproval(transportOwner: BrokeredMissionConnectorExecutor, input: {
    missionId: string;
    workItemId: string;
    approvalId: string;
    requestHash: string;
    decision: 'approved' | 'denied';
    resolvedBy: string;
}): PendingMissionConnectorApproval {
    if (!input.resolvedBy.trim())
        throw new Error('Approver identity is required');
    let state = transportOwner["store"].read(input.missionId, input.workItemId);
    const pending = state?.pendingApproval;
    if (state?.approval && pending) {
        if (!transportOwner["verifyPendingApproval"](pending)) {
            throw new Error('Connector approval consent context is not bound to its durable request');
        }
        if (!transportOwner["verifyApproval"](state.approval)
            || state.approval.approvalId !== input.approvalId
            || state.approval.requestHash !== input.requestHash
            || state.approval.decision !== input.decision
            || state.approval.resolvedBy !== input.resolvedBy) {
            throw new Error('Connector approval was already resolved with another durable decision');
        }
        return transportOwner["publicPendingApproval"](pending);
    }
    if (!state || state.status !== 'waiting-approval' || !pending)
        throw new Error('Connector approval is not pending');
    if (!transportOwner["verifyPendingApproval"](pending)) {
        throw new Error('Connector approval consent context is not bound to its durable request');
    }
    if (pending.approvalId !== input.approvalId || pending.requestHash !== input.requestHash) {
        throw new Error('Connector approval does not match the durable request');
    }
    if (Date.parse(pending.expiresAt) <= Date.parse(transportOwner["now"]()))
        throw new Error('Connector approval expired');
    const unsigned = {
        approvalId: input.approvalId,
        requestHash: input.requestHash,
        decision: input.decision,
        resolvedBy: input.resolvedBy,
        resolvedAt: transportOwner["now"](),
        expiresAt: pending.expiresAt,
    } as const;
    const approval: DurableApprovalDecision = { ...unsigned, signature: transportOwner["signApproval"](unsigned) };
    state = transportOwner["store"].update(input.missionId, input.workItemId, state.revision, (current) => ({
        ...current,
        status: input.decision === 'approved' ? 'approved' : 'denied',
        approval,
        failureReason: input.decision === 'denied' ? `Connector approval denied by ${input.resolvedBy}` : undefined,
        updatedAt: transportOwner["now"](),
    }));
    return transportOwner["publicPendingApproval"](pending);
}

export function pendingApproval(transportOwner: BrokeredMissionConnectorExecutor, missionId: string, workItemId: string): PendingMissionConnectorApproval | null {
    const state = transportOwner["store"].read(missionId, workItemId);
    if (state?.status !== 'waiting-approval' || !state.pendingApproval)
        return null;
    if (!transportOwner["verifyPendingApproval"](state.pendingApproval)) {
        throw new Error('Connector approval consent context is not bound to its durable request');
    }
    return transportOwner["publicPendingApproval"](state.pendingApproval);
}

export function resolvedApproval(transportOwner: BrokeredMissionConnectorExecutor, missionId: string, workItemId: string): 'approved' | 'denied' | null {
    const approval = transportOwner["store"].read(missionId, workItemId)?.approval;
    return approval && transportOwner["verifyApproval"](approval) ? approval.decision : null;
}

export function approvalExpired(transportOwner: BrokeredMissionConnectorExecutor, missionId: string, workItemId: string): boolean {
    const state = transportOwner["store"].read(missionId, workItemId);
    if (state?.status === 'waiting-approval' && state.pendingApproval
        && !transportOwner["verifyPendingApproval"](state.pendingApproval)) {
        throw new Error('Connector approval consent context is not bound to its durable request');
    }
    return state?.status === 'waiting-approval'
        && !state.approval
        && Boolean(state.pendingApproval)
        && Date.parse(state.pendingApproval!.expiresAt) <= Date.parse(transportOwner["now"]());
}

export function approvalResult(transportOwner: BrokeredMissionConnectorExecutor, state: ConnectorExecutionState): MissionExecutionResult {
    const pending = state.pendingApproval;
    if (!pending)
        return transportOwner["failed"]('Durable approval request is unavailable', false);
    if (!transportOwner["verifyPendingApproval"](pending)) {
        return transportOwner["failed"]('Connector approval consent context is not bound to its durable request', false);
    }
    return {
        status: 'approval-required',
        approvalId: pending.approvalId,
        requestHash: pending.requestHash,
        expiresAt: pending.expiresAt,
        operationId: pending.operationId,
    };
}

export function signApproval(transportOwner: BrokeredMissionConnectorExecutor, value: Omit<DurableApprovalDecision, 'signature'>): string {
    return createHmac('sha256', transportOwner["approvalKey"])
        .update(canonicalOperationValue(value), 'utf8')
        .digest('base64url');
}

export function signPendingApproval(transportOwner: BrokeredMissionConnectorExecutor, value: Omit<DurablePendingMissionConnectorApproval, 'bindingSignature'>): string {
    return createHmac('sha256', transportOwner["approvalKey"])
        .update(canonicalOperationValue(value), 'utf8')
        .digest('base64url');
}

export function verifyPendingApproval(transportOwner: BrokeredMissionConnectorExecutor, value: DurablePendingMissionConnectorApproval): boolean {
    const { bindingSignature, ...unsigned } = value;
    const actual = Buffer.from(bindingSignature, 'base64url');
    const expected = Buffer.from(transportOwner["signPendingApproval"](unsigned), 'base64url');
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export function publicPendingApproval(transportOwner: BrokeredMissionConnectorExecutor, pending: DurablePendingMissionConnectorApproval): PendingMissionConnectorApproval {
    const { bindingSignature: _bindingSignature, ...value } = pending;
    return {
        workspaceId: transportOwner["options"].workspaceId,
        ...structuredClone(value),
    };
}

export function verifyApproval(transportOwner: BrokeredMissionConnectorExecutor, value: DurableApprovalDecision): boolean {
    const { signature, ...unsigned } = value;
    const actual = Buffer.from(signature, 'base64url');
    const expected = Buffer.from(transportOwner["signApproval"](unsigned), 'base64url');
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}
