import { createHash } from "node:crypto";
import { constants, ftruncateSync, fsyncSync, readFileSync, writeSync } from "node:fs";
import { connectorPackTemplates, type PriorityConnectorPack } from "@craft-agent/shared/connectors";
import { canonicalOperationValue, OperationApprovalContextSchema, parseSignedExecutionProof, type ExecutionProofVerificationDecision, type OperationApprovalContext, type OperationRiskLevel, type SignedExecutionProof, type TaskExecutionProofBinding } from "@craft-agent/shared/governance";
import { MISSION_ID_RE, openConfinedRegularFile, unlinkConfinedRegularFile, type ConfinedRegularFile, type MissionConnectorInvocation, type MissionExecutionBinding } from "@craft-agent/shared/missions";
import type { ConnectorExecutionRuntime } from "../../services/connector-execution-runtime.ts";
import type { MissionExecutionInput, MissionExecutionResult, MissionWorkExecutor } from "../MissionRuntime.ts";
import type { BrokeredMissionConnectorExecutor } from '../BrokeredMissionConnectorExecutor.ts';

export const STATE_SCHEMA_VERSION = 1 as const;

export const RECEIPT_SCHEMA_VERSION = 1 as const;

export const LOCK_STALE_MS = 5 * 60 * 1000;

export type ConnectorChokePoint = Pick<ConnectorExecutionRuntime, 'prepare' | 'authorize' | 'invokeAuthorized' | 'resolveApproval'>;

export type MissionConnectorRecoveryResult = {
    status: 'confirmed';
    proof: SignedExecutionProof;
}
/** Authoritative negative lookup for this exact idempotency key; never an eventual-consistency miss. */
 | {
    status: 'absent';
    observedAt: string;
} | {
    status: 'diverged';
    reason: string;
    observedAt: string;
} | {
    status: 'unknown';
    reason: string;
};

export interface MissionConnectorRecoveryRequest {
    workspaceId: string;
    missionId: string;
    workItemId: string;
    requestHash: string;
    idempotencyKey: string;
    invocation: MissionConnectorInvocation;
}

export interface DurableApprovalDecision {
    approvalId: string;
    requestHash: string;
    decision: 'approved' | 'denied';
    resolvedBy: string;
    resolvedAt: string;
    expiresAt: string;
    signature: string;
}

export interface PendingMissionConnectorApproval {
    workspaceId: string;
    missionId: string;
    workItemId: string;
    approvalId: string;
    requestHash: string;
    operationId: string;
    risk: OperationRiskLevel;
    approvalContext: OperationApprovalContext;
    expiresAt: string;
}

export interface DurablePendingMissionConnectorApproval extends Omit<PendingMissionConnectorApproval, 'workspaceId'> {
    /** HMAC over requestHash plus every value-free field shown to the approver. */
    bindingSignature: string;
}

export interface ConnectorExecutionState {
    schemaVersion: typeof STATE_SCHEMA_VERSION;
    revision: number;
    workspaceId: string;
    missionId: string;
    workItemId: string;
    dispatchId: string;
    idempotencyKey: string;
    requestHash: string;
    requestedAt: string;
    operationId: string;
    compensation: MissionConnectorInvocation['compensation'];
    status: 'prepared' | 'waiting-approval' | 'approved' | 'executing' | 'executed' | 'denied' | 'compensation-required';
    pendingApproval?: DurablePendingMissionConnectorApproval;
    approval?: DurableApprovalDecision;
    proof?: SignedExecutionProof;
    receiptUri?: string;
    failureReason?: string;
    updatedAt: string;
}

export interface MutationReceipt {
    schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
    kind: 'brokered-connector-mutation';
    workspaceId: string;
    missionId: string;
    workItemId: string;
    connectorPack: string;
    operationId: string;
    requestHash: string;
    idempotencyKey: string;
    compensation: MissionConnectorInvocation['compensation'];
    proof: SignedExecutionProof;
    issuedAt: string;
}

export interface BrokeredMissionConnectorExecutorOptions {
    workspaceId: string;
    workspaceRoot: string;
    runtime: ConnectorChokePoint;
    /** Human/service actor on whose behalf the host requests the capability. */
    actorId: string;
    approvalSigningKey: string | Uint8Array;
    verifyExecutionProof: (proof: SignedExecutionProof, binding: TaskExecutionProofBinding) => ExecutionProofVerificationDecision;
    /** Provider lookup by idempotency key. It must never mutate provider state. */
    recoverMutation: (request: MissionConnectorRecoveryRequest) => Promise<MissionConnectorRecoveryResult>;
    clientId?: string;
    now?: () => string;
}

export function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String((error as {
            code?: unknown;
        }).code)
        : undefined;
}

export function processAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return errorCode(error) !== 'ESRCH';
    }
}

export function assertStorageSlug(label: 'mission' | 'work item', value: string): void {
    if (!MISSION_ID_RE.test(value))
        throw new Error(`Invalid ${label} id "${value}"`);
}

export function readConfinedJson(handle: ConfinedRegularFile, label: string): unknown {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(handle.descriptor, 'utf8'));
    }
    catch (error) {
        throw new Error(`${label} is invalid`, { cause: error });
    }
    handle.assertStillBound();
    return value;
}

export function writeConfinedJson(handle: ConfinedRegularFile, value: unknown, options: {
    truncate?: boolean;
} = {}): void {
    const payload = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    handle.assertStillBound();
    if (options.truncate === true)
        ftruncateSync(handle.descriptor, 0);
    let offset = 0;
    while (offset < payload.byteLength) {
        const written = writeSync(handle.descriptor, payload, offset, payload.byteLength - offset, offset);
        if (written <= 0)
            throw new Error(`Failed to make progress writing confined file: ${handle.path}`);
        offset += written;
    }
    fsyncSync(handle.descriptor);
    handle.assertStillBound();
}

export function removeStaleLock(workspaceRoot: string, path: string): boolean {
    let handle: ConfinedRegularFile;
    try {
        handle = openConfinedRegularFile(workspaceRoot, path, { flags: constants.O_RDONLY });
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return true;
        throw error;
    }
    try {
        let ownerDead = false;
        try {
            const value = readConfinedJson(handle, 'Mission connector state lock') as {
                pid?: unknown;
            };
            ownerDead = typeof value.pid === 'number' && !processAlive(value.pid);
        }
        catch { /* Lock age is the fallback proof. */ }
        handle.assertStillBound();
        if (!ownerDead && Date.now() - handle.initialStat.mtimeMs <= LOCK_STALE_MS)
            return false;
        unlinkConfinedRegularFile(handle);
        return true;
    }
    finally {
        handle.close();
    }
}

export function withLock<T>(workspaceRoot: string, path: string, operation: (lock: ConfinedRegularFile) => T): T {
    let handle: ConfinedRegularFile | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            handle = openConfinedRegularFile(workspaceRoot, path, {
                flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
                mode: 0o600,
                allowCreate: true,
            });
            break;
        }
        catch (error) {
            if (errorCode(error) !== 'EEXIST')
                throw error;
            if (removeStaleLock(workspaceRoot, path))
                continue;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        }
    }
    if (handle === undefined)
        throw new Error('Mission connector state lock is unavailable');
    try {
        writeConfinedJson(handle, { pid: process.pid, at: new Date().toISOString() });
        return operation(handle);
    }
    finally {
        try {
            unlinkConfinedRegularFile(handle);
        }
        catch (error) {
            if (errorCode(error) !== 'ENOENT')
                throw error;
        }
        finally {
            handle.close();
        }
    }
}

export function assertState(value: unknown): ConnectorExecutionState {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Mission connector state is invalid');
    const state = value as Partial<ConnectorExecutionState>;
    if (state.schemaVersion !== STATE_SCHEMA_VERSION
        || !Number.isInteger(state.revision) || Number(state.revision) < 1
        || typeof state.workspaceId !== 'string'
        || typeof state.missionId !== 'string' || !MISSION_ID_RE.test(state.missionId)
        || typeof state.workItemId !== 'string' || !MISSION_ID_RE.test(state.workItemId)
        || typeof state.dispatchId !== 'string'
        || typeof state.idempotencyKey !== 'string'
        || !/^[a-f0-9]{64}$/.test(String(state.requestHash))
        || typeof state.requestedAt !== 'string' || !Number.isFinite(Date.parse(state.requestedAt))
        || typeof state.operationId !== 'string'
        || !state.compensation || typeof state.compensation !== 'object'
        || !['prepared', 'waiting-approval', 'approved', 'executing', 'executed', 'denied', 'compensation-required'].includes(String(state.status))
        || typeof state.updatedAt !== 'string' || !Number.isFinite(Date.parse(state.updatedAt))) {
        throw new Error('Mission connector state is invalid');
    }
    if (state.pendingApproval && (typeof state.pendingApproval.missionId !== 'string' || !MISSION_ID_RE.test(state.pendingApproval.missionId)
        || typeof state.pendingApproval.workItemId !== 'string' || !MISSION_ID_RE.test(state.pendingApproval.workItemId)
        || typeof state.pendingApproval.approvalId !== 'string'
        || !/^[a-f0-9]{64}$/.test(state.pendingApproval.requestHash)
        || typeof state.pendingApproval.operationId !== 'string'
        || !['R0', 'R1', 'W1', 'W2', 'W3'].includes(state.pendingApproval.risk)
        || !OperationApprovalContextSchema.safeParse(state.pendingApproval.approvalContext).success
        || !Number.isFinite(Date.parse(state.pendingApproval.expiresAt))
        || typeof state.pendingApproval.bindingSignature !== 'string'))
        throw new Error('Mission connector pending approval is invalid');
    if (state.approval && (typeof state.approval.approvalId !== 'string'
        || !/^[a-f0-9]{64}$/.test(state.approval.requestHash)
        || !['approved', 'denied'].includes(state.approval.decision)
        || typeof state.approval.resolvedBy !== 'string'
        || !Number.isFinite(Date.parse(state.approval.resolvedAt))
        || !Number.isFinite(Date.parse(state.approval.expiresAt))
        || typeof state.approval.signature !== 'string'))
        throw new Error('Mission connector approval decision is invalid');
    if (state.status === 'waiting-approval' && !state.pendingApproval) {
        throw new Error('Mission connector waiting state has no approval request');
    }
    if (state.status === 'executed' && (!state.proof || typeof state.receiptUri !== 'string')) {
        throw new Error('Mission connector executed state has no proof receipt');
    }
    if (state.proof)
        parseSignedExecutionProof(state.proof);
    return state as ConnectorExecutionState;
}

export function assertReceipt(value: unknown): MutationReceipt {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Mission connector receipt is invalid');
    }
    const receipt = value as Partial<MutationReceipt>;
    if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION
        || receipt.kind !== 'brokered-connector-mutation'
        || typeof receipt.workspaceId !== 'string'
        || typeof receipt.missionId !== 'string' || !MISSION_ID_RE.test(receipt.missionId)
        || typeof receipt.workItemId !== 'string' || !MISSION_ID_RE.test(receipt.workItemId)
        || typeof receipt.connectorPack !== 'string'
        || typeof receipt.operationId !== 'string'
        || !/^[a-f0-9]{64}$/.test(String(receipt.requestHash))
        || typeof receipt.idempotencyKey !== 'string'
        || !receipt.compensation || typeof receipt.compensation !== 'object'
        || !Number.isFinite(Date.parse(String(receipt.issuedAt)))
        || !receipt.proof) {
        throw new Error('Mission connector receipt is invalid');
    }
    parseSignedExecutionProof(receipt.proof);
    return receipt as MutationReceipt;
}

export function sameReceiptMutation(left: MutationReceipt, right: MutationReceipt): boolean {
    const { issuedAt: _leftIssuedAt, ...leftIdentity } = left;
    const { issuedAt: _rightIssuedAt, ...rightIdentity } = right;
    return canonicalOperationValue(leftIdentity) === canonicalOperationValue(rightIdentity);
}

export function requirePack(value: string): PriorityConnectorPack {
    if (!Object.hasOwn(connectorPackTemplates, value))
        throw new Error(`Unknown priority connector pack "${value}"`);
    return value as PriorityConnectorPack;
}

export function connectorInvocation(input: MissionExecutionInput): MissionConnectorInvocation {
    assertStorageSlug('mission', input.mission.id);
    assertStorageSlug('work item', input.item.id);
    const invocation = input.item.connectorInvocation;
    if (input.item.effect !== 'external-mutation' || !invocation) {
        throw new Error('Brokered connector executor accepts external-mutation work only');
    }
    return invocation;
}

export function idempotencyKey(input: MissionExecutionInput): string {
    const digest = createHash('sha256')
        .update(canonicalOperationValue(connectorInvocation(input)), 'utf8')
        .digest('hex')
        .slice(0, 24);
    return `mission:${input.mission.id}:${input.item.id}:${digest}`;
}

export function bindingFor(input: MissionExecutionInput): TaskExecutionProofBinding {
    return {
        workspaceId: '',
        missionId: input.mission.id,
        nodeId: input.item.id,
        idempotencyKey: idempotencyKey(input),
    };
}

export function resultProof(output: Record<string, unknown>): SignedExecutionProof {
    if (!('executionProof' in output))
        throw new Error('Connector result has no execution proof');
    return parseSignedExecutionProof(output.executionProof);
}

/** Routes external mutations to the broker worker and all other work to sessions. */
export class EffectRoutingMissionExecutor implements MissionWorkExecutor {
    constructor(private readonly ordinary: MissionWorkExecutor, readonly connector: BrokeredMissionConnectorExecutor) { }
    prepare(input: MissionExecutionInput): Promise<MissionExecutionBinding> {
        return input.item.effect === 'external-mutation'
            ? this.connector.prepare(input)
            : this.ordinary.prepare(input);
    }
    execute(input: MissionExecutionInput, binding: MissionExecutionBinding, lifecycle?: Parameters<MissionWorkExecutor['execute']>[2]): Promise<MissionExecutionResult> {
        return input.item.effect === 'external-mutation'
            ? this.connector.execute(input, binding)
            : this.ordinary.execute(input, binding, lifecycle);
    }
}
