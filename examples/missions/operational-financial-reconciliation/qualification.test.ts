import { afterEach, describe, expect, it } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectorPackManifestHash,
  connectorPackTemplates,
  priorityConnectorDriverDefinitions,
  type PriorityConnectorPack,
} from '@craft-agent/shared/connectors';
import {
  CapabilityOperationRequestSchema,
  ExecutionProofIssuer,
  StructuredEgressDeniedError,
  StructuredEgressFirewall,
  StructuredEgressPolicySchema,
  capabilityOperationRequestHash,
  operationValueHash,
  type CapabilityOperationRequest,
  type SignedExecutionProof,
} from '@craft-agent/shared/governance';
import {
  MissionSpecSchema,
  signProofPassport,
  verifyProofPassport,
  type MissionExecutionBinding,
  type MissionSpec,
  type UnsignedProofPassport,
} from '@craft-agent/shared/missions';
import {
  BrokeredMissionConnectorExecutor,
  type MissionConnectorRecoveryResult,
} from '../../../packages/server-core/src/missions/BrokeredMissionConnectorExecutor.ts';
import type {
  ConnectorAuthorizationResult,
  PrepareConnectorInvocationInput,
  PreparedConnectorInvocation,
} from '../../../packages/server-core/src/services/connector-execution-runtime.ts';
import type { MissionExecutionInput } from '../../../packages/server-core/src/missions/MissionRuntime.ts';
import { validateFinancialReconciliationPack } from './validate.ts';

const PACK_ROOT = dirname(fileURLToPath(import.meta.url));
const NOW = '2026-08-20T10:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function json<T>(path: string): T {
  return JSON.parse(readFileSync(join(PACK_ROOT, path), 'utf8')) as T;
}

function mission(variant: 'microsoft365' | 'google-workspace'): MissionSpec {
  const file = variant === 'microsoft365'
    ? 'mission.microsoft365.json'
    : 'mission.google-workspace.json';
  return MissionSpecSchema.parse(json(file));
}

function connectorInput(spec: MissionSpec, workItemId: string, dispatchId = 'qualification-dispatch'): MissionExecutionInput {
  const item = spec.workItems.find(({ id }) => id === workItemId);
  if (!item) throw new Error(`Unknown work item ${workItemId}`);
  const profileId = item.agentProfileId ?? spec.defaultWorkerProfileId;
  const profile = spec.agentProfiles.find(({ id }) => id === profileId);
  if (!profile) throw new Error(`Unknown profile ${profileId}`);
  return { mission: spec, item, profile, dispatchId, upstream: [] };
}

interface OfflinePrepared {
  request: CapabilityOperationRequest;
  pack: PriorityConnectorPack;
}

/** Contract-only choke point: no HTTP transport, credential, or network primitive exists here. */
class OfflineConnectorChokePoint {
  readonly issuer = new ExecutionProofIssuer({
    signingKey: Buffer.alloc(32, 31),
    now: () => '2026-08-20T10:00:05.000Z',
    generateId: () => `proof-${++this.proofSequence}`,
  });
  readonly mutationCount = new Map<string, number>();
  readonly proofs = new Map<string, SignedExecutionProof>();
  readonly crashOnceForNodes = new Set<string>();
  readonly divergeForNodes = new Set<string>();
  requiresApproval = true;
  private readonly prepared = new Map<string, OfflinePrepared>();
  private readonly approvalRequests = new Map<string, CapabilityOperationRequest>();
  private readonly approved = new Set<string>();
  private sequence = 0;
  private proofSequence = 0;

  prepare(input: PrepareConnectorInvocationInput): PreparedConnectorInvocation {
    const manifest = connectorPackTemplates[input.pack];
    const operation = manifest.operations.find(({ id }) => id === input.operationId);
    if (!operation) throw new Error(`Unknown operation ${input.operationId}`);
    const binding = priorityConnectorDriverDefinitions[input.pack].bindings[input.operationId];
    if (!binding) throw new Error(`Unknown HTTP binding ${input.pack}/${input.operationId}`);
    const request = CapabilityOperationRequestSchema.parse({
      schemaVersion: 1,
      operationId: input.operationId,
      risk: operation.risk,
      autonomy: input.autonomy,
      identity: {
        ...input.identity,
        workspaceId: 'qualification-workspace',
        connectorId: manifest.id,
      },
      target: {
        resourceType: input.resourceType,
        ...(input.resourceId ? { resourceId: input.resourceId } : {}),
        origin: operation.allowedOrigins[0],
      },
      payload: input.payload,
      policyVersion: 1,
      authorizationGeneration: 1,
      requestedAt: input.requestedAt ?? NOW,
      approvalContext: {
        provider: manifest.name,
        connectorId: manifest.id,
        origin: operation.allowedOrigins[0],
        resourceClass: input.resourceType,
        purpose: operation.title,
        effect: operation.effect,
        method: binding.method,
      },
      idempotencyKey: input.idempotencyKey,
      compensation: input.compensation,
    });
    const preparationId = `preparation-${++this.sequence}`;
    this.prepared.set(preparationId, { request, pack: input.pack });
    return { preparationId, request };
  }

  authorize(preparationId: string, approvalId?: string): ConnectorAuthorizationResult {
    const prepared = this.prepared.get(preparationId);
    if (!prepared) throw new Error('Unknown preparation');
    const requestHash = capabilityOperationRequestHash(prepared.request);
    if (this.requiresApproval && (!approvalId || !this.approved.has(approvalId))) {
      if (!prepared.request.approvalContext) throw new Error('Missing approval context');
      const nextApprovalId = `approval-${++this.sequence}`;
      this.approvalRequests.set(nextApprovalId, prepared.request);
      return {
        status: 'approval-required',
        preparationId,
        requestHash,
        approval: {
          approvalId: nextApprovalId,
          requestHash,
          operationId: prepared.request.operationId,
          risk: prepared.request.risk,
          actorId: prepared.request.identity.actorId,
          workspaceId: prepared.request.identity.workspaceId,
          missionId: prepared.request.identity.missionId,
          approvalContext: prepared.request.approvalContext,
          createdAt: NOW,
          expiresAt: '2026-08-20T10:10:00.000Z',
        },
      };
    }
    return { status: 'authorized', requestHash, preparationId };
  }

  resolveApproval(approvalId: string, decision: 'approved' | 'denied', resolvedBy: string) {
    const request = this.approvalRequests.get(approvalId);
    if (!request || decision === 'denied' || !resolvedBy.trim()) {
      return { status: 'denied' as const, reason: 'Approval denied or unknown' };
    }
    this.approved.add(approvalId);
    return {
      status: 'approved' as const,
      receipt: {
        approvalId,
        requestHash: capabilityOperationRequestHash(request),
        approvedBy: resolvedBy,
        policyVersion: 1,
        authorizationGeneration: 1,
        approvedAt: '2026-08-20T10:00:01.000Z',
        expiresAt: '2026-08-20T10:10:00.000Z',
      },
    };
  }

  async invokeAuthorized(preparationId: string) {
    const prepared = this.prepared.get(preparationId);
    if (!prepared) throw new Error('Unknown preparation');
    this.prepared.delete(preparationId);
    const request = prepared.request;
    const key = request.idempotencyKey!;
    this.mutationCount.set(key, (this.mutationCount.get(key) ?? 0) + 1);
    const diverged = this.divergeForNodes.has(request.identity.nodeId!);
    const proof = this.issuer.issue({
      clientId: request.identity.clientId,
      workspaceId: request.identity.workspaceId,
      missionId: request.identity.missionId,
      nodeId: request.identity.nodeId!,
      agentId: request.identity.agentId,
      connectorId: request.identity.connectorId!,
      operationId: request.operationId,
      idempotencyKey: key,
      payloadHash: operationValueHash(request.payload),
      resultHash: operationValueHash({ resourceId: request.target.resourceId, applied: true }),
      providerRequestId: `provider-${request.identity.nodeId}-1`,
      policyVersion: request.policyVersion,
      authorizationGeneration: request.authorizationGeneration,
      connectorManifestHash: connectorPackManifestHash(connectorPackTemplates[prepared.pack]),
      reconciliation: {
        status: diverged ? 'diverged' : 'confirmed',
        observedAt: '2026-08-20T10:00:04.000Z',
        providerStateHash: operationValueHash({ resourceId: request.target.resourceId, applied: !diverged }),
        ...(diverged ? { detailCode: 'PROVIDER_STATE_MISMATCH' } : {}),
      },
    });
    this.proofs.set(key, proof);
    if (this.crashOnceForNodes.delete(request.identity.nodeId!)) {
      throw new Error('Injected crash after provider mutation');
    }
    return { status: 'executed' as const, output: { executionProof: proof } };
  }

  recover(idempotencyKey: string): MissionConnectorRecoveryResult {
    const proof = this.proofs.get(idempotencyKey);
    return proof
      ? { status: 'confirmed', proof }
      : { status: 'unknown', reason: 'No authoritative provider observation' };
  }
}

function harness(input: {
  root?: string;
  runtime?: OfflineConnectorChokePoint;
} = {}) {
  const root = input.root ?? mkdtempSync(join(tmpdir(), 'financial-pack-'));
  if (!input.root) roots.push(root);
  const runtime = input.runtime ?? new OfflineConnectorChokePoint();
  const executor = new BrokeredMissionConnectorExecutor({
    workspaceId: 'qualification-workspace',
    workspaceRoot: root,
    runtime,
    actorId: 'qualification-operator',
    approvalSigningKey: Buffer.alloc(32, 23),
    verifyExecutionProof: (proof, binding) => runtime.issuer.verifyForTask(proof, binding),
    recoverMutation: async ({ idempotencyKey }) => runtime.recover(idempotencyKey),
    now: () => NOW,
  });
  return { root, runtime, executor };
}

async function preparedBinding(
  executor: BrokeredMissionConnectorExecutor,
  input: MissionExecutionInput,
): Promise<MissionExecutionBinding> {
  return executor.prepare(input);
}

describe('financial reconciliation vertical pack', () => {
  it('loads both Mission V2 variants and keeps real-tenant qualification explicitly open', () => {
    const report = validateFinancialReconciliationPack();
    expect(report).toMatchObject({
      qualificationLevel: 'contract-offline',
      realTenantQualified: false,
      mutationCount: 6,
      networkCalls: 0,
      tenantGates: 'not-run',
    });
    expect(report.variants.map(({ externalMutationCount }) => externalMutationCount)).toEqual([3, 3]);
    expect(report.connectorPacks).toEqual(['crm', 'erp', 'googleWorkspace', 'microsoft365']);
  });

  it('requires durable host approval before mutation and emits verifiable mutation and privacy receipts', async () => {
    const spec = mission('microsoft365');
    const input = connectorInput(spec, 'annotate-document');
    const { root, runtime, executor } = harness();
    const binding = await preparedBinding(executor, input);
    const pending = await executor.execute(input, binding);
    expect(pending.status).toBe('approval-required');
    expect([...runtime.mutationCount.values()].reduce((sum, value) => sum + value, 0)).toBe(0);
    if (pending.status !== 'approval-required') throw new Error('Expected approval');
    executor.resolveApproval({
      missionId: spec.id,
      workItemId: input.item.id,
      approvalId: pending.approvalId,
      requestHash: pending.requestHash,
      decision: 'approved',
      resolvedBy: 'finance-validator-qualification',
    });
    const completed = await executor.execute(input, binding);
    expect(completed.status).toBe('submission');
    expect([...runtime.mutationCount.values()]).toEqual([1]);
    if (completed.status !== 'submission') throw new Error('Expected submission');
    const receiptUri = completed.submission.evidence[0]!.uri;
    const mutationReceipt = JSON.parse(readFileSync(join(root, receiptUri), 'utf8'));
    expect(mutationReceipt).toMatchObject({
      kind: 'brokered-connector-mutation',
      connectorPack: 'microsoft365',
      operationId: 'files.update',
      proof: { reconciliation: { status: 'confirmed' } },
    });

    const egressPolicy = StructuredEgressPolicySchema.parse(json('policies/egress.microsoft365.json'));
    const firewall = new StructuredEgressFirewall({
      signingKey: Buffer.alloc(32, 41),
      now: () => NOW,
      generateId: () => 'privacy-receipt-1',
    });
    const invocation = input.item.connectorInvocation!;
    const prepared = firewall.prepare({
      payload: invocation.payload,
      destinationOrigin: 'https://graph.microsoft.com',
      policy: egressPolicy,
    });
    expect(prepared.payload.approvedBy).toMatch(/^psn_/);
    expect(JSON.stringify(prepared.payload)).not.toContain('finance.validator@example.test');
    const privacyReceipt = firewall.issueReceipt({
      prepared,
      workspaceId: 'qualification-workspace',
      missionId: spec.id,
      connectorId: connectorPackTemplates.microsoft365.id,
      operationId: invocation.operationId,
    });
    expect(firewall.verifyReceipt(privacyReceipt)).toBe(true);
    expect(JSON.stringify(privacyReceipt)).not.toContain('finance.validator@example.test');
    expect(() => firewall.prepare({
      payload: { ...invocation.payload, api_token: 'sk-secret-canary-value-1234567890' },
      destinationOrigin: 'https://graph.microsoft.com',
      policy: egressPolicy,
    })).toThrow(StructuredEgressDeniedError);
  });

  it('recovers a crash after provider mutation without issuing a duplicate', async () => {
    const spec = mission('google-workspace');
    const input = connectorInput(spec, 'mutate-operational', 'stable-dispatch');
    const runtime = new OfflineConnectorChokePoint();
    runtime.requiresApproval = false;
    runtime.crashOnceForNodes.add(input.item.id);
    const first = harness({ runtime });
    const binding = await preparedBinding(first.executor, input);
    expect(await first.executor.execute(input, binding)).toMatchObject({
      status: 'failed',
      ambiguousMutation: true,
      retryable: false,
    });
    expect([...runtime.mutationCount.values()]).toEqual([1]);

    const restarted = harness({ root: first.root, runtime });
    expect(await restarted.executor.execute(input, binding)).toMatchObject({ status: 'submission' });
    expect(await restarted.executor.execute(input, binding)).toMatchObject({ status: 'submission' });
    expect([...runtime.mutationCount.values()]).toEqual([1]);
  });

  it('fails closed on provider divergence and records the explicit compensation requirement', async () => {
    const spec = mission('microsoft365');
    const input = connectorInput(spec, 'mutate-financial');
    const { runtime, executor } = harness();
    runtime.requiresApproval = false;
    runtime.divergeForNodes.add(input.item.id);
    const result = await executor.execute(input, await preparedBinding(executor, input));
    expect(result).toMatchObject({ status: 'failed', retryable: false, ambiguousMutation: true });
    expect(executor.compensationRequirement(spec.id, input.item.id)).toMatchObject({
      compensation: { strategy: 'manual' },
      reason: expect.stringContaining('RECONCILIATION_DIVERGED'),
    });
    expect([...runtime.mutationCount.values()]).toEqual([1]);
  });

  it('builds a redacted Proof Passport from a host receipt and verifies it fully offline', async () => {
    const spec = mission('google-workspace');
    const input = connectorInput(spec, 'annotate-document');
    const { root, runtime, executor } = harness();
    runtime.requiresApproval = false;
    const completed = await executor.execute(input, await preparedBinding(executor, input));
    if (completed.status !== 'submission') throw new Error('Expected submission');
    const evidence = completed.submission.evidence[0]!;
    const receiptPath = join(root, evidence.uri);
    const receipt = readFileSync(receiptPath);
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const unsigned: UnsignedProofPassport = {
      schemaVersion: 1,
      passportId: `${spec.id}-offline-qualification`,
      missionId: spec.id,
      workspaceId: 'qualification-workspace',
      outcome: 'pass',
      completedAt: NOW,
      issuedAt: '2026-08-20T10:00:06.000Z',
      missionObjectiveSha256: hash(spec.objective),
      missionJournalSha256: hash('offline-qualification-journal-v1'),
      missionRevision: 1,
      criteria: spec.acceptanceCriteria.map((criterion) => ({
        workItemId: 'mission',
        criterionId: criterion.id,
        descriptionSha256: hash(criterion.description),
        evidenceRequirementIds: [input.item.connectorInvocation!.receiptRequirementId],
      })),
      evidence: [{
        workItemId: input.item.id,
        requirementId: evidence.requirementId,
        kind: 'receipt',
        uri: `workspace:///${evidence.uri.split('/').map(encodeURIComponent).join('/')}`,
        sha256: hash(receipt),
        sizeBytes: receipt.byteLength,
        observedAt: '2026-08-20T10:00:06.000Z',
        provenance: 'connector-receipt',
      }],
      privacy: {
        redacted: true,
        excluded: ['artifact-content', 'absolute-paths', 'credentials', 'model-messages', 'provider-responses'],
      },
    };
    const { privateKey } = generateKeyPairSync('ed25519');
    const passport = signProofPassport(unsigned, privateKey);
    expect(verifyProofPassport(passport).valid).toBe(true);
    expect(JSON.stringify(passport)).not.toContain(root);
    expect(JSON.stringify(passport)).not.toContain('finance.validator@example.test');
    expect(verifyProofPassport({ ...passport, missionRevision: 2 }).valid).toBe(false);
  });
});
