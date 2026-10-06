import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
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
import { saveSourceConfig } from '@craft-agent/shared/sources';
import type { ISessionManager } from '../handlers/session-manager-interface.ts';
import { MissionController } from './MissionController.ts';
import {
  MissionRuntime,
  type MissionExecutionInput,
  type MissionExecutionResult,
  type MissionWorkExecutor,
} from './MissionRuntime.ts';
import { MissionRuntimeService } from './MissionRuntimeService.ts';
import { ordinaryMissionConnectionIdentity } from './mission-route-identity.ts';

function routeConnection(slug: string, models = ['pi/gpt-5.6-luna', 'pi/gpt-5.6-terra', 'pi/gpt-5.6-sol']) {
  return {
    slug,
    providerType: 'pi' as const,
    piAuthProvider: 'openai',
    models,
    defaultModel: models[1] ?? models[0],
  };
}

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
      defaults: { defaultLlmConnection: 'local-safe' },
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
      preflightConnections: () => [routeConnection('local-safe')],
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

  it('fails preflight on host path and mission budget before launch', async () => {
    const createdAt = Date.parse('2026-08-20T10:00:00.000Z');
    const governance = createDefaultWorkspaceGovernance({
      workspaceId: 'workspace-1', workspaceName: 'Twin workspace',
      createdAt: new Date(createdAt).toISOString(),
    });
    saveWorkspaceConfig(root, {
      schemaVersion: 1,
      id: 'workspace-1', name: 'Twin workspace', slug: 'twin-workspace', createdAt, updatedAt: createdAt,
      defaults: { defaultLlmConnection: 'local-safe' },
      governance: { ...governance, budgets: { ...governance.budgets, missionMaxCostUsd: 0.2 } },
    });
    const escaped = MissionSpecSchema.parse({ ...fixture('twin-policy-fail'), cwd: `${root}-outside` });
    const service = new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: (id) => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [],
      preflightConnections: () => [routeConnection('local-safe')],
      preflightCostEstimator: { estimateUsd: () => 0.1 },
    });
    const report = await service.preflightMission('workspace-1', { spec: escaped });
    expect(report.readyToStart).toBe(false);
    expect(report.gates.filter((gate) => gate.category === 'route').every((gate) => gate.status === 'pass')).toBe(true);
    expect(report.gates.find((gate) => gate.id === 'budget.projected')?.status).toBe('fail');
    expect(report.gates.filter((gate) => gate.id.startsWith('policy.path.')).every((gate) => gate.status === 'fail')).toBe(true);
    expect(report.gates.find((gate) => gate.id === 'policy.deadline')?.status).toBe('pass');
    expect(existsSync(join(root, 'missions'))).toBe(false);
  });

  it('checks and estimates the inherited origin connection used by mission execution', async () => {
    const createdAt = Date.parse('2026-08-20T10:00:00.000Z');
    const governance = createDefaultWorkspaceGovernance({
      workspaceId: 'workspace-1', workspaceName: 'Twin workspace',
      createdAt: new Date(createdAt).toISOString(),
    });
    saveWorkspaceConfig(root, {
      schemaVersion: 1,
      id: 'workspace-1', name: 'Twin workspace', slug: 'twin-workspace', createdAt, updatedAt: createdAt,
      defaults: { defaultLlmConnection: 'unavailable-workspace-connection' },
      governance: { ...governance, budgets: { ...governance.budgets, missionMaxCostUsd: 1 } },
    });
    sessionManager.getSessions = () => [{
      id: 'origin', workspaceId: 'workspace-1', workspaceName: 'Twin workspace',
      messages: [], lastMessageAt: createdAt, isProcessing: false,
      llmConnection: 'origin-connection', model: 'origin-model', thinkingLevel: 'high',
    }];
    const estimatedConnections: string[] = [];
    const service = new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: id => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [],
      preflightConnections: () => [routeConnection('origin-connection', ['origin-model'])],
      preflightCostEstimator: { estimateUsd: ({ connectionSlug }) => {
        estimatedConnections.push(connectionSlug);
        return 0.1;
      } },
    });
    const report = await service.preflightMission('workspace-1', {
      spec: MissionSpecSchema.parse({ ...fixture('origin-connection'), originSessionId: 'origin' }),
    });
    expect(report.gates.filter(gate => gate.category === 'route').every(gate => gate.status === 'pass')).toBe(true);
    expect(estimatedConnections).toEqual(['origin-connection', 'origin-connection', 'origin-connection']);
  });

  it('preserves an exact route outside the candidate catalogue with manual selection', async () => {
    const createdAt = Date.parse('2026-08-20T10:00:00.000Z');
    saveWorkspaceConfig(root, {
      schemaVersion: 1,
      id: 'workspace-1', name: 'Twin workspace', slug: 'twin-workspace', createdAt, updatedAt: createdAt,
      defaults: { defaultLlmConnection: 'manual-private-connection' },

    });
    const estimatedConnections: string[] = [];
    const service = new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: id => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [],
      preflightConnections: () => [
        routeConnection('manual-private-connection'),
        routeConnection('catalogue-only'),
      ],
      preflightCostEstimator: { estimateUsd: ({ connectionSlug }) => {
        estimatedConnections.push(connectionSlug);
        return 0.01;
      } },
    });

    const report = await service.preflightMission('workspace-1', { spec: fixture('routing-disabled') });
    expect(report.gates.filter(gate => gate.category === 'route').every(gate => gate.status === 'pass')).toBe(true);
    expect(estimatedConnections).toEqual([
      'manual-private-connection',
      'manual-private-connection',
      'manual-private-connection',
    ]);
  });

  it('does not invent a candidate route with manual selection without an exact connection', async () => {
    const createdAt = Date.parse('2026-08-20T10:00:00.000Z');
    saveWorkspaceConfig(root, {
      schemaVersion: 1,
      id: 'workspace-1', name: 'Twin workspace', slug: 'twin-workspace', createdAt, updatedAt: createdAt,
      defaults: { defaultLlmConnection: '' },
    });
    const service = new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: id => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [],
      preflightConnections: () => [routeConnection('catalogue-only')],
    });

    const report = await service.preflightMission('workspace-1', { spec: fixture('routing-disabled-empty') });
    const routeGates = report.gates.filter(gate => gate.category === 'route');
    expect(routeGates.length).toBeGreaterThan(0);
    expect(routeGates.every(gate => gate.status === 'fail')).toBe(true);
    expect(routeGates.every(gate => gate.detail.includes('no non-empty explicit or default connection'))).toBe(true);
  });



  it('keeps the selected provider while estimating shared-profile assignments', async () => {
    const createdAt = Date.parse('2026-08-20T10:00:00.000Z');
    const governance = createDefaultWorkspaceGovernance({
      workspaceId: 'workspace-1', workspaceName: 'Twin workspace',
      createdAt: new Date(createdAt).toISOString(),
    });
    saveWorkspaceConfig(root, {
      schemaVersion: 1,
      id: 'workspace-1', name: 'Twin workspace', slug: 'twin-workspace', createdAt, updatedAt: createdAt,
      defaults: { defaultLlmConnection: 'cheap' },
      governance,

    });
    const base = fixture('difficulty-preflight');
    const spec = MissionSpecSchema.parse({
      ...base,
      objective: 'Complete the assigned work.',
      originSessionId: 'automatic-origin',
      agentProfiles: base.agentProfiles.map(profile => profile.id === 'worker'
        ? { ...profile, tools: ['informational-shell'] }
        : profile),
      workItems: base.workItems.map(item => item.id === 'source'
        ? { ...item, prompt: 'List files.' }
        : item.id === 'dependent'
          ? { ...item, prompt: 'Implement the migration across multiple packages, then test it end-to-end.' }
          : item),
    });
    sessionManager.getSessions = () => [{
      id: 'automatic-origin', workspaceId: 'workspace-1', workspaceName: 'Twin workspace',
      messages: [], lastMessageAt: createdAt, isProcessing: false,
      llmConnection: 'strong', connectionRoutePinned: false,
    }];
    const estimatedRoutes: Record<string, string> = {};
    const service = new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: id => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [],
      preflightConnections: () => [routeConnection('cheap'), routeConnection('strong')],
      preflightCostEstimator: { estimateUsd: ({ item, connectionSlug }) => {
        estimatedRoutes[item.id] = connectionSlug;
        return 0.1;
      } },
    });

    const report = await service.preflightMission('workspace-1', { spec });
    expect(report.gates.find(gate => gate.id === 'route.worker')?.detail).toContain('strong');
    expect(report.gates.find(gate => gate.id === 'route.work-item.source')?.detail).toContain('strong');
    expect(report.gates.find(gate => gate.id === 'route.work-item.dependent')?.detail).toContain('strong');
    expect(report.gates.find(gate => gate.id === 'route.work-item.source')?.status).toBe('pass');
    expect(estimatedRoutes).toMatchObject({ source: 'strong', dependent: 'strong' });
  });

  it('keeps a model-only profile on the workspace default connection without an origin', async () => {
    const createdAt = Date.parse('2026-08-20T10:00:00.000Z');
    const governance = createDefaultWorkspaceGovernance({
      workspaceId: 'workspace-1', workspaceName: 'Twin workspace',
      createdAt: new Date(createdAt).toISOString(),
    });
    saveWorkspaceConfig(root, {
      schemaVersion: 1,
      id: 'workspace-1', name: 'Twin workspace', slug: 'twin-workspace', createdAt, updatedAt: createdAt,
      defaults: { defaultLlmConnection: 'workspace-default' },
      governance: { ...governance, budgets: { ...governance.budgets, missionMaxCostUsd: 1 } },

    });
    const base = fixture('model-only-no-origin');
    const spec = MissionSpecSchema.parse({
      ...base,
      originSessionId: undefined,
      agentProfiles: base.agentProfiles.map(profile => profile.id === 'worker'
        ? { ...profile, model: 'pi/gpt-5.6-terra' }
        : profile),
    });
    const estimatedRoutes = new Map<string, string>();
    const service = new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: (id) => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [],
      preflightConnections: () => [
        routeConnection('workspace-default'),
        routeConnection('preferred'),
      ],
      preflightCostEstimator: {
        estimateUsd: ({ item, connectionSlug }) => {
          estimatedRoutes.set(item.id, connectionSlug);
          return 0.01;
        },
      },
    });

    const report = await service.preflightMission('workspace-1', { spec });
    expect(report.readyToStart).toBe(true);
    expect([...estimatedRoutes.values()]).toEqual([
      'workspace-default', 'workspace-default', 'workspace-default',
    ]);
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

  it('persists the admitted route and fails closed when it drifts before effective dispatch', async () => {
    const createdAt = Date.parse('2026-08-20T10:00:00.000Z');
    saveWorkspaceConfig(root, {
      schemaVersion: 1,
      id: 'workspace-1', name: 'Twin workspace', slug: 'twin-workspace', createdAt, updatedAt: createdAt,
      defaults: { defaultLlmConnection: 'openai', thinkingLevel: 'medium' },
      costControl: {},
    });
    const spec = fixture('route-drift');
    spec.policy.maxConcurrentAgents = 1;
    spec.policy.maxTechnicalAttempts = 1;
    spec.workItems = spec.workItems.filter(item => item.id === 'objective' || item.id === 'source');
    let catalogueModels = ['pi/gpt-5.6-terra'];
    let preparedInput: MissionExecutionInput | undefined;
    let executeCount = 0;
    let releasePrepare!: () => void;
    let markPrepareEntered!: () => void;
    const prepareEntered = new Promise<void>(resolve => { markPrepareEntered = resolve; });
    const prepareRelease = new Promise<void>(resolve => { releasePrepare = resolve; });
    const inertExecutor: MissionWorkExecutor = {
      prepare: async input => {
        preparedInput = input;
        markPrepareEntered();
        await prepareRelease;
        return { executorKind: 'inert', executionId: input.dispatchId };
      },
      execute: async () => {
        executeCount += 1;
        return { status: 'failed', reason: 'not dispatched', retryable: false };
      },
    };
    const service = new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: id => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [],
      executorFactory: () => inertExecutor,
      preflightConnections: () => [routeConnection('openai', catalogueModels)],
    });

    await service.createAndStart('workspace-1', spec);
    await prepareEntered;
    expect(preparedInput?.profile).toMatchObject({
      llmConnection: 'openai',
      model: 'pi/gpt-5.6-terra',
      thinkingLevel: expect.any(String),
    });

    catalogueModels = ['pi/gpt-5.6-sol'];
    releasePrepare();
    await eventually(() =>
      new MissionController({ workspaceRoot: root }).getMission('route-drift').status === 'blocked');

    const blocked = new MissionController({ workspaceRoot: root }).getMission('route-drift');
    expect(blocked.workItems.source?.executionBinding?.missionRoute).toMatchObject({
      routeDecisionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      connectionSlug: 'openai',
      model: 'pi/gpt-5.6-terra',
    });
    expect(blocked.workItems.source?.statusReason).toContain('drifted after prepare');
    expect(executeCount).toBe(0);
  });

  it('pins a relative Mission cwd to the exact workspace-relative absolute path', async () => {
    const createdAt = Date.parse('2026-08-20T10:00:00.000Z');
    saveWorkspaceConfig(root, {
      schemaVersion: 1,
      id: 'workspace-1', name: 'Twin workspace', slug: 'twin-workspace', createdAt, updatedAt: createdAt,
      defaults: { defaultLlmConnection: 'openai', thinkingLevel: 'medium' },
      costControl: {},
    });
    mkdirSync(join(root, 'project'), { recursive: true });
    const spec = fixture('relative-cwd');
    spec.cwd = 'project';
    spec.policy.maxConcurrentAgents = 1;
    spec.workItems = spec.workItems.filter(item => item.id === 'objective' || item.id === 'source');
    let prepared: MissionExecutionInput | undefined;
    const never = new Promise<MissionExecutionResult>(() => {});
    const service = new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: id => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [],
      preflightConnections: () => [routeConnection('openai', ['pi/gpt-5.6-terra'])],
      executorFactory: () => ({
        prepare: async input => {
          prepared = input;
          return { executorKind: 'cwd-observer', executionId: input.dispatchId };
        },
        execute: async () => never,
      }),
    });

    await service.createAndStart('workspace-1', spec);
    await eventually(() => prepared !== undefined);
    expect(prepared?.mission.cwd).toBe('project');
    expect(prepared?.ordinaryRoutePin?.cwd).toBe(join(root, 'project'));
  });

  it('rejects relative traversal, absolute exterior paths, and symlink escapes as Mission cwd', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mission-cwd-outside-'));
    symlinkSync(outside, join(root, 'outside-link'));
    const service = new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: id => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [],
      executorFactory: () => ({
        prepare: async input => ({ executorKind: 'unexpected', executionId: input.dispatchId }),
        execute: async () => ({ status: 'failed', reason: 'unexpected', retryable: false }),
      }),
    });
    try {
      for (const [id, cwd] of [
        ['relative-traversal', '../outside'],
        ['absolute-exterior', outside],
        ['symlink-exterior', 'outside-link'],
      ] as const) {
        const spec = fixture(id);
        spec.cwd = cwd;
        await expect(service.createAndStart('workspace-1', spec)).rejects.toThrow(
          /working directory is not authorized: Path escapes the workspace/,
        );
        expect(existsSync(missionJournalPath(root, id))).toBe(false);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('revalidates a persisted ordinary route binding while recovering a reserved dispatch', async () => {
    const createdAt = Date.parse('2026-08-20T10:00:00.000Z');
    saveWorkspaceConfig(root, {
      schemaVersion: 1,
      id: 'workspace-1', name: 'Twin workspace', slug: 'twin-workspace', createdAt, updatedAt: createdAt,
      defaults: { defaultLlmConnection: 'openai', thinkingLevel: 'medium' },
      costControl: {},
    });
    const spec = fixture('route-recovery');
    spec.policy.maxConcurrentAgents = 1;
    spec.policy.maxTechnicalAttempts = 1;
    spec.workItems = spec.workItems.filter(item => item.id === 'objective' || item.id === 'source');
    const options = {
      sessionManager,
      resolveWorkspace: (id: string) => id === 'workspace-1' ? { id, rootPath: root } : null,
      preflightConnections: () => [routeConnection('openai', ['pi/gpt-5.6-terra'])],
    };
    const never = new Promise<MissionExecutionResult>(() => {});
    const initial = new MissionRuntimeService({
      ...options,
      listWorkspaces: () => [],
      executorFactory: () => ({
        prepare: async input => ({ executorKind: 'recovering', executionId: input.dispatchId }),
        execute: async () => never,
      }),
    });
    await initial.createAndStart('workspace-1', spec);
    await eventually(() => Boolean(
      new MissionController({ workspaceRoot: root })
        .getMission(spec.id).workItems.source?.executionBinding?.missionRoute,
    ));
    const route = new MissionController({ workspaceRoot: root })
      .getMission(spec.id).workItems.source!.executionBinding!.missionRoute!;
    let prepareCount = 0;
    let executedInput: MissionExecutionInput | undefined;
    const service = new MissionRuntimeService({
      ...options,
      listWorkspaces: () => [{ id: 'workspace-1', rootPath: root }],
      executorFactory: () => ({
        prepare: async input => {
          prepareCount += 1;
          return { executorKind: 'unexpected', executionId: input.dispatchId };
        },
        execute: async input => {
          executedInput = input;
          return { status: 'failed', reason: 'Recovery observed', retryable: false };
        },
      }),
    });

    expect(await service.start()).toEqual(['workspace-1:route-recovery']);
    await eventually(() =>
      new MissionController({ workspaceRoot: root }).getMission(spec.id).status === 'blocked');
    expect(prepareCount).toBe(0);
    expect(executedInput?.profile).toMatchObject({
      llmConnection: route.connectionSlug,
      model: route.model,
      thinkingLevel: route.thinkingLevel,
    });
    expect(executedInput?.ordinaryRoutePin).toEqual(route);
  });

  it('fails closed on recovery when a legacy reservation has no optional route binding', async () => {
    const createdAt = Date.parse('2026-08-20T10:00:00.000Z');
    saveWorkspaceConfig(root, {
      schemaVersion: 1,
      id: 'workspace-1', name: 'Twin workspace', slug: 'twin-workspace', createdAt, updatedAt: createdAt,
      defaults: { defaultLlmConnection: 'openai', thinkingLevel: 'medium' },
      costControl: {},
    });
    const spec = fixture('legacy-route-recovery');
    spec.policy.maxConcurrentAgents = 1;
    spec.policy.maxTechnicalAttempts = 1;
    spec.workItems = spec.workItems.filter(item => item.id === 'objective' || item.id === 'source');
    const controller = new MissionController({ workspaceRoot: root });
    controller.createMission(spec);
    controller.startMission(spec.id);
    controller.reserveWorkItem(spec.id, 'source', {
      dispatchId: 'legacy-route-dispatch',
      binding: { executorKind: 'legacy', executionId: 'legacy-route-execution' },
    });
    let executeCount = 0;
    const service = new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: id => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [{ id: 'workspace-1', rootPath: root }],
      preflightConnections: () => [routeConnection('openai', ['pi/gpt-5.6-terra'])],
      executorFactory: () => ({
        prepare: async input => ({ executorKind: 'unexpected', executionId: input.dispatchId }),
        execute: async () => {
          executeCount += 1;
          return { status: 'failed', reason: 'should not execute', retryable: false };
        },
      }),
    });

    expect(await service.start()).toEqual(['workspace-1:legacy-route-recovery']);
    await eventually(() =>
      new MissionController({ workspaceRoot: root }).getMission(spec.id).status === 'blocked');
    const blocked = new MissionController({ workspaceRoot: root }).getMission(spec.id);
    expect(blocked.workItems.source?.statusReason).toContain('missing from the durable dispatch binding');
    expect(executeCount).toBe(0);
  });

  it('uses completed item cost and estimates only the remaining work for the next dispatch', async () => {
    const createdAt = Date.parse('2026-08-20T10:00:00.000Z');
    saveWorkspaceConfig(root, {
      schemaVersion: 1,
      id: 'workspace-1', name: 'Twin workspace', slug: 'twin-workspace', createdAt, updatedAt: createdAt,
      defaults: { defaultLlmConnection: 'openai', thinkingLevel: 'medium' },
      costControl: {},
    });
    const spec = fixture('per-dispatch-cost');
    spec.policy.maxConcurrentAgents = 1;
    spec.workItems = spec.workItems.filter(item =>
      item.id === 'objective' || item.id === 'source' || item.id === 'dependent');
    const prepared = new Map<string, MissionExecutionInput>();
    const executor: MissionWorkExecutor = {
      prepare: async input => {
        prepared.set(input.item.id, input);
        return { executorKind: 'cost-observer', executionId: input.dispatchId };
      },
      execute: async input => {
        if (input.item.kind === 'objective-review') {
          return { status: 'verdict', verdict: objectivePass(input.mission.id) };
        }
        if (input.item.kind === 'final-review') {
          return { status: 'verdict', verdict: {
            targetType: 'mission', targetId: input.mission.id, result: 'pass', summary: 'Mission passed',
            criteria: [{
              criterionId: 'mission-ok', result: 'pass', evidenceRefs: ['test://mission'], explanation: 'OK',
            }],
            affectedWorkItemIds: [], corrections: [],
          } };
        }
        return {
          status: 'submission',
          submission: { summary: 'Done', outputRefs: [], evidence: [] },
          ...(input.item.id === 'source' ? {
            telemetry: {
              durationMs: 1,
              tokenUsage: {
                inputTokens: 10, outputTokens: 5, totalTokens: 15, contextTokens: 10, costUsd: 0.07,
              },
            },
          } : {}),
        };
      },
    };
    const service = new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: id => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [],
      executorFactory: () => executor,
      preflightConnections: () => [routeConnection('openai', ['pi/gpt-5.6-terra'])],
      preflightCostEstimator: { estimateUsd: () => 0.1 },
    });

    await service.createAndStart('workspace-1', spec);
    await eventually(() => prepared.has('dependent'));
    expect(prepared.get('source')?.ordinaryRoutePin).toMatchObject({
      measuredMissionUsd: 0,
      projectedRemainingUsd: 0.2,
    });
    expect(prepared.get('dependent')?.ordinaryRoutePin?.measuredMissionUsd).toBeCloseTo(0.07, 10);
    expect(prepared.get('dependent')?.ordinaryRoutePin?.projectedRemainingUsd).toBeCloseTo(0.1, 10);
  });

  it('serializes concurrent route preparation and estimates each work item only once', async () => {
    const createdAt = Date.parse('2026-08-20T10:00:00.000Z');
    saveWorkspaceConfig(root, {
      schemaVersion: 1,
      id: 'workspace-1', name: 'Twin workspace', slug: 'twin-workspace', createdAt, updatedAt: createdAt,
      defaults: { defaultLlmConnection: 'openai', thinkingLevel: 'medium' },
      costControl: {},
    });
    const taskCount = 12;
    const base = fixture('concurrent-route-decisions');
    const spec = MissionSpecSchema.parse({
      ...base,
      policy: { ...base.policy, maxConcurrentAgents: taskCount },
      workItems: [
        base.workItems.find(item => item.id === 'objective'),
        ...Array.from({ length: taskCount }, (_, index) => ({
          id: `parallel-${index}`, kind: 'task', title: 'Same task', prompt: 'Perform the same bounded check',
          objectiveId: 'objective', acceptanceCriteria: [{ id: `parallel-ok-${index}`, description: 'Done' }],
        })),
      ],
    });
    let estimateCalls = 0;
    const prepared: MissionExecutionInput[] = [];
    const never = new Promise<MissionExecutionResult>(() => {});
    const service = new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: id => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [],
      executorFactory: () => ({
        prepare: async input => {
          prepared.push(input);
          return { executorKind: 'concurrent-observer', executionId: input.dispatchId };
        },
        execute: async () => never,
      }),
      preflightConnections: () => [routeConnection('openai', ['pi/gpt-5.6-terra'])],
      preflightCostEstimator: { estimateUsd: () => {
        estimateCalls += 1;
        return 0.01;
      } },
    });

    await service.createAndStart('workspace-1', spec);
    await eventually(() => prepared.length === taskCount);
    expect(estimateCalls).toBe(taskCount);
    expect(new Set(prepared.map(input => input.ordinaryRoutePin?.routeDecisionSha256)).size).toBe(1);
    for (const input of prepared) {
      expect(input.ordinaryRoutePin?.measuredMissionUsd).toBe(0);
      expect(input.ordinaryRoutePin?.projectedRemainingUsd).toBeCloseTo(taskCount * 0.01, 10);
    }
  });

  it('blocks route-config, endpoint, credential-generation, and source drift after prepare', async () => {
    const runCase = async (
      name: string,
      configure: (caseRoot: string, spec: MissionSpec) => (() => void) | void,
      expectedReason: string,
    ): Promise<void> => {
      const caseRoot = join(root, name);
      mkdirSync(caseRoot, { recursive: true });
      const createdAt = Date.parse('2026-08-20T10:00:00.000Z');
      saveWorkspaceConfig(caseRoot, {
        schemaVersion: 1,
        id: 'workspace-1', name: 'Twin workspace', slug: 'twin-workspace', createdAt, updatedAt: createdAt,
        defaults: { defaultLlmConnection: 'openai', thinkingLevel: 'medium' },
        costControl: {},
      });
      const spec = fixture(`drift-${name}`);
      spec.policy.maxConcurrentAgents = 1;
      spec.policy.maxTechnicalAttempts = 1;
      spec.workItems = spec.workItems.filter(item => item.id === 'objective' || item.id === 'source');
      let credentialGeneration = 'credential-a';
      let connection = {
        ...routeConnection('openai', ['pi/gpt-5.6-terra']),
        authType: 'api_key' as const,
        baseUrl: 'https://one.example.test',
      };
      const mutateConfiguredState = configure(caseRoot, spec);
      let executeCount = 0;
      const service = new MissionRuntimeService({
        sessionManager,
        resolveWorkspace: id => id === 'workspace-1' ? { id, rootPath: caseRoot } : null,
        listWorkspaces: () => [],
        preflightConnections: () => [connection],
        ordinaryRouteCredentialBindingResolver: () => ({
          slot: 'llm_api_key', bindingId: credentialGeneration,
        }),
        executorFactory: () => ({
          prepare: async input => {
            if (name === 'endpoint') {
              connection = { ...connection, baseUrl: 'https://two.example.test' };
            } else if (name === 'credential') {
              credentialGeneration = 'credential-b';
            } else {
              mutateConfiguredState?.();
            }
            return { executorKind: 'drift-observer', executionId: input.dispatchId };
          },
          execute: async () => {
            executeCount += 1;
            return { status: 'failed', reason: 'must not execute', retryable: false };
          },
        }),
      });

      await service.createAndStart('workspace-1', spec);
      await eventually(() =>
        new MissionController({ workspaceRoot: caseRoot }).getMission(spec.id).status === 'blocked');
      const blocked = new MissionController({ workspaceRoot: caseRoot }).getMission(spec.id);
      expect(blocked.workItems.source?.statusReason).toContain(expectedReason);
      if (name === 'source') {
        expect(blocked.workItems.source?.executionBinding?.missionRoute?.effectiveSourceBindings)
          .toEqual([{
            slug: 'local-docs',
            identitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          }]);
      }
      expect(executeCount).toBe(0);
    };

    await runCase('endpoint', () => undefined, 'connection endpoint');
    await runCase('credential', () => undefined, 'credential binding drifted');
    await runCase('route-config', caseRoot => () => saveWorkspaceConfig(caseRoot, {
      schemaVersion: 1,
      id: 'workspace-1', name: 'Twin workspace', slug: 'twin-workspace',
      createdAt: Date.parse('2026-08-20T10:00:00.000Z'),
      updatedAt: Date.parse('2026-08-20T11:00:00.000Z'),
      defaults: { defaultLlmConnection: 'openai', thinkingLevel: 'medium' },
      costControl: { budgets: { softSessionUsd: 5 } },
    }), 'route configuration drifted');
    await runCase('source', (caseRoot, spec) => {
      const sourceConfig = {
        id: 'local-docs-id', name: 'Local docs', slug: 'local-docs', enabled: true,
        provider: 'custom' as const, type: 'local' as const, local: { path: caseRoot },
        routingSensitivity: 'internal' as const,
      };
      saveSourceConfig(caseRoot, sourceConfig);
      spec.agentProfiles = spec.agentProfiles.map(profile => profile.id === 'worker'
        ? { ...profile, sources: ['local-docs'] }
        : profile);
      return () => saveSourceConfig(caseRoot, {
        ...sourceConfig,
        routingSensitivity: 'confidential',
      });
    }, 'source configuration or credential binding');
  });

  it('refuses environment authentication without a host-attestable credential generation', async () => {
    await expect(ordinaryMissionConnectionIdentity({
      agentProfileId: 'worker',
      connection: {
        ...routeConnection('environment-auth', ['pi/gpt-5.6-terra']),
        authType: 'environment',
      },
      connectionSlug: 'environment-auth',
      model: 'pi/gpt-5.6-terra',
      thinkingLevel: 'medium',
      credentialBindingResolver: () => null,
    })).rejects.toThrow('no host-attestable credential generation');
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
  }, 30_000); // Includes 100 durable journal rewrites; allow slower CI disks.
});
