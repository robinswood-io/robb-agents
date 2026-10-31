import { describe, expect, it } from "bun:test";
import type { Session } from "@craft-agent/shared/protocol";
import type { MissionExecutionInput } from "./MissionRuntime.ts";
import { SessionMissionExecutor } from "./SessionMissionExecutor.ts";
import { FakeHost, VALID_REVIEW_OUTPUT, addOriginAcceptanceContract, input, reviewInput } from "./testing/SessionMissionExecutor-fixture.ts";

describe('SessionMissionExecutor', () => {
  it('executes a review when its exact literal SSH read is admitted in Safe mode', async () => {
    const host = new FakeHost();
    const command = 'sed -n 1,20p README.md';
    addOriginAcceptanceContract(host, command);
    host.output = VALID_REVIEW_OUTPUT;
    const assignment = reviewInput();
    assignment.profile = { ...assignment.profile, sources: ['rbw-servers'], permissionMode: 'allow-all' };
    const executor = new SessionMissionExecutor({
      host,
      workspaceId: 'workspace-1',
      workspaceRoot: '/tmp',
      resolveSubagentAutonomyContext: () => ({ parentPermissionMode: 'allow-all' }),
    });

    const result = await executor.execute(assignment, await executor.prepare(assignment));

    expect(result).toMatchObject({ status: 'verdict', verdict: { result: 'pass' } });
    expect(host.createCalls).toBe(1);
    expect(host.sent).toHaveLength(1);
    expect(host.sessions[1]).toMatchObject({
      missionRole: 'reviewer',
      permissionMode: 'safe',
      enabledSourceSlugs: ['rbw-servers'],
      executionIsolation: {
        effect: 'read',
        policy: {
          allowedReadToolInvocations: [{
            toolName: 'mcp__rbw-servers__ssh_execute',
            inputJson: JSON.stringify({ command, cwd: '/srv/app', server: 'dev' }),
          }],
        },
      },
    });
    expect(host.sent[0]?.message).toContain('Host-registered exact observations required');
    expect(host.sent[0]?.message).toContain(command);
  });

  it.each([
    {
      label: 'permission mode',
      overrides: { permissionMode: 'allow-all' as const },
      reason: 'permissionMode is allow-all instead of safe',
    },
    {
      label: 'enabled sources',
      overrides: {
        permissionMode: 'safe' as const,
        enabledSourceSlugs: ['unexpected-source'],
        executionIsolation: {
          effect: 'read' as const,
          policy: {
            workspaceRoot: '/tmp', allowedReadPaths: ['.'], allowedWritePaths: [],
            networkAccess: 'disabled' as const, allowedHosts: [], maxCpuPercent: 100,
            maxMemoryMb: 1024, timeoutMs: 30 * 60 * 1000,
          },
        },
      },
      reason: 'enabled sources differ',
    },
    {
      label: 'execution isolation',
      overrides: {
        permissionMode: 'safe' as const,
        enabledSourceSlugs: [],
        executionIsolation: undefined,
      },
      reason: 'execution isolation differs',
    },
  ])('refuses a durable Mission reviewer whose $label drifted before any provider call', async ({ overrides, reason }) => {
    const host = new FakeHost();
    const assignment = reviewInput();
    host.sessions.push({
      id: 'existing-review-session',
      workspaceId: 'workspace-1',
      workspaceName: 'Test',
      lastMessageAt: Date.now(),
      messages: [],
      isProcessing: false,
      missionId: assignment.mission.id,
      missionWorkItemId: assignment.item.id,
      missionDispatchId: assignment.dispatchId,
      missionRole: 'reviewer',
      enabledSourceSlugs: [],
      executionIsolation: {
        effect: 'read',
        policy: {
          workspaceRoot: '/tmp', allowedReadPaths: ['.'], allowedWritePaths: [],
          networkAccess: 'disabled', allowedHosts: [], maxCpuPercent: 100,
          maxMemoryMb: 1024, timeoutMs: 30 * 60 * 1000,
        },
      },
      ...overrides,
    } as Session);
    const executor = new SessionMissionExecutor({
      host,
      workspaceId: 'workspace-1',
      workspaceRoot: '/tmp',
    });

    const result = await executor.execute(assignment, await executor.prepare(assignment));

    expect(result).toMatchObject({
      status: 'failed', retryable: false, ambiguousMutation: false,
    });
    expect(result.status === 'failed' ? result.reason : '').toContain(reason);
    expect(host.createCalls).toBe(0);
    expect(host.sent).toHaveLength(0);
  });

  it('clamps a requested Execute child to Ask and keeps isolation under an Ask parent', async () => {
    const host = new FakeHost();
    const base = input();
    const assignment: MissionExecutionInput = {
      ...base,
      profile: { ...base.profile, permissionMode: 'allow-all' },
    };
    const executor = new SessionMissionExecutor({
      host,
      workspaceId: 'workspace-1',
      workspaceRoot: '/tmp',
      resolveSubagentAutonomyContext: () => ({
        parentPermissionMode: 'ask',
        externalActionPolicy: 'allow-in-execute',
      }),
    });

    const result = await executor.execute(assignment, await executor.prepare(assignment));
    expect(result.status).toBe('submission');
    expect(host.sessions[0]?.permissionMode).toBe('ask');
    expect(host.sessions[0]?.executionIsolation).toBeDefined();
  });

  it('blocks an external mutation when the host provides no reconciled proof', async () => {
    const host = new FakeHost();
    const assignment = input('external-mutation');
    const executor = new SessionMissionExecutor({ host, workspaceId: 'workspace-1', workspaceRoot: '/tmp' });
    const result = await executor.execute(assignment, await executor.prepare(assignment));

    expect(result).toMatchObject({ status: 'failed', retryable: false, ambiguousMutation: true });
  });
});
