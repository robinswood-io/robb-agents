import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultWorkspaceGovernance } from '@craft-agent/shared/governance';
import {
  MissionSpecSchema,
  missionJournalPath,
  readMissionEvents,
  type MissionExecutionBinding,
  type MissionSnapshot,
  type MissionSpec,
  type MissionWorkItem,
  type StructuredMissionVerdict,
} from '@craft-agent/shared/missions';
import { saveWorkspaceConfig } from '@craft-agent/shared/workspaces';
import type { ISessionManager } from '../handlers/session-manager-interface.ts';
import { MissionController } from './MissionController.ts';
import {
  MissionRuntime,
  type MissionExecutionInput,
  type MissionExecutionResult,
  type MissionWorkExecutor,
} from './MissionRuntime.ts';
import { MissionRuntimeService } from './MissionRuntimeService.ts';

function fixture(id = 'twin-integration'): MissionSpec {
  return MissionSpecSchema.parse({
    schemaVersion: 2,
    id,
    title: 'Mission twin integration',
    objective: 'Replan safely',
    acceptanceCriteria: [{ id: 'mission-ok', description: 'Mission complete' }],
    plannerProfileId: 'planner',
    defaultWorkerProfileId: 'worker',
    reviewerProfileId: 'reviewer',
    supervisorProfileId: 'supervisor',
    agentProfiles: [
      { id: 'planner', role: 'planner', specialty: 'plan', systemPrompt: 'Plan.' },
      { id: 'worker', role: 'worker', specialty: 'work', systemPrompt: 'Work.' },
      { id: 'reviewer', role: 'reviewer', specialty: 'review', systemPrompt: 'Review.' },
      { id: 'supervisor', role: 'supervisor', specialty: 'supervise', systemPrompt: 'Supervise.' },
    ],
    policy: { maxConcurrentAgents: 3, maxWorkItems: 40 },
    workItems: [
      {
        id: 'objective', kind: 'objective', title: 'Objective',
        acceptanceCriteria: [{ id: 'objective-ok', description: 'Objective complete' }],
      },
      {
        id: 'source', kind: 'task', title: 'Source', prompt: 'Read source', objectiveId: 'objective',
        acceptanceCriteria: [{ id: 'source-ok', description: 'Source complete' }],
      },
      {
        id: 'dependent', kind: 'task', title: 'Dependent', prompt: 'Use source', objectiveId: 'objective',
        dependsOn: ['source'], acceptanceCriteria: [{ id: 'dependent-ok', description: 'Dependent complete' }],
      },
      {
        id: 'independent', kind: 'task', title: 'Independent', prompt: 'Independent work', objectiveId: 'objective',
        acceptanceCriteria: [{ id: 'independent-ok', description: 'Independent complete' }],
      },
    ],
  });
}

function externalFixture(id = 'twin-external'): MissionSpec {
  const base = fixture(id);
  return MissionSpecSchema.parse({
    ...base,
    workItems: base.workItems.map((item) => item.id === 'source' ? {
      ...item,
      effect: 'external-mutation',
      requiredEvidence: [{ id: 'mutation-receipt', description: 'Mutation receipt', kind: 'receipt' }],
      connectorInvocation: {
        schemaVersion: 1,
        pack: 'googleWorkspace',
        operationId: 'drive.update',
        resourceType: 'file',
        resourceId: 'file-1',
        payload: { name: 'report.xlsx' },
        autonomy: 'A3',
        receiptRequirementId: 'mutation-receipt',
        compensation: { strategy: 'manual' },
      },
    } : item),
  });
}

function expectPreviewRefusalWithoutWrites(
  workspaceRoot: string,
  controller: MissionController,
  snapshot: MissionSnapshot,
  proposedWorkItems: MissionWorkItem[],
  expected: RegExp,
): void {
  const missionId = snapshot.spec.id;
  const eventsBefore = readMissionEvents(workspaceRoot, missionId);
  expect(() => controller.previewReplan(
    missionId,
    snapshot.revision,
    proposedWorkItems,
  )).toThrow(expected);
  expect(readMissionEvents(workspaceRoot, missionId)).toEqual(eventsBefore);
}

function objectivePass(_missionId: string): StructuredMissionVerdict {
  return {
    targetType: 'objective',
    targetId: 'objective',
    result: 'pass',
    summary: 'Objective passed',
    criteria: [{
      criterionId: 'objective-ok',
      result: 'pass',
      evidenceRefs: ['workspace:///objective-proof.json'],
      explanation: 'All work passed',
    }],
    affectedWorkItemIds: [],
    corrections: [],
  };
}

async function eventually(assertion: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Mission runtime');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('Mission digital twin host integration', () => {
  let root: string;
  let sessionManager: ISessionManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mission-twin-integration-'));
    sessionManager = {
      waitForInit: async () => {},
      getSessions: () => [],
      cancelProcessing: async () => {},
    } as unknown as ISessionManager;
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('resolves every preflight observation on the host without constructing an executor or transport', async () => {
    const createdAt = Date.parse('2026-08-20T10:00:00.000Z');
    const governance = createDefaultWorkspaceGovernance({
      workspaceId: 'workspace-1',
      workspaceName: 'Twin workspace',
      createdAt: new Date(createdAt).toISOString(),
    });
    saveWorkspaceConfig(root, {
      schemaVersion: 1,
      id: 'workspace-1', name: 'Twin workspace', slug: 'twin-workspace', createdAt, updatedAt: createdAt,
      routingPolicy: {
        version: 1,
        enabled: true,
        defaultAllowConnectionSlugs: ['local-safe'],
        connectionProfiles: { 'local-safe': { capabilities: ['tools'] } },
      },
      governance: { ...governance, budgets: { ...governance.budgets, missionMaxCostUsd: 1 } },
    });
    const spec = externalFixture();
    let ordinaryExecutorConstructions = 0;
    let connectorExecutorConstructions = 0;
    let readinessInspections = 0;
    let costEstimates = 0;
    const service = new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: (id) => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [],
      executorFactory: () => {
        ordinaryExecutorConstructions += 1;
        throw new Error('dry-run constructed an ordinary executor');
      },
      connectorExecutorFactory: () => {
        connectorExecutorConstructions += 1;
        throw new Error('dry-run constructed a connector executor');
      },
      preflightConnections: () => [{ slug: 'local-safe', providerType: 'pi' }],
      connectorReadiness: {
        inspect: () => {
          readinessInspections += 1;
          return {
            installed: true,
            contractTestsPassed: true,
            supportsIdempotency: true,
            supportsReconciliation: true,
            supportsCompensation: true,
            structuredEgressPolicyReady: true,
            approvalPathReady: true,
          };
        },
      },
      preflightCostEstimator: {
        estimateUsd: () => {
          costEstimates += 1;
          return 0.1;
        },
      },
      preflightNow: () => new Date('2026-08-20T12:00:00.000Z'),
    });

    const report = await service.preflightMission('workspace-1', { spec });
    expect(report).toMatchObject({
      missionId: 'twin-external',
      mode: 'dry-run',
      mutationMode: 'forbidden',
      readyToStart: true,
      projectedExternalMutations: 1,
    });
    expect(report.projectedCostUsd).toBeCloseTo(0.3);
    expect(report.gates.every((gate) => gate.status === 'pass')).toBe(true);
    expect(ordinaryExecutorConstructions).toBe(0);
    expect(connectorExecutorConstructions).toBe(0);
    expect(readinessInspections).toBe(1);
    expect(costEstimates).toBe(3);
    expect(existsSync(join(root, 'missions'))).toBe(false);
  });

  it('fails preflight on host path and routing-budget policy before launch', async () => {
    const createdAt = Date.parse('2026-08-20T10:00:00.000Z');
    const governance = createDefaultWorkspaceGovernance({
      workspaceId: 'workspace-1', workspaceName: 'Twin workspace',
      createdAt: new Date(createdAt).toISOString(),
    });
    saveWorkspaceConfig(root, {
      schemaVersion: 1,
      id: 'workspace-1', name: 'Twin workspace', slug: 'twin-workspace', createdAt, updatedAt: createdAt,
      routingPolicy: {
        version: 1,
        enabled: true,
        defaultAllowConnectionSlugs: ['local-safe'],
        budgets: { missionUsd: 0.2, onExceed: 'block' },
      },
      governance: { ...governance, budgets: { ...governance.budgets, missionMaxCostUsd: 1 } },
    });
    const escaped = MissionSpecSchema.parse({ ...fixture('twin-policy-fail'), cwd: `${root}-outside` });
    const service = new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: (id) => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [],
      preflightConnections: () => [{ slug: 'local-safe', providerType: 'pi' }],
      preflightCostEstimator: { estimateUsd: () => 0.1 },
    });
    const report = await service.preflightMission('workspace-1', { spec: escaped });
    expect(report.readyToStart).toBe(false);
    expect(report.gates.filter((gate) => gate.category === 'route').every((gate) => gate.status === 'fail')).toBe(true);
    expect(report.gates.filter((gate) => gate.id.startsWith('policy.path.')).every((gate) => gate.status === 'fail')).toBe(true);
    expect(report.gates.find((gate) => gate.id === 'policy.deadline')?.status).toBe('pass');
    expect(existsSync(join(root, 'missions'))).toBe(false);
  });

  it('journals the exact replan, preserves independent accepted work, and invalidates derived reviews', () => {
    const controller = new MissionController({
      workspaceRoot: root,
      now: () => new Date('2026-08-20T12:00:00.000Z'),
    });
    controller.createMission(fixture());
    controller.startMission('twin-integration');
    for (const [id, sessionId] of [['source', 'worker-source'], ['independent', 'worker-independent']] as const) {
      controller.dispatchWorkItem('twin-integration', id, sessionId);
      controller.submitWorkItem('twin-integration', id, sessionId, { summary: `${id} done`, evidence: [], outputRefs: [] });
    }
    controller.dispatchWorkItem('twin-integration', 'dependent', 'worker-dependent');
    controller.submitWorkItem('twin-integration', 'dependent', 'worker-dependent', {
      summary: 'dependent done', evidence: [], outputRefs: [],
    });
    controller.dispatchWorkItem('twin-integration', 'review-objective-0', 'review-session');
    const before = controller.recordVerdict(
      'twin-integration', 'review-objective-0', 'review-session', objectivePass('twin-integration'),
    );
    expect(before.workItems.independent?.status).toBe('accepted');
    expect(before.workItems['final-review-0']?.status).toBe('pending');

    const proposed = before.spec.workItems.map((item) =>
      item.id === 'source' ? { ...item, prompt: 'Read source with the revised rule' } : item);
    const preview = controller.previewReplan('twin-integration', before.revision, proposed);
    expect(preview).toMatchObject({
      previousPlanVersion: 1,
      nextPlanVersion: 2,
      changedWorkItemIds: ['source'],
      preservedAcceptedWorkItemIds: ['independent'],
      invalidatedWorkItemIds: [
        'dependent', 'final-review-0', 'objective', 'review-objective-0', 'source',
      ],
    });
    const eventsBeforeApplyIdentityChecks = readMissionEvents(root, 'twin-integration');
    expect(() => controller.replanMission('twin-integration', {
      expectedRevision: before.revision,
      proposedWorkItems: proposed,
      actorId: '',
      reason: 'Source contract changed',
    })).toThrow(/actor identity is required/);
    expect(() => controller.replanMission('twin-integration', {
      expectedRevision: before.revision,
      proposedWorkItems: proposed,
      actorId: 'local-owner',
      reason: '',
    })).toThrow(/reason is required/);
    expect(readMissionEvents(root, 'twin-integration')).toEqual(eventsBeforeApplyIdentityChecks);
    const replanned = controller.replanMission('twin-integration', {
      expectedRevision: before.revision,
      proposedWorkItems: proposed,
      actorId: 'local-owner',
      reason: 'Source contract changed',
    });
    expect(replanned.planVersion).toBe(2);
    expect(replanned.replans).toHaveLength(1);
    expect(replanned.workItems.independent?.status).toBe('accepted');
    expect(replanned.workItems.source?.status).toBe('pending');
    expect(replanned.workItems.dependent?.status).toBe('pending');
    expect(replanned.workItems.objective?.status).toBe('pending');
    expect(replanned.workItems['review-objective-0']).toBeUndefined();
    expect(replanned.workItems['final-review-0']).toBeUndefined();
    expect(() => controller.replanMission('twin-integration', {
      expectedRevision: before.revision,
      proposedWorkItems: proposed,
      actorId: 'local-owner',
      reason: 'Stale retry',
    })).toThrow(/revision conflict/);
    expect(new MissionController({ workspaceRoot: root }).getMission('twin-integration')).toEqual(replanned);
  });

  it('makes preview and apply reject both reserved and running leases without preview writes', () => {
    const controller = new MissionController({ workspaceRoot: root });
    controller.createMission(externalFixture());
    controller.startMission('twin-external');
    let snapshot = controller.reserveWorkItem('twin-external', 'source', {
      dispatchId: 'connector-dispatch',
      binding: { executorKind: 'connector', executionId: 'connector-execution' },
    });
    expect(snapshot.workItems.source?.status).toBe('reserved');
    expectPreviewRefusalWithoutWrites(root, controller, snapshot, snapshot.spec.workItems, /leases are active/);
    expect(() => controller.replanMission('twin-external', {
      expectedRevision: snapshot.revision,
      proposedWorkItems: snapshot.spec.workItems,
      actorId: 'local-owner', reason: 'Unsafe while active',
    })).toThrow(/leases are active/);
    snapshot = controller.confirmWorkItemDispatch('twin-external', 'source', 'connector-dispatch');
    expect(snapshot.workItems.source?.status).toBe('running');
    expectPreviewRefusalWithoutWrites(root, controller, snapshot, snapshot.spec.workItems, /leases are active/);
    expect(() => controller.replanMission('twin-external', {
      expectedRevision: snapshot.revision,
      proposedWorkItems: snapshot.spec.workItems,
      actorId: 'local-owner', reason: 'Unsafe while running',
    })).toThrow(/leases are active/);
  });

  it('makes preview and apply reject terminal and ambiguous mutation states without preview writes', () => {
    const terminalController = new MissionController({ workspaceRoot: root });
    terminalController.createMission(fixture('twin-terminal'));
    const terminal = terminalController.cancelMission('twin-terminal', 'Owner cancelled');
    expectPreviewRefusalWithoutWrites(
      root, terminalController, terminal, terminal.spec.workItems, /terminal and cannot be replanned/,
    );
    expect(() => terminalController.replanMission('twin-terminal', {
      expectedRevision: terminal.revision,
      proposedWorkItems: terminal.spec.workItems,
      actorId: 'local-owner', reason: 'Unsafe terminal retry',
    })).toThrow(/terminal and cannot be replanned/);

    const controller = new MissionController({ workspaceRoot: root });
    controller.createMission(externalFixture('twin-ambiguous'));
    controller.startMission('twin-ambiguous');
    let snapshot = controller.dispatchWorkItem('twin-ambiguous', 'source', 'connector-dispatch');
    snapshot = controller.failWorkItemAttempt('twin-ambiguous', 'source', snapshot.workItems.source!.dispatchId!, {
      reason: 'Provider outcome unknown', retryable: false, ambiguousMutation: true,
    });
    expectPreviewRefusalWithoutWrites(
      root, controller, snapshot, snapshot.spec.workItems, /not durably reconciled/,
    );
    expect(() => controller.replanMission('twin-ambiguous', {
      expectedRevision: snapshot.revision,
      proposedWorkItems: snapshot.spec.workItems,
      actorId: 'local-owner', reason: 'Unsafe while unreconciled',
    })).toThrow(/not durably reconciled/);
  });

  it('makes preview and apply require explicit compensation before changing a reconciled mutation', () => {
    const controller = new MissionController({ workspaceRoot: root });
    controller.createMission(externalFixture('twin-compensation'));
    controller.startMission('twin-compensation');
    controller.dispatchWorkItem('twin-compensation', 'source', 'connector-session');
    const snapshot = controller.submitWorkItem('twin-compensation', 'source', 'connector-session', {
      summary: 'Mutation reconciled',
      outputRefs: ['connector://receipts/source'],
      evidence: [{
        requirementId: 'mutation-receipt',
        uri: 'connector://receipts/source',
        kind: 'receipt',
        sha256: 'a'.repeat(64),
      }],
    });
    const proposed = snapshot.spec.workItems.map((item) => item.id === 'source' ? {
      ...item,
      connectorInvocation: {
        ...item.connectorInvocation!,
        payload: { name: 'replacement.xlsx' },
      },
    } : item);
    expectPreviewRefusalWithoutWrites(root, controller, snapshot, proposed, /requires explicit compensation/);
    expect(() => controller.replanMission('twin-compensation', {
      expectedRevision: snapshot.revision,
      proposedWorkItems: proposed,
      actorId: 'local-owner', reason: 'Unsafe invocation replacement',
    })).toThrow(/requires explicit compensation/);
  });

  it('enforces preview admission through the host RPC without constructing an executor', async () => {
    const controller = new MissionController({ workspaceRoot: root });
    controller.createMission(externalFixture('twin-rpc-active'));
    controller.startMission('twin-rpc-active');
    const snapshot = controller.reserveWorkItem('twin-rpc-active', 'source', {
      dispatchId: 'rpc-dispatch',
      binding: { executorKind: 'connector', executionId: 'rpc-execution' },
    });
    const eventsBefore = readMissionEvents(root, 'twin-rpc-active');
    let executorConstructions = 0;
    const service = new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: (id) => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [],
      executorFactory: () => {
        executorConstructions += 1;
        throw new Error('preview constructed an executor');
      },
    });

    await expect(service.previewReplan(
      'workspace-1',
      'twin-rpc-active',
      snapshot.revision,
      snapshot.spec.workItems,
    )).rejects.toThrow(/leases are active/);
    expect(readMissionEvents(root, 'twin-rpc-active')).toEqual(eventsBefore);
    expect(executorConstructions).toBe(0);
  });

  it('replays 100 replans with torn-tail faults and dispatches the final plan exactly once', async () => {
    const controller = new MissionController({ workspaceRoot: root });
    const base = fixture('twin-faults');
    controller.createMission(MissionSpecSchema.parse({
      ...base,
      workItems: base.workItems.filter((item) => item.id === 'objective' || item.id === 'source'),
    }));
    for (let version = 1; version <= 100; version += 1) {
      const before = controller.getMission('twin-faults');
      const proposed = before.spec.workItems.map((item) =>
        item.id === 'source' ? { ...item, prompt: `Read source revision ${version}` } : item);
      controller.replanMission('twin-faults', {
        expectedRevision: before.revision,
        proposedWorkItems: proposed,
        actorId: 'fault-test',
        reason: `Fault-injected replan ${version}`,
      });
      appendFileSync(missionJournalPath(root, 'twin-faults'), '{"torn":', 'utf8');
    }
    const replayed = new MissionController({ workspaceRoot: root }).getMission('twin-faults');
    expect(replayed.planVersion).toBe(101);
    expect(replayed.replans).toHaveLength(100);
    expect(replayed.spec.workItems.find((item) => item.id === 'source')?.prompt)
      .toBe('Read source revision 100');

    let prepareCount = 0;
    let executeCount = 0;
    let releaseExecution!: (result: MissionExecutionResult) => void;
    const execution = new Promise<MissionExecutionResult>((resolve) => { releaseExecution = resolve; });
    const executor: MissionWorkExecutor = {
      async prepare(input: MissionExecutionInput): Promise<MissionExecutionBinding> {
        prepareCount += 1;
        return { executorKind: 'fault-test', executionId: `execution-${input.dispatchId}` };
      },
      async execute(): Promise<MissionExecutionResult> {
        executeCount += 1;
        return execution;
      },
    };
    const runtime = new MissionRuntime({
      workspaceRoot: root,
      controller: new MissionController({ workspaceRoot: root }),
      executor,
      genDispatchId: (_missionId, workItemId, attempt) => `${workItemId}-${attempt}`,
    });
    runtime.startMission('twin-faults');
    for (let fault = 0; fault < 100; fault += 1) runtime.recoverNonTerminalMissions();
    await eventually(() => executeCount === 1);
    expect(prepareCount).toBe(1);
    expect(executeCount).toBe(1);
    let events = readMissionEvents(root, 'twin-faults');
    expect(events.filter((event) => event.kind === 'work-item-dispatch-reserved')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'work-item-dispatched')).toHaveLength(1);

    releaseExecution({ status: 'failed', reason: 'Injected terminal fault', retryable: false });
    await eventually(() => new MissionController({ workspaceRoot: root }).getMission('twin-faults').status === 'blocked');
    events = readMissionEvents(root, 'twin-faults');
    expect(events.filter((event) => event.kind === 'work-item-dispatch-reserved')).toHaveLength(1);
  });
});
