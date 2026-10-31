import { SessionManager as FixtureSessionManager } from "../sessions/SessionManager";
import { canonicalOperationValue } from '@craft-agent/shared/governance';
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionSpecSchema, missionJournalPath, readMissionEvents } from "@craft-agent/shared/missions";
import { saveWorkspaceConfig } from "@craft-agent/shared/workspaces";
import type { ISessionManager } from "../handlers/session-manager-interface.ts";
import { MissionController } from "./MissionController.ts";
import { type MissionExecutionInput, type MissionExecutionResult, type MissionWorkExecutor } from "./MissionRuntime.ts";
import { MissionRuntimeService } from "./MissionRuntimeService.ts";
import { eventually, expectPreviewRefusalWithoutWrites, externalFixture, fixture, objectivePass, routeConnection } from "./testing/MissionDigitalTwinIntegration-fixture.ts";

describe('Mission digital twin host integration', () => {
  let root: string;

  let sessionManager: ISessionManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mission-twin-integration-'));
    sessionManager = Object.assign(new FixtureSessionManager(), ({
      waitForInit: async () => {},
      getSessions: () => [],
      cancelProcessing: async () => {},
    } satisfies Partial<ISessionManager>));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

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
    expect<unknown>(preparedInput?.profile).toMatchObject({
      llmConnection: 'openai',
      model: 'pi/gpt-5.6-terra',
      thinkingLevel: (expect.any(String) as unknown),
    });

    catalogueModels = ['pi/gpt-5.6-sol'];
    releasePrepare();
    await eventually(() =>
      new MissionController({ workspaceRoot: root }).getMission('route-drift').status === 'blocked');

    const blocked = new MissionController({ workspaceRoot: root }).getMission('route-drift');
    expect<unknown>(blocked.workItems["source"]?.executionBinding?.missionRoute).toMatchObject({
      routeDecisionSha256: (expect.stringMatching(/^[a-f0-9]{64}$/) as unknown),
      connectionSlug: 'openai',
      model: 'pi/gpt-5.6-terra',
    });
    expect(blocked.workItems["source"]?.statusReason).toContain('drifted after prepare');
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
        .getMission(spec.id).workItems["source"]?.executionBinding?.missionRoute,
    ));
    const route = new MissionController({ workspaceRoot: root })
      .getMission(spec.id).workItems["source"]!.executionBinding!.missionRoute!;
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
    expect(canonicalOperationValue(executedInput?.ordinaryRoutePin)).toBe(canonicalOperationValue(route));
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
    expect(blocked.workItems["source"]?.statusReason).toContain('missing from the durable dispatch binding');
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
});
