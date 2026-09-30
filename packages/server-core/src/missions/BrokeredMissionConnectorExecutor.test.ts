import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MissionSpecSchema,
  type MissionExecutionBinding,
  type MissionSpec,
} from '@craft-agent/shared/missions';
import {
  CapabilityOperationRequestSchema,
  ExecutionProofIssuer,
  capabilityOperationRequestHash,
  operationValueHash,
  type CapabilityOperationRequest,
  type SignedExecutionProof,
} from '@craft-agent/shared/governance';
import type {
  ConnectorAuthorizationResult,
  PrepareConnectorInvocationInput,
  PreparedConnectorInvocation,
} from '../services/connector-execution-runtime.ts';
import type { ISessionManager } from '../handlers/session-manager-interface.ts';
import {
  BrokeredMissionConnectorExecutor,
  type MissionConnectorRecoveryResult,
} from './BrokeredMissionConnectorExecutor.ts';
import { MissionRuntimeService } from './MissionRuntimeService.ts';
import type {
  MissionExecutionInput,
  MissionExecutionResult,
  MissionWorkExecutor,
} from './MissionRuntime.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function spec(): MissionSpec {
  return MissionSpecSchema.parse({
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
  });
}

function executionInput(): MissionExecutionInput {
  const mission = spec();
  return {
    mission,
    item: mission.workItems[1]!,
    profile: mission.agentProfiles[1]!,
    dispatchId: 'dispatch-1',
    upstream: [],
  };
}

class FakeConnectorChokePoint {
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

function harness(input: {
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

async function binding(executor: BrokeredMissionConnectorExecutor): Promise<MissionExecutionBinding> {
  return executor.prepare(executionInput());
}

function connectorStoragePaths(root: string, input = executionInput()) {
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

class ReviewExecutor implements MissionWorkExecutor {
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

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Mission runtime');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('BrokeredMissionConnectorExecutor', () => {
  it('returns a host-bound durable approval request before any mutation', async () => {
    const { runtime, executor } = harness();
    const input = executionInput();
    const result = await executor.execute(input, await binding(executor));
    expect(result.status).toBe('approval-required');
    expect(runtime.mutationCount).toBe(0);
    if (result.status !== 'approval-required') throw new Error('expected approval');
    expect(executor.pendingApproval(input.mission.id, input.item.id)).toMatchObject({
      approvalId: result.approvalId,
      requestHash: result.requestHash,
      operationId: 'drive.update',
      risk: 'W2',
      approvalContext: {
        provider: 'Google Workspace',
        connectorId: 'io.robb-agents.google-workspace',
        origin: 'https://www.googleapis.com',
        resourceClass: 'file',
        purpose: 'Update a Drive file',
        effect: 'external-mutation',
        method: 'PATCH',
      },
    });
    expect(JSON.stringify(executor.pendingApproval(input.mission.id, input.item.id))).not.toContain('approved-report.xlsx');
    expect(JSON.stringify(executor.pendingApproval(input.mission.id, input.item.id))).not.toContain('file-42');
    expect(() => executor.resolveApproval({
      missionId: input.mission.id,
      workItemId: input.item.id,
      approvalId: result.approvalId,
      requestHash: '0'.repeat(64),
      decision: 'approved',
      resolvedBy: 'human-approver-1',
    })).toThrow('does not match the durable request');
  });

  it('rejects traversal identifiers before resolving any durable path', () => {
    const { root, executor } = harness();
    expect(() => executor.pendingApproval('../outside', 'publish')).toThrow('Invalid mission id');
    expect(() => executor.pendingApproval('connector-mission', '../outside')).toThrow('Invalid work item id');
    expect(() => executor.resolvedApproval('connector-mission/alias', 'publish')).toThrow('Invalid mission id');
    expect(existsSync(join(root, 'missions'))).toBe(false);
  });

  it('refuses a symlinked Mission directory without writing outside the workspace', async () => {
    const { root, runtime, executor } = harness();
    const input = executionInput();
    const outside = mkdtempSync(join(tmpdir(), 'mission-broker-dir-outside-'));
    roots.push(outside);
    mkdirSync(join(root, 'missions'));
    symlinkSync(outside, connectorStoragePaths(root, input).missionDirectory, 'dir');

    await expect(executor.execute(input, await binding(executor)))
      .rejects.toThrow(/symbolic link|real directory/);
    expect(runtime.mutationCount).toBe(0);
    expect(existsSync(join(outside, 'connector-executions'))).toBe(false);
  });

  it('refuses symlinked and hard-linked durable state files without touching their targets', async () => {
    for (const attack of ['symlink', 'hardlink'] as const) {
      const { root, runtime, executor } = harness();
      const input = executionInput();
      const paths = connectorStoragePaths(root, input);
      const outsideRoot = mkdtempSync(join(tmpdir(), `mission-broker-state-${attack}-`));
      roots.push(outsideRoot);
      const outside = join(outsideRoot, 'state.json');
      writeFileSync(outside, 'outside-state-sentinel\n');
      mkdirSync(paths.executionDirectory, { recursive: true });
      if (attack === 'symlink') symlinkSync(outside, paths.state);
      else linkSync(outside, paths.state);

      await expect(executor.execute(input, await binding(executor)))
        .rejects.toThrow(attack === 'symlink' ? /symbolic link/ : /exactly one hard link/);
      expect(runtime.mutationCount).toBe(0);
      expect(readFileSync(outside, 'utf8')).toBe('outside-state-sentinel\n');
    }
  });

  it('refuses symlinked and hard-linked state locks without deleting or modifying their targets', async () => {
    for (const attack of ['symlink', 'hardlink'] as const) {
      const { root, runtime, executor } = harness();
      const input = executionInput();
      const paths = connectorStoragePaths(root, input);
      const outsideRoot = mkdtempSync(join(tmpdir(), `mission-broker-lock-${attack}-`));
      roots.push(outsideRoot);
      const outside = join(outsideRoot, 'lock.json');
      writeFileSync(outside, 'outside-lock-sentinel\n');
      mkdirSync(paths.executionDirectory, { recursive: true });
      if (attack === 'symlink') symlinkSync(outside, paths.stateLock);
      else linkSync(outside, paths.stateLock);

      await expect(executor.execute(input, await binding(executor)))
        .rejects.toThrow(attack === 'symlink' ? /symbolic link/ : /exactly one hard link/);
      expect(runtime.mutationCount).toBe(0);
      expect(readFileSync(outside, 'utf8')).toBe('outside-lock-sentinel\n');
      expect(existsSync(paths.state)).toBe(false);
    }
  });

  it('retains ambiguous recovery state when a receipt is symlinked or hard-linked', async () => {
    for (const attack of ['symlink', 'hardlink'] as const) {
      const runtime = new FakeConnectorChokePoint();
      runtime.requiresApproval = false;
      const { root, executor } = harness({ runtime });
      const input = executionInput();
      const paths = connectorStoragePaths(root, input);
      const outsideRoot = mkdtempSync(join(tmpdir(), `mission-broker-receipt-${attack}-`));
      roots.push(outsideRoot);
      const outside = join(outsideRoot, 'receipt.json');
      writeFileSync(outside, 'outside-receipt-sentinel\n');
      mkdirSync(paths.executionDirectory, { recursive: true });
      if (attack === 'symlink') symlinkSync(outside, paths.receipt);
      else linkSync(outside, paths.receipt);

      expect(await executor.execute(input, await binding(executor))).toMatchObject({
        status: 'failed',
        ambiguousMutation: true,
        reason: expect.stringContaining('requires recovery reconciliation'),
      });
      expect(runtime.mutationCount).toBe(1);
      expect(readFileSync(outside, 'utf8')).toBe('outside-receipt-sentinel\n');
      expect(JSON.parse(readFileSync(paths.state, 'utf8'))).toMatchObject({ status: 'executing' });
    }
  });

  it('refuses symlinked and hard-linked receipt locks after the provider mutation', async () => {
    for (const attack of ['symlink', 'hardlink'] as const) {
      const runtime = new FakeConnectorChokePoint();
      runtime.requiresApproval = false;
      const { root, executor } = harness({ runtime });
      const input = executionInput();
      const paths = connectorStoragePaths(root, input);
      const outsideRoot = mkdtempSync(join(tmpdir(), `mission-broker-receipt-lock-${attack}-`));
      roots.push(outsideRoot);
      const outside = join(outsideRoot, 'receipt-lock.json');
      writeFileSync(outside, 'outside-receipt-lock-sentinel\n');
      mkdirSync(paths.executionDirectory, { recursive: true });
      if (attack === 'symlink') symlinkSync(outside, paths.receiptLock);
      else linkSync(outside, paths.receiptLock);

      expect(await executor.execute(input, await binding(executor))).toMatchObject({
        status: 'failed',
        ambiguousMutation: true,
      });
      expect(runtime.mutationCount).toBe(1);
      expect(readFileSync(outside, 'utf8')).toBe('outside-receipt-lock-sentinel\n');
      expect(existsSync(paths.receipt)).toBe(false);
    }
  });

  it('revalidates the confined receipt before reusing an executed durable state', async () => {
    for (const attack of ['symlink', 'hardlink'] as const) {
      const runtime = new FakeConnectorChokePoint();
      runtime.requiresApproval = false;
      const { root, executor } = harness({ runtime });
      const input = executionInput();
      const operationBinding = await binding(executor);
      expect((await executor.execute(input, operationBinding)).status).toBe('submission');
      const paths = connectorStoragePaths(root, input);
      const outsideRoot = mkdtempSync(join(tmpdir(), `mission-broker-stored-receipt-${attack}-`));
      roots.push(outsideRoot);
      const outside = join(outsideRoot, 'receipt.json');
      writeFileSync(outside, 'outside-stored-receipt-sentinel\n');
      unlinkSync(paths.receipt);
      if (attack === 'symlink') symlinkSync(outside, paths.receipt);
      else linkSync(outside, paths.receipt);

      await expect(executor.execute(input, operationBinding))
        .rejects.toThrow(attack === 'symlink' ? /symbolic link/ : /exactly one hard link/);
      expect(runtime.mutationCount).toBe(1);
      expect(readFileSync(outside, 'utf8')).toBe('outside-stored-receipt-sentinel\n');
    }
  });

  it('detects a state pathname swap before truncating or writing the replacement inode', async () => {
    let armed = false;
    let armedCalls = 0;
    let swap: (() => void) | undefined;
    const { root, executor } = harness({
      now: () => {
        if (armed && ++armedCalls === 3) swap?.();
        return '2026-08-20T10:00:00.000Z';
      },
    });
    const input = executionInput();
    const pending = await executor.execute(input, await binding(executor));
    if (pending.status !== 'approval-required') throw new Error('expected approval');
    const paths = connectorStoragePaths(root, input);
    const parked = `${paths.state}.original`;
    const replacement = 'replacement-state-sentinel\n';
    swap = () => {
      renameSync(paths.state, parked);
      writeFileSync(paths.state, replacement);
    };
    armed = true;

    expect(() => executor.resolveApproval({
      missionId: input.mission.id,
      workItemId: input.item.id,
      approvalId: pending.approvalId,
      requestHash: pending.requestHash,
      decision: 'approved',
      resolvedBy: 'human-approver-1',
    })).toThrow(/changed while its descriptor was in use/);
    expect(readFileSync(paths.state, 'utf8')).toBe(replacement);
    expect(JSON.parse(readFileSync(parked, 'utf8'))).toMatchObject({
      revision: 2,
      status: 'waiting-approval',
    });
  });

  it('fails closed when bounded consent metadata is altered beside its canonical request hash', async () => {
    const { root, executor } = harness();
    const input = executionInput();
    const result = await executor.execute(input, await binding(executor));
    if (result.status !== 'approval-required') throw new Error('expected approval');
    const statePath = join(root, 'missions', input.mission.id, 'connector-executions', `${input.item.id}.state.json`);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      pendingApproval: { approvalContext: { purpose: string } };
    };
    state.pendingApproval.approvalContext.purpose = 'Delete every provider record';
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    expect(() => executor.pendingApproval(input.mission.id, input.item.id))
      .toThrow('consent context is not bound');
  });

  it('executes only after the signed durable host approval and emits a proof receipt', async () => {
    const { root, runtime, executor } = harness();
    const input = executionInput();
    const operationBinding = await binding(executor);
    const pending = await executor.execute(input, operationBinding);
    if (pending.status !== 'approval-required') throw new Error('expected approval');
    executor.resolveApproval({
      missionId: input.mission.id,
      workItemId: input.item.id,
      approvalId: pending.approvalId,
      requestHash: pending.requestHash,
      decision: 'approved',
      resolvedBy: 'human-approver-1',
    });
    const completed = await executor.execute(input, operationBinding);
    expect(completed.status).toBe('submission');
    expect(runtime.mutationCount).toBe(1);
    if (completed.status !== 'submission') throw new Error('expected submission');
    const uri = completed.submission.evidence[0]?.uri;
    expect(uri).toContain('connector-executions/publish.receipt.json');
    expect(JSON.parse(readFileSync(join(root, uri!), 'utf8'))).toMatchObject({
      kind: 'brokered-connector-mutation',
      operationId: 'drive.update',
      proof: { reconciliation: { status: 'confirmed' } },
    });
  });

  it('reuses a reconciled proof across a replan dispatch without repeating the mutation', async () => {
    const { runtime, executor } = harness();
    runtime.requiresApproval = false;
    const firstInput = executionInput();
    expect((await executor.execute(firstInput, await executor.prepare(firstInput))).status).toBe('submission');
    expect(runtime.mutationCount).toBe(1);

    const replannedInput = { ...firstInput, dispatchId: 'dispatch-after-replan' };
    const replayed = await executor.execute(replannedInput, await executor.prepare(replannedInput));
    expect(replayed.status).toBe('submission');
    expect(runtime.mutationCount).toBe(1);
  });

  it('rebinds an expired unapproved request before issuing a fresh approval', async () => {
    let now = '2026-08-20T10:00:00.000Z';
    const runtime = new FakeConnectorChokePoint();
    const { executor } = harness({ runtime, now: () => now });
    const input = executionInput();
    const operationBinding = await binding(executor);
    const first = await executor.execute(input, operationBinding);
    if (first.status !== 'approval-required') throw new Error('expected approval');
    now = '2026-08-20T10:03:00.000Z';
    runtime.approvalExpiresAt = '2026-08-20T10:05:00.000Z';
    const refreshed = await executor.execute(input, operationBinding);
    expect(refreshed.status).toBe('approval-required');
    if (refreshed.status !== 'approval-required') throw new Error('expected refreshed approval');
    expect(refreshed.requestHash).not.toBe(first.requestHash);
    expect(runtime.mutationCount).toBe(0);
  });

  it('does not replay a durable approval after its expiry', async () => {
    let now = '2026-08-20T10:00:00.000Z';
    const runtime = new FakeConnectorChokePoint();
    const { executor } = harness({ runtime, now: () => now });
    const input = executionInput();
    const operationBinding = await binding(executor);
    const first = await executor.execute(input, operationBinding);
    if (first.status !== 'approval-required') throw new Error('expected approval');
    executor.resolveApproval({
      missionId: input.mission.id,
      workItemId: input.item.id,
      approvalId: first.approvalId,
      requestHash: first.requestHash,
      decision: 'approved',
      resolvedBy: 'human-approver-1',
    });

    now = '2026-08-20T10:03:00.000Z';
    runtime.approvalExpiresAt = '2026-08-20T10:05:00.000Z';
    const refreshed = await executor.execute(input, operationBinding);
    expect(refreshed.status).toBe('approval-required');
    if (refreshed.status !== 'approval-required') throw new Error('expected refreshed approval');
    expect(refreshed.approvalId).not.toBe(first.approvalId);
    expect(refreshed.requestHash).not.toBe(first.requestHash);
    expect(executor.resolvedApproval(input.mission.id, input.item.id)).toBeNull();
    expect(runtime.mutationCount).toBe(0);
  });

  it('recovers a crash after provider mutation without invoking it twice', async () => {
    const runtime = new FakeConnectorChokePoint();
    runtime.requiresApproval = false;
    runtime.crashAfterMutation = true;
    const first = harness({ runtime });
    const input = executionInput();
    const operationBinding = await binding(first.executor);
    expect((await first.executor.execute(input, operationBinding)).status).toBe('failed');
    expect(runtime.mutationCount).toBe(1);
    runtime.crashAfterMutation = false;
    const restarted = harness({
      root: first.root,
      runtime,
      recover: async () => ({ status: 'confirmed', proof: runtime.lastProof! }),
    });
    expect((await restarted.executor.execute(input, operationBinding)).status).toBe('submission');
    expect(runtime.mutationCount).toBe(1);
  });

  it('fails closed and exposes the explicit compensation requirement on reconciliation mismatch', async () => {
    const { runtime, executor } = harness();
    runtime.requiresApproval = false;
    runtime.diverged = true;
    const input = executionInput();
    const result = await executor.execute(input, await binding(executor));
    expect(result).toMatchObject({ status: 'failed', ambiguousMutation: true });
    expect(executor.compensationRequirement(input.mission.id, input.item.id)).toMatchObject({
      compensation: { strategy: 'manual' },
      reason: expect.stringContaining('RECONCILIATION_DIVERGED'),
    });
  });

  it('never retries when crash recovery cannot prove the mutation absent', async () => {
    const runtime = new FakeConnectorChokePoint();
    runtime.requiresApproval = false;
    runtime.crashAfterMutation = true;
    const first = harness({ runtime });
    const input = executionInput();
    const operationBinding = await binding(first.executor);
    await first.executor.execute(input, operationBinding);
    runtime.crashAfterMutation = false;
    const restarted = harness({
      root: first.root,
      runtime,
      recover: async () => ({ status: 'unknown', reason: 'provider lookup unavailable' }),
    });
    expect(await restarted.executor.execute(input, operationBinding)).toMatchObject({
      status: 'failed', ambiguousMutation: true,
    });
    expect(runtime.mutationCount).toBe(1);
  });

  it('integrates with MissionRuntimeService and resumes only after host approval', async () => {
    const broker = harness();
    const sessionManager = {
      waitForInit: async () => {},
      getSessions: () => [],
      cancelProcessing: async () => {},
    } as unknown as ISessionManager;
    const service = new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: (id) => id === 'workspace-1' ? { id, rootPath: broker.root } : null,
      listWorkspaces: () => [{ id: 'workspace-1', rootPath: broker.root }],
      executorFactory: () => new ReviewExecutor(),
      connectorExecutorFactory: () => broker.executor,
    });
    await service.createAndStart('workspace-1', spec());
    await eventually(async () => (await service.getMission('workspace-1', 'connector-mission')).status === 'waiting-approval');
    const pending = await service.getPendingConnectorApproval('workspace-1', 'connector-mission', 'publish');
    expect(pending).not.toBeNull();
    expect(await service.listPendingConnectorApprovals('workspace-1')).toEqual([pending!]);
    await expect(service.getPendingConnectorApproval(
      'workspace-1',
      'connector-mission',
      '../outside',
    )).rejects.toThrow('Unknown mission work item');
    await service.resolveConnectorApproval({
      ...pending!,
      decision: 'approved',
      resolvedBy: 'human-approver-1',
    });
    await eventually(async () => (await service.getMission('workspace-1', 'connector-mission')).status === 'completed');
    expect(await service.listPendingConnectorApprovals('workspace-1')).toEqual([]);
    expect(broker.runtime.mutationCount).toBe(1);
  });

  it('recovers a crash after the durable approval decision but before Mission resume', async () => {
    const broker = harness();
    const sessionManager = {
      waitForInit: async () => {}, getSessions: () => [], cancelProcessing: async () => {},
    } as unknown as ISessionManager;
    const options = {
      sessionManager,
      resolveWorkspace: (id: string) => id === 'workspace-1' ? { id, rootPath: broker.root } : null,
      listWorkspaces: () => [{ id: 'workspace-1', rootPath: broker.root }],
      executorFactory: () => new ReviewExecutor(),
      connectorExecutorFactory: () => broker.executor,
    };
    const firstService = new MissionRuntimeService(options);
    await firstService.createAndStart('workspace-1', spec());
    await eventually(async () => (await firstService.getMission('workspace-1', 'connector-mission')).status === 'waiting-approval');
    const pending = await firstService.getPendingConnectorApproval('workspace-1', 'connector-mission', 'publish');
    broker.executor.resolveApproval({
      missionId: 'connector-mission', workItemId: 'publish',
      approvalId: pending!.approvalId, requestHash: pending!.requestHash,
      decision: 'approved', resolvedBy: 'human-approver-1',
    });

    const restartedService = new MissionRuntimeService(options);
    expect(await restartedService.start()).toContain('workspace-1:connector-mission');
    await eventually(async () => (await restartedService.getMission('workspace-1', 'connector-mission')).status === 'completed');
    expect(broker.runtime.mutationCount).toBe(1);
  });
});
