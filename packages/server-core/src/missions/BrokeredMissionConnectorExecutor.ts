import { type SignedExecutionProof } from "@craft-agent/shared/governance";
import { type MissionConnectorInvocation, type MissionExecutionBinding } from "@craft-agent/shared/missions";
import type { MissionExecutionInput, MissionExecutionResult, MissionWorkExecutor } from "./MissionRuntime.ts";
import type { DurableApprovalDecision, PendingMissionConnectorApproval, DurablePendingMissionConnectorApproval, ConnectorExecutionState, BrokeredMissionConnectorExecutorOptions } from './brokered-connector/shared.ts';
import { MissionConnectorStateStore } from './brokered-connector/state-store.ts';
import * as brokeredConnectorExecution from './brokered-connector/execution.ts';
import * as brokeredConnectorApproval from './brokered-connector/approval.ts';
import * as brokeredConnectorRecovery from './brokered-connector/recovery.ts';
import * as brokeredConnectorCompletion from './brokered-connector/completion.ts';
export type { MissionConnectorRecoveryResult, MissionConnectorRecoveryRequest, PendingMissionConnectorApproval, BrokeredMissionConnectorExecutorOptions } from './brokered-connector/shared.ts';
export { EffectRoutingMissionExecutor } from './brokered-connector/shared.ts';

/**
 * External-mutation leaf worker. It never opens a model/tool session: the only
 * mutation boundary is ConnectorExecutionRuntime after a durable WAL record.
 */
export class BrokeredMissionConnectorExecutor implements MissionWorkExecutor {
    private readonly approvalKey: Buffer;
    private readonly store: MissionConnectorStateStore;
    private readonly now: () => string;
    constructor(private readonly options: BrokeredMissionConnectorExecutorOptions) {
        if (!options.workspaceId.trim() || !options.actorId.trim()) {
            throw new Error('Brokered Mission connector executor requires workspace and actor identities');
        }
        this.approvalKey = Buffer.from(options.approvalSigningKey);
        if (this.approvalKey.byteLength < 32)
            throw new Error('Mission connector approval key must contain at least 32 bytes');
        this.store = new MissionConnectorStateStore(options.workspaceRoot, options.workspaceId);
        this.now = options.now ?? (() => new Date().toISOString());
    }
    async prepare(input: MissionExecutionInput): Promise<MissionExecutionBinding> {
        return brokeredConnectorExecution.prepare(this, input);
    }
    async execute(input: MissionExecutionInput, binding: MissionExecutionBinding): Promise<MissionExecutionResult> {
        return brokeredConnectorExecution.execute(this, input, binding);
    }
    resolveApproval(input: {
        missionId: string;
        workItemId: string;
        approvalId: string;
        requestHash: string;
        decision: 'approved' | 'denied';
        resolvedBy: string;
    }): PendingMissionConnectorApproval {
        return brokeredConnectorApproval.resolveApproval(this, input);
    }
    pendingApproval(missionId: string, workItemId: string): PendingMissionConnectorApproval | null {
        return brokeredConnectorApproval.pendingApproval(this, missionId, workItemId);
    }
    resolvedApproval(missionId: string, workItemId: string): 'approved' | 'denied' | null {
        return brokeredConnectorApproval.resolvedApproval(this, missionId, workItemId);
    }
    approvalExpired(missionId: string, workItemId: string): boolean {
        return brokeredConnectorApproval.approvalExpired(this, missionId, workItemId);
    }
    compensationRequirement(missionId: string, workItemId: string): {
        reason: string;
        compensation: MissionConnectorInvocation['compensation'];
    } | null {
        return brokeredConnectorRecovery.compensationRequirement(this, missionId, workItemId);
    }
    private async recover(input: MissionExecutionInput, state: ConnectorExecutionState, invocation: MissionConnectorInvocation): Promise<{
        state: ConnectorExecutionState;
        result?: MissionExecutionResult;
    }> {
        return brokeredConnectorRecovery.recover(this, input, state, invocation);
    }
    private complete(input: MissionExecutionInput, state: ConnectorExecutionState, proofValue: SignedExecutionProof): MissionExecutionResult {
        return brokeredConnectorCompletion.complete(this, input, state, proofValue);
    }
    private submissionFromCompleted(input: MissionExecutionInput, state: ConnectorExecutionState): MissionExecutionResult {
        return brokeredConnectorCompletion.submissionFromCompleted(this, input, state);
    }
    private approvalResult(state: ConnectorExecutionState): MissionExecutionResult {
        return brokeredConnectorApproval.approvalResult(this, state);
    }
    private matchesState(state: ConnectorExecutionState, input: MissionExecutionInput, key: string): boolean {
        return brokeredConnectorRecovery.matchesState(this, state, input, key);
    }
    private matchesCompletedIdentity(state: ConnectorExecutionState, input: MissionExecutionInput, key: string): boolean {
        return brokeredConnectorRecovery.matchesCompletedIdentity(this, state, input, key);
    }
    /** @internal */ public signApproval(value: Omit<DurableApprovalDecision, 'signature'>): string {
        return brokeredConnectorApproval.signApproval(this, value);
    }
    private signPendingApproval(value: Omit<DurablePendingMissionConnectorApproval, 'bindingSignature'>): string {
        return brokeredConnectorApproval.signPendingApproval(this, value);
    }
    /** @internal */ public verifyPendingApproval(value: DurablePendingMissionConnectorApproval): boolean {
        return brokeredConnectorApproval.verifyPendingApproval(this, value);
    }
    /** @internal */ public publicPendingApproval(pending: DurablePendingMissionConnectorApproval): PendingMissionConnectorApproval {
        return brokeredConnectorApproval.publicPendingApproval(this, pending);
    }
    private verifyApproval(value: DurableApprovalDecision): boolean {
        return brokeredConnectorApproval.verifyApproval(this, value);
    }
    private failed(reason: string, ambiguousMutation: boolean): MissionExecutionResult {
        return { status: 'failed', reason, retryable: false, ambiguousMutation };
    }
    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
