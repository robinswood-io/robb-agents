import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionSpecSchema, missionJournalPath, readMissionEvents, type MissionExecutionBinding, type MissionSpec } from "@craft-agent/shared/missions";
import { saveWorkspaceConfig } from "@craft-agent/shared/workspaces";
import { saveSourceConfig } from "@craft-agent/shared/sources";
import type { ISessionManager } from "../handlers/session-manager-interface.ts";
import { MissionController } from "./MissionController.ts";
import { MissionRuntime, type MissionExecutionInput, type MissionExecutionResult, type MissionWorkExecutor } from "./MissionRuntime.ts";
import { MissionRuntimeService } from "./MissionRuntimeService.ts";
import { ordinaryMissionConnectionIdentity } from "./mission-route-identity.ts";
import { eventually, fixture, routeConnection } from "./testing/MissionDigitalTwinIntegration-fixture.ts";

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
  }, 30_000);
});
