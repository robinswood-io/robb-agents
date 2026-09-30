import { describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { cleanupModeState } from '@craft-agent/shared/agent/mode-manager';
import { MissionSpecSchema } from '@craft-agent/shared/missions';
import * as storage from '@craft-agent/shared/config/storage';
import { loadSession } from '@craft-agent/shared/sessions/storage';
import { saveWorkspaceConfig, type WorkspaceConfig } from '@craft-agent/shared/workspaces';
import { specializedCapabilityIdentity } from '../specialized-profiles/capability-identity.ts';
import { MissionController } from '../missions/MissionController.ts';
import {
  ordinaryMissionConnectionIdentity,
  ordinaryMissionRouteConfigIdentity,
  ordinaryMissionSourceIdentity,
} from '../missions/mission-route-identity.ts';
import { SessionManager } from './SessionManager.ts';

describe('ordinary Mission route provider fence', () => {
  it('persists the exact lock, admits its live identities, and rejects route mutation/drift', async () => {
    const rootPath = mkdtempSync(join(tmpdir(), 'mission-ordinary-route-fence-'));
    const workspace = {
      id: 'route-workspace', slug: 'route-workspace', name: 'Route workspace',
      rootPath, createdAt: 1,
    };
    const projectPath = join(rootPath, 'project');
    mkdirSync(projectPath);
    const model = 'pi/gpt-test';
    const connection = {
      slug: 'ordinary-route', name: 'Ordinary route', providerType: 'pi' as const,
      piAuthProvider: 'openai' as const, authType: 'none' as const,
      baseUrl: 'https://one.example.test', defaultModel: model, models: [model], createdAt: 1,
    };
    const storedConfig = {
      workspaces: [workspace], activeWorkspaceId: null, activeSessionId: null,
      defaultLlmConnection: connection.slug, llmConnections: [connection],
    };
    const loader = spyOn(storage, 'loadStoredConfig').mockImplementation(() => storedConfig as never);
    const workspaceConfig = {
      schemaVersion: 1,
      id: workspace.id, name: workspace.name, slug: workspace.slug, createdAt: 1, updatedAt: 1,
      defaults: {
        defaultLlmConnection: connection.slug,
        thinkingLevel: 'high',
        enabledSourceSlugs: [],
      },
      costControl: {},
    } satisfies WorkspaceConfig;
    saveWorkspaceConfig(rootPath, workspaceConfig);

    const spec = MissionSpecSchema.parse({
      schemaVersion: 2,
      id: 'ordinary-fence', title: 'Ordinary fence', objective: 'Run the exact route',
      acceptanceCriteria: [{ id: 'mission-ok', description: 'Mission complete' }],
      cwd: 'project',
      plannerProfileId: 'planner', defaultWorkerProfileId: 'worker',
      reviewerProfileId: 'reviewer', supervisorProfileId: 'supervisor',
      agentProfiles: [
        { id: 'planner', role: 'planner', specialty: 'plan', systemPrompt: 'Plan.' },
        { id: 'worker', role: 'worker', specialty: 'work', systemPrompt: 'Work.' },
        { id: 'reviewer', role: 'reviewer', specialty: 'review', systemPrompt: 'Review.' },
        { id: 'supervisor', role: 'supervisor', specialty: 'supervise', systemPrompt: 'Supervise.' },
      ],
      policy: { maxConcurrentAgents: 1, maxWorkItems: 10 },
      workItems: [
        {
          id: 'objective', kind: 'objective', title: 'Objective',
          acceptanceCriteria: [{ id: 'objective-ok', description: 'Objective complete' }],
        },
        {
          id: 'task', kind: 'task', title: 'Task', prompt: 'Do the work', objectiveId: 'objective',
          acceptanceCriteria: [{ id: 'task-ok', description: 'Task complete' }],
        },
      ],
    });
    const profile = spec.agentProfiles.find(candidate => candidate.id === 'worker')!;
    const routingDecision = {
      version: 2 as const,
      profile: 'balanced' as const,
      origin: 'mission' as const,
      model,
      thinkingLevel: 'high' as const,
    };
    const routeLock = {
      schemaVersion: 1 as const,
      routeDecisionSha256: specializedCapabilityIdentity({
        schemaVersion: 1,
        connectionSlug: connection.slug,
        routingDecision,
        measuredMissionUsd: 0,
        projectedRemainingUsd: null,
      }),
      routeConfigIdentitySha256: ordinaryMissionRouteConfigIdentity({
        profile,
        config: workspaceConfig,
        defaults: { defaultLlmConnection: connection.slug, defaultThinkingLevel: 'high' },
      }),
      connectionIdentitySha256: await ordinaryMissionConnectionIdentity({
        agentProfileId: profile.id,
        connection,
        connectionSlug: connection.slug,
        model,
        thinkingLevel: 'high',
      }),
      sourceIdentitySha256: await ordinaryMissionSourceIdentity(rootPath, []),
      agentProfileId: profile.id,
      connectionSlug: connection.slug,
      ...routingDecision,
      measuredMissionUsd: 0,
      effectiveSourceSlugs: [],
      effectiveSourceBindings: [],
      cwd: resolvePath(projectPath),
    };

    const controller = new MissionController({ workspaceRoot: rootPath });
    controller.createMission(spec);
    controller.startMission(spec.id);
    controller.reserveWorkItem(spec.id, 'task', {
      dispatchId: 'dispatch-one',
      binding: {
        executorKind: 'session', executionId: 'dispatch-one', missionRoute: routeLock,
      },
    });
    controller.confirmWorkItemDispatch(spec.id, 'task', 'dispatch-one');

    const host = new SessionManager();
    const harness = host as unknown as {
      sessions: Map<string, unknown>;
      sendEvent: () => void;
      emitUnreadSummaryChanged: () => void;
      notifySessionCreated: () => void;
      resolveOrdinaryMissionRouteSnapshot: (managed: unknown) => Promise<unknown>;
    };
    harness.sendEvent = () => {};
    harness.emitUnreadSummaryChanged = () => {};
    harness.notifySessionCreated = () => {};

    try {
      const created = await host.createSession(workspace.id, {
        name: 'Ordinary Mission worker',
        workingDirectory: projectPath,
        permissionMode: 'safe',
        llmConnection: connection.slug,
        connectionRoutePinned: true,
        model,
        modelRoutePinned: true,
        thinkingLevel: 'high',
        thinkingLevelPinned: true,
        enabledSourceSlugs: [],
        missionId: spec.id,
        missionWorkItemId: 'task',
        missionDispatchId: 'dispatch-one',
        missionRole: 'worker',
      }, { missionOrdinaryRouteLock: routeLock });
      controller.bindWorkItemSession(spec.id, 'task', 'dispatch-one', created.id);

      expect(loadSession(rootPath, created.id)?.missionOrdinaryRouteLock).toEqual(routeLock);
      const managed = harness.sessions.get(created.id)!;
      await expect(harness.resolveOrdinaryMissionRouteSnapshot(managed)).resolves.toMatchObject({
        connection: { slug: connection.slug, baseUrl: 'https://one.example.test' },
      });

      expect(() => host.updateWorkingDirectory(created.id, join(rootPath, 'other'))).toThrow(/immutable/);
      (managed as { workingDirectory?: string }).workingDirectory = rootPath;
      await expect(harness.resolveOrdinaryMissionRouteSnapshot(managed)).rejects.toThrow(
        /route projection is unavailable or drifted/,
      );
      (managed as { workingDirectory?: string }).workingDirectory = projectPath;
      expect(() => host.setSessionThinkingLevel(created.id, 'medium')).toThrow(/immutable/);
      await expect(host.updateSessionModel(created.id, workspace.id, 'pi/other')).rejects.toThrow(/immutable/);
      await expect(host.setSessionSources(created.id, ['other-source'])).rejects.toThrow(/immutable/);
      await expect(host.setSessionConnection(created.id, 'other-route')).rejects.toThrow(/immutable/);

      connection.baseUrl = 'https://two.example.test';
      await expect(harness.resolveOrdinaryMissionRouteSnapshot(managed)).rejects.toThrow(
        /connection, authentication, or credential binding drifted/,
      );
    } finally {
      loader.mockRestore();
      for (const id of harness.sessions.keys()) cleanupModeState(id);
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it.each(['routing-off', 'specialized'] as const)(
    'revalidates a symlink-swapped cwd before provider and tool use for %s Missions',
    async (routeKind) => {
      const rootPath = mkdtempSync(join(tmpdir(), `mission-cwd-${routeKind}-`));
      const outside = mkdtempSync(join(tmpdir(), 'mission-cwd-exterior-'));
      const workPath = join(rootPath, 'work');
      const displacedWorkPath = join(rootPath, 'work-before-swap');
      mkdirSync(workPath);
      const workspace = {
        id: `cwd-${routeKind}`, slug: `cwd-${routeKind}`, name: 'Mission cwd fence',
        rootPath, createdAt: 1,
      };
      const connection = {
        slug: 'cwd-route', name: 'Cwd route', providerType: 'pi' as const,
        piAuthProvider: 'openai' as const, authType: 'none' as const,
        baseUrl: 'https://cwd.example.test', defaultModel: 'pi/cwd-test',
        models: ['pi/cwd-test'], createdAt: 1,
      };
      const loader = spyOn(storage, 'loadStoredConfig').mockReturnValue({
        workspaces: [workspace], activeWorkspaceId: null, activeSessionId: null,
        defaultLlmConnection: connection.slug, llmConnections: [connection],
      } as never);
      saveWorkspaceConfig(rootPath, {
        schemaVersion: 1,
        id: workspace.id, name: workspace.name, slug: workspace.slug, createdAt: 1, updatedAt: 1,
        defaults: { defaultLlmConnection: connection.slug, thinkingLevel: 'high' },
      });
      const spec = MissionSpecSchema.parse({
        schemaVersion: 2,
        id: `cwd-${routeKind}`, title: 'Cwd fence', objective: 'Keep the cwd confined',
        acceptanceCriteria: [{ id: 'mission-ok', description: 'Mission complete' }],
        cwd: 'work',
        plannerProfileId: 'planner', defaultWorkerProfileId: 'worker',
        reviewerProfileId: 'reviewer', supervisorProfileId: 'supervisor',
        agentProfiles: [
          { id: 'planner', role: 'planner', specialty: 'plan', systemPrompt: 'Plan.' },
          { id: 'worker', role: 'worker', specialty: 'work', systemPrompt: 'Work.' },
          { id: 'reviewer', role: 'reviewer', specialty: 'review', systemPrompt: 'Review.' },
          { id: 'supervisor', role: 'supervisor', specialty: 'supervise', systemPrompt: 'Supervise.' },
        ],
        policy: { maxConcurrentAgents: 1, maxWorkItems: 10 },
        workItems: [
          {
            id: 'objective', kind: 'objective', title: 'Objective',
            acceptanceCriteria: [{ id: 'objective-ok', description: 'Objective complete' }],
          },
          {
            id: 'task', kind: 'task', title: 'Task', prompt: 'Do the work', objectiveId: 'objective',
            acceptanceCriteria: [{ id: 'task-ok', description: 'Task complete' }],
          },
        ],
      });
      const controller = new MissionController({ workspaceRoot: rootPath });
      controller.createMission(spec);
      controller.startMission(spec.id);
      controller.reserveWorkItem(spec.id, 'task', {
        dispatchId: 'cwd-dispatch',
        binding: { executorKind: 'session', executionId: 'cwd-dispatch' },
      });
      controller.confirmWorkItemDispatch(spec.id, 'task', 'cwd-dispatch');

      const host = new SessionManager();
      const harness = host as unknown as {
        sessions: Map<string, unknown>;
        sendEvent: () => void;
        emitUnreadSummaryChanged: () => void;
        notifySessionCreated: () => void;
        assertMissionProviderExecution: (managed: unknown) => Promise<void>;
        admitBackendToolExecution: (
          managed: unknown,
          runtime: unknown,
          request: { toolUseId: string; toolName: string; toolInput: Record<string, unknown> },
        ) => Promise<void>;
      };
      harness.sendEvent = () => {};
      harness.emitUnreadSummaryChanged = () => {};
      harness.notifySessionCreated = () => {};

      try {
        const created = await host.createSession(workspace.id, {
          name: `${routeKind} Mission`,
          workingDirectory: workPath,
          permissionMode: 'safe',
          llmConnection: connection.slug,
          model: connection.defaultModel,
          thinkingLevel: 'high',
          enabledSourceSlugs: [],
          missionId: spec.id,
          missionWorkItemId: 'task',
          missionDispatchId: 'cwd-dispatch',
          missionRole: 'worker',
          ...(routeKind === 'specialized'
            ? { missionRouteLockSha256: 'a'.repeat(64) }
            : {}),
        });
        controller.bindWorkItemSession(spec.id, 'task', 'cwd-dispatch', created.id);
        const managed = harness.sessions.get(created.id)!;

        if (routeKind === 'routing-off') {
          expect(() => host.updateWorkingDirectory(created.id, rootPath)).toThrow(/immutable/);
        }

        renameSync(workPath, displacedWorkPath);
        symlinkSync(outside, workPath, 'dir');
        let providerCalls = 0;
        await expect((async () => {
          await harness.assertMissionProviderExecution(managed);
          providerCalls += 1;
        })()).rejects.toThrow(/symbolic link/);
        expect(providerCalls).toBe(0);

        let toolCalls = 0;
        await expect((async () => {
          await harness.admitBackendToolExecution(managed, {}, {
            toolUseId: 'cwd-tool', toolName: 'Read', toolInput: { file_path: 'result.txt' },
          });
          toolCalls += 1;
        })()).rejects.toThrow(/symbolic link/);
        expect(toolCalls).toBe(0);
      } finally {
        loader.mockRestore();
        for (const id of harness.sessions.keys()) cleanupModeState(id);
        rmSync(rootPath, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it('rejects API and MCP credential rotation at last source use while admitting public sources', async () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'mission-source-last-use-'));
    try {
      const workspaceRoot = join(configRoot, 'workspace');
      for (const slug of ['api-bound', 'mcp-bound', 'public-api']) {
        mkdirSync(join(workspaceRoot, 'sources', slug), { recursive: true });
      }
      writeFileSync(join(workspaceRoot, 'sources', 'api-bound', 'config.json'), JSON.stringify({
        id: 'api-bound', slug: 'api-bound', name: 'API bound', type: 'api', enabled: true,
        provider: 'custom', isAuthenticated: true, connectionStatus: 'connected',
        api: { baseUrl: 'https://api.example.test', authType: 'header', headerName: 'X-API-Key' },
      }));
      writeFileSync(join(workspaceRoot, 'sources', 'mcp-bound', 'config.json'), JSON.stringify({
        id: 'mcp-bound', slug: 'mcp-bound', name: 'MCP bound', type: 'mcp', enabled: true,
        provider: 'custom', isAuthenticated: true, connectionStatus: 'connected',
        mcp: { transport: 'http', url: 'https://mcp.example.test', authType: 'bearer' },
      }));
      writeFileSync(join(workspaceRoot, 'sources', 'public-api', 'config.json'), JSON.stringify({
        id: 'public-api', slug: 'public-api', name: 'Public API', type: 'api', enabled: true,
        provider: 'custom', connectionStatus: 'connected',
        api: { baseUrl: 'https://public.example.test', authType: 'none' },
      }));

      const probePath = join(configRoot, 'probe.ts');
      const managerPath = join(import.meta.dir, 'SessionManager.ts');
      const identityPath = join(import.meta.dir, '..', 'missions', 'mission-route-identity.ts');
      const capabilityPath = join(import.meta.dir, '..', 'specialized-profiles', 'capability-identity.ts');
      const sourcesPath = join(import.meta.dir, '..', '..', '..', 'shared', 'src', 'sources', 'index.ts');
      writeFileSync(probePath, `
        import { getSourceCredentialManager, loadWorkspaceSources } from ${JSON.stringify(sourcesPath)};
        import { SessionManager } from ${JSON.stringify(managerPath)};
        import {
          ordinaryMissionSourceBindings,
          ordinaryMissionSourceIdentityFromBindings,
        } from ${JSON.stringify(identityPath)};
        import { specializedCapabilityIdentity } from ${JSON.stringify(capabilityPath)};

        const workspaceRoot = ${JSON.stringify(workspaceRoot)};
        const sourceManager = getSourceCredentialManager();
        const sources = loadWorkspaceSources(workspaceRoot);
        const source = (slug) => sources.find(candidate => candidate.config.slug === slug);
        await sourceManager.save(source('api-bound'), {
          value: 'api-secret-a', bindingId: 'api-generation-a',
        });
        await sourceManager.save(source('mcp-bound'), {
          value: 'mcp-secret-a', bindingId: 'mcp-generation-a',
        });
        const effectiveSourceSlugs = ['api-bound', 'mcp-bound', 'public-api'].sort(
          (left, right) => left.localeCompare(right),
        );
        const effectiveSourceBindings = await ordinaryMissionSourceBindings(
          workspaceRoot,
          effectiveSourceSlugs,
        );
        const routingDecision = {
          version: 2, profile: 'balanced', origin: 'mission',
          model: 'pi/test', thinkingLevel: 'high',
        };
        const lock = {
          schemaVersion: 1,
          routeDecisionSha256: specializedCapabilityIdentity({
            schemaVersion: 1,
            connectionSlug: 'ordinary-route',
            routingDecision,
            measuredMissionUsd: 0,
            projectedRemainingUsd: null,
          }),
          routeConfigIdentitySha256: '1'.repeat(64),
          connectionIdentitySha256: '2'.repeat(64),
          sourceIdentitySha256: ordinaryMissionSourceIdentityFromBindings(effectiveSourceBindings),
          agentProfileId: 'worker',
          connectionSlug: 'ordinary-route',
          ...routingDecision,
          measuredMissionUsd: 0,
          effectiveSourceSlugs,
          effectiveSourceBindings,
          cwd: workspaceRoot,
        };
        const managed = {
          id: 'session',
          workspace: { rootPath: workspaceRoot },
          missionOrdinaryRouteLock: lock,
          missionId: 'mission', missionWorkItemId: 'work', missionDispatchId: 'dispatch',
          missionRole: 'worker',
          llmConnection: lock.connectionSlug, model: lock.model,
          thinkingLevel: lock.thinkingLevel, workingDirectory: lock.cwd,
          enabledSourceSlugs: effectiveSourceSlugs,
        };
        const manager = new SessionManager();
        const fence = manager.assertOrdinaryMissionSourceBindingAtTransport.bind(manager);
        await fence(managed, 'api-bound');
        await fence(managed, 'mcp-bound');
        await fence(managed, 'public-api');

        await sourceManager.save(source('api-bound'), {
          value: 'api-secret-b', bindingId: 'api-generation-b',
        });
        let apiRejected = false;
        try { await fence(managed, 'api-bound'); } catch { apiRejected = true; }
        await fence(managed, 'mcp-bound');

        await sourceManager.save(source('mcp-bound'), {
          value: 'mcp-secret-b', bindingId: 'mcp-generation-b',
        });
        let mcpRejected = false;
        try { await fence(managed, 'mcp-bound'); } catch { mcpRejected = true; }
        await fence(managed, 'public-api');
        console.log(JSON.stringify({ apiRejected, mcpRejected }));
      `);

      const child = Bun.spawn([process.execPath, probePath], {
        env: { ...process.env, CRAFT_CONFIG_DIR: configRoot },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, stderr: stderr.trim() }).toMatchObject({ exitCode: 0 });
      expect(JSON.parse(stdout.trim())).toEqual({ apiRejected: true, mcpRejected: true });
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
