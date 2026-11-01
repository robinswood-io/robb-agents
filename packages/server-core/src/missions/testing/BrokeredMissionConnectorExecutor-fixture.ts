import { withOfflineMissionRoutes } from "./mission-route-fixture.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionSpecSchema, type MissionExecutionBinding, type MissionSpec } from "@craft-agent/shared/missions";
import { CapabilityOperationRequestSchema, ExecutionProofIssuer, capabilityOperationRequestHash, operationValueHash, type CapabilityOperationRequest, type SignedExecutionProof } from "@craft-agent/shared/governance";
import type { ConnectorAuthorizationResult, PrepareConnectorInvocationInput, PreparedConnectorInvocation } from "../../services/connector-execution-runtime.ts";
import { BrokeredMissionConnectorExecutor, type MissionConnectorRecoveryResult } from "../BrokeredMissionConnectorExecutor.ts";
import type { MissionExecutionInput, MissionExecutionResult, MissionWorkExecutor } from "../MissionRuntime.ts";



export const roots: string[] = [];


export function spec(): MissionSpec {
  return withOfflineMissionRoutes(MissionSpecSchema.parse({
    schemaVersion: 2,
    id: 'connector-mission',
    title: 'Connector mission',
    objective: 'Publish a reconciled update',
    acceptanceCriteria: [{ id: 'mission-ok', description: 'Mutation is reconciled' }],
    plannerProfileId: 'planner',
    defaultWorkerProfileId: 'worker',
    reviewerProfileId: 'reviewer',
    supervisorProfileId: 'supervisor',
    agentProfiles: [
      { id: 'planner', role: 'planner', specialty: 'plan', systemPrompt: 'Plan.' },
      { id: 'worker', role: 'worker', specialty: 'finance', systemPrompt: 'Execute.' },
      { id: 'reviewer', role: 'reviewer', specialty: 'quality', systemPrompt: 'Review.' },
      { id: 'supervisor', role: 'supervisor', specialty: 'risk', systemPrompt: 'Supervise.' },
    ],
    workItems: [
      {
        id: 'objective-one', kind: 'objective', title: 'Objective',
        acceptanceCriteria: [{ id: 'objective-ok', description: 'Objective is complete' }],
      },
      {
        id: 'publish', kind: 'task', title: 'Publish', prompt: 'Publish the approved correction',
        objectiveId: 'objective-one', effect: 'external-mutation',
        acceptanceCriteria: [{ id: 'published', description: 'Provider state matches' }],
        requiredEvidence: [{ id: 'mutation-receipt', description: 'Host mutation receipt', kind: 'receipt' }],
        connectorInvocation: {
          schemaVersion: 1,
          pack: 'googleWorkspace',
          operationId: 'drive.update',
          resourceType: 'file',
          resourceId: 'file-42',
          payload: { name: 'approved-report.xlsx' },
          autonomy: 'A3',
          receiptRequirementId: 'mutation-receipt',
          compensation: { strategy: 'manual' },
        },
      },
    ],
  }));
}


export function executionInput(): MissionExecutionInput {
  const mission = spec();
  return {
    mission,
    item: mission.workItems[1]!,
    profile: mission.agentProfiles[1]!,
    dispatchId: 'dispatch-1',
    upstream: [],
  };
}


export class FakeConnectorChokePoint {
  readonly issuer = new ExecutionProofIssuer({
    signingKey: Buffer.alloc(32, 7),
    now: () => '2026-08-20T10:00:05.000Z',
    generateId: () => 'proof-1',
  });
  mutationCount = 0;
  requiresApproval = true;
  crashAfterMutation = false;
  diverged = false;
  approvalExpiresAt = '2026-08-20T10:02:00.000Z';
  lastProof?: SignedExecutionProof;
  private sequence = 0;
  private readonly prepared = new Map<string, CapabilityOperationRequest>();
  private readonly approved = new Set<string>();

  prepare(input: PrepareConnectorInvocationInput): PreparedConnectorInvocation {
    const preparationId = `preparation-${++this.sequence}`;
    const request = CapabilityOperationRequestSchema.parse({
      schemaVersion: 1,
      operationId: input.operationId,
      risk: 'W2',
      autonomy: input.autonomy,
      identity: {
        ...input.identity,
        workspaceId: 'workspace-1',
        connectorId: 'io.robb-agents.google-workspace',
      },
      target: {
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        origin: 'https://www.googleapis.com',
      },
      payload: input.payload,
      policyVersion: 1,
      authorizationGeneration: 1,
      requestedAt: input.requestedAt,
      approvalContext: {
        provider: 'Google Workspace',
        connectorId: 'io.robb-agents.google-workspace',
        origin: 'https://www.googleapis.com',
        resourceClass: input.resourceType,
        purpose: 'Update a Drive file',
        effect: 'external-mutation',
        method: 'PATCH',
      },
      idempotencyKey: input.idempotencyKey,
      compensation: input.compensation,
    });
    this.prepared.set(preparationId, request);
    return { preparationId, request };
  }

  authorize(preparationId: string, approvalId?: string): ConnectorAuthorizationResult {
    const request = this.prepared.get(preparationId);
    if (!request) throw new Error('unknown preparation');
    const requestHash = capabilityOperationRequestHash(request);
    if (this.requiresApproval && (!approvalId || !this.approved.has(approvalId))) {
      if (!request.approvalContext) throw new Error('missing approval context');
      return {
        status: 'approval-required', requestHash, preparationId,
        approval: {
          approvalId: `approval-${this.sequence}`,
          requestHash,
          operationId: request.operationId,
          risk: request.risk,
          actorId: request.identity.actorId,
          workspaceId: request.identity.workspaceId,
          missionId: request.identity.missionId,
          approvalContext: request.approvalContext,
          createdAt: '2026-08-20T10:00:00.000Z',
          expiresAt: this.approvalExpiresAt,
        },
      };
    }
    return { status: 'authorized', requestHash, preparationId };
  }

  resolveApproval(approvalId: string, decision: 'approved' | 'denied', resolvedBy: string) {
    if (decision === 'denied' || !resolvedBy) return { status: 'denied' as const, reason: 'denied' };
    this.approved.add(approvalId);
    return {
      status: 'approved' as const,
      receipt: {
        approvalId,
        requestHash: 'bound-by-fake-authorize',
        approvedBy: resolvedBy,
        policyVersion: 1,
        authorizationGeneration: 1,
        approvedAt: '2026-08-20T10:00:01.000Z',
        expiresAt: '2026-08-20T10:02:00.000Z',
      },
    };
  }

  async invokeAuthorized(preparationId: string) {
    const request = this.prepared.get(preparationId);
    if (!request) throw new Error('unknown preparation');
    this.mutationCount += 1;
    this.lastProof = this.issuer.issue({
      clientId: request.identity.clientId,
      workspaceId: request.identity.workspaceId,
      missionId: request.identity.missionId,
      nodeId: request.identity.nodeId!,
      agentId: request.identity.agentId,
      connectorId: request.identity.connectorId!,
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey!,
      payloadHash: operationValueHash(request.payload),
      resultHash: operationValueHash({ id: 'file-42', updated: true }),
      providerRequestId: 'provider-request-1',
      policyVersion: request.policyVersion,
      authorizationGeneration: request.authorizationGeneration,
      connectorManifestHash: 'a'.repeat(64),
      reconciliation: {
        status: this.diverged ? 'diverged' : 'confirmed',
        observedAt: '2026-08-20T10:00:04.000Z',
        providerStateHash: operationValueHash({ id: 'file-42', updated: !this.diverged }),
        ...(this.diverged ? { detailCode: 'PROVIDER_STATE_MISMATCH' } : {}),
      },
    });
    if (this.crashAfterMutation) throw new Error('simulated process crash after provider mutation');
    return { status: 'executed' as const, output: { executionProof: this.lastProof } };
  }
}


export function harness(input: {
  root?: string;
  runtime?: FakeConnectorChokePoint;
  recover?: () => Promise<MissionConnectorRecoveryResult>;
  now?: () => string;
} = {}) {
  const root = input.root ?? mkdtempSync(join(tmpdir(), 'mission-connector-broker-'));
  if (!input.root) roots.push(root);
  const runtime = input.runtime ?? new FakeConnectorChokePoint();
  const executor = new BrokeredMissionConnectorExecutor({
    workspaceId: 'workspace-1',
    workspaceRoot: root,
    runtime,
    actorId: 'operator-1',
    approvalSigningKey: Buffer.alloc(32, 9),
    verifyExecutionProof: (proof, binding) => runtime.issuer.verifyForTask(proof, binding),
    recoverMutation: input.recover ?? (async () => ({ status: 'unknown', reason: 'not configured' })),
    now: input.now ?? (() => '2026-08-20T10:00:00.000Z'),
  });
  return { root, runtime, executor };
}


export async function binding(executor: BrokeredMissionConnectorExecutor): Promise<MissionExecutionBinding> {
  return executor.prepare(executionInput());
}


export function connectorStoragePaths(root: string, input = executionInput()) {
  const missionDirectory = join(root, 'missions', input.mission.id);
  const executionDirectory = join(missionDirectory, 'connector-executions');
  const state = join(executionDirectory, `${input.item.id}.state.json`);
  const receipt = join(executionDirectory, `${input.item.id}.receipt.json`);
  return {
    missionDirectory,
    executionDirectory,
    state,
    stateLock: `${state}.lock`,
    receipt,
    receiptLock: `${receipt}.lock`,
  };
}


export class ReviewExecutor implements MissionWorkExecutor {
  async prepare(input: MissionExecutionInput): Promise<MissionExecutionBinding> {
    return { executorKind: 'review', executionId: input.dispatchId };
  }

  async execute(input: MissionExecutionInput): Promise<MissionExecutionResult> {
    if (input.item.kind === 'objective-review') {
      return { status: 'verdict', verdict: {
        targetType: 'objective', targetId: 'objective-one', result: 'pass', summary: 'Objective passed',
        criteria: [{ criterionId: 'objective-ok', result: 'pass', evidenceRefs: ['host://receipt'], explanation: 'OK' }],
        affectedWorkItemIds: [], corrections: [],
      } };
    }
    return { status: 'verdict', verdict: {
      targetType: 'mission', targetId: input.mission.id, result: 'pass', summary: 'Mission passed',
      criteria: [{ criterionId: 'mission-ok', result: 'pass', evidenceRefs: ['host://receipt'], explanation: 'OK' }],
      affectedWorkItemIds: [], corrections: [],
    } };
  }
}


export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Mission runtime');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
