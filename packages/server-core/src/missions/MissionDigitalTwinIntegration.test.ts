import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultWorkspaceGovernance } from "@craft-agent/shared/governance";
import { MissionSpecSchema, readMissionEvents } from "@craft-agent/shared/missions";
import { saveWorkspaceConfig } from "@craft-agent/shared/workspaces";
import type { ISessionManager } from "../handlers/session-manager-interface.ts";
import { MissionController } from "./MissionController.ts";
import { MissionRuntimeService } from "./MissionRuntimeService.ts";
import { expectPreviewRefusalWithoutWrites, externalFixture, fixture, objectivePass, routeConnection } from "./testing/MissionDigitalTwinIntegration-fixture.ts";

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
});
