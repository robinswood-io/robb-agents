import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MissionSpecSchema,
  type MissionExecutionBinding,
  type MissionSpec,
} from '@craft-agent/shared/missions';
import type { ISessionManager } from '../handlers/session-manager-interface.ts';
import type { Session } from '@craft-agent/shared/protocol';
import type { SessionCompletionEvent } from '../sessions/SessionManager.ts';
import { MissionController } from './MissionController.ts';
import {
  type MissionExecutionInput,
  type MissionExecutionResult,
  type MissionWorkExecutor,
} from './MissionRuntime.ts';
import { MissionRuntimeService } from './MissionRuntimeService.ts';
import { MissionProofPassportService } from './MissionProofPassportService.ts';
import type { SubagentAutonomyContext } from '../subagents/autonomy-inheritance.ts';

function fixture(overrides: Record<string, unknown> = {}): MissionSpec {
  return MissionSpecSchema.parse({
    schemaVersion: 2,
    id: 'service-demo',
    title: 'Service demo',
    objective: 'Livrer une mission durable',
    acceptanceCriteria: [{ id: 'mission-ok', description: 'Mission conforme' }],
    plannerProfileId: 'planner',
    defaultWorkerProfileId: 'worker',
    reviewerProfileId: 'reviewer',
    supervisorProfileId: 'supervisor',
    agentProfiles: [
      { id: 'planner', role: 'planner', specialty: 'plan', systemPrompt: 'Planifier.' },
      { id: 'worker', role: 'worker', specialty: 'work', systemPrompt: 'Exécuter.' },
      { id: 'reviewer', role: 'reviewer', specialty: 'quality', systemPrompt: 'Contrôler.' },
      { id: 'supervisor', role: 'supervisor', specialty: 'global', systemPrompt: 'Superviser.' },
    ],
    policy: { maxConcurrentAgents: 1 },
    workItems: [
      {
        id: 'objective-one', kind: 'objective', title: 'Objectif',
        acceptanceCriteria: [{ id: 'objective-ok', description: 'Objectif conforme' }],
      },
      {
        id: 'task-a', kind: 'task', title: 'Travail', prompt: 'Faire le travail',
        parentId: 'objective-one', objectiveId: 'objective-one',
        acceptanceCriteria: [{ id: 'task-ok', description: 'Travail conforme' }],
      },
    ],
    ...overrides,
  });
}

class SuccessfulExecutor implements MissionWorkExecutor {
  readonly executed: string[] = [];

  async prepare(input: MissionExecutionInput): Promise<MissionExecutionBinding> {
    return { executorKind: 'scripted', executionId: `execution-${input.dispatchId}` };
  }

  async execute(input: MissionExecutionInput): Promise<MissionExecutionResult> {
    this.executed.push(input.item.id);
    if (input.item.kind === 'objective-review') {
      return { status: 'verdict', verdict: {
        targetType: 'objective', targetId: 'objective-one', result: 'pass', summary: 'Objectif conforme',
        criteria: [{ criterionId: 'objective-ok', result: 'pass', evidenceRefs: ['test://objective'], explanation: 'OK' }],
        affectedWorkItemIds: [], corrections: [],
      } };
    }
    if (input.item.kind === 'final-review') {
      return { status: 'verdict', verdict: {
        targetType: 'mission', targetId: input.mission.id, result: 'pass', summary: 'Mission conforme',
        criteria: [{ criterionId: 'mission-ok', result: 'pass', evidenceRefs: ['test://mission'], explanation: 'OK' }],
        affectedWorkItemIds: [], corrections: [],
      } };
    }
    return { status: 'submission', submission: { summary: 'Terminé', outputRefs: [], evidence: [] } };
  }
}

async function eventually(assertion: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await assertion()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for mission runtime');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('MissionRuntimeService', () => {
  let root: string;
  let executor: SuccessfulExecutor;
  let sessionManager: ISessionManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mission-service-'));
    executor = new SuccessfulExecutor();
    sessionManager = {
      waitForInit: async () => {},
      getSessions: () => [],
      cancelProcessing: async () => {},
    } as unknown as ISessionManager;
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function service(
    autonomyContext?: SubagentAutonomyContext,
    proofPassports?: MissionProofPassportService,
  ): MissionRuntimeService {
    return new MissionRuntimeService({
      sessionManager,
      resolveWorkspace: (id) => id === 'workspace-1' ? { id, rootPath: root } : null,
      listWorkspaces: () => [{ id: 'workspace-1', rootPath: root }],
      executorFactory: () => executor,
      ...(proofPassports ? { proofPassportFactory: () => proofPassports } : {}),
      ...(autonomyContext ? {
        resolveSubagentAutonomyContext: () => autonomyContext,
      } : {}),
    });
  }

  it('creates, runs, lists, and completes a mission through independent reviews', async () => {
    const runtimeService = service();
    const started = await runtimeService.createAndStart('workspace-1', fixture({ cwd: root }));
    expect(started.status).toBe('running');

    await eventually(async () => (await runtimeService.getMission('workspace-1', 'service-demo')).status === 'completed');
    const completed = await runtimeService.getMission('workspace-1', 'service-demo');
    expect(completed.status).toBe('completed');
    expect(executor.executed).toEqual(['task-a', 'review-objective-one-0', 'final-review-0']);
    expect((await runtimeService.listMissions('workspace-1')).map((mission) => mission.spec.id)).toEqual(['service-demo']);
  });

  it('issues and verifies the completion passport before reporting PASS', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const passports = new MissionProofPassportService({
      workspaceId: 'workspace-1', workspaceRoot: root, privateKey,
    });
    const runtimeService = service(undefined, passports);
    await runtimeService.createAndStart('workspace-1', fixture({ cwd: root }));
    await eventually(async () => (await runtimeService.getMission('workspace-1', 'service-demo')).status === 'completed');
    expect((await runtimeService.getProofPassport('workspace-1', 'service-demo'))?.outcome).toBe('pass');
    expect(await runtimeService.verifyProofPassport('workspace-1', 'service-demo'))
      .toMatchObject({ valid: true });
  });

  it('recovers an active reserved dispatch after startup hydration', async () => {
    const controller = new MissionController({ workspaceRoot: root });
    controller.createMission(fixture());
    controller.startMission('service-demo');
    controller.reserveWorkItem('service-demo', 'task-a', {
      dispatchId: 'reserved-before-restart',
      binding: { executorKind: 'scripted', executionId: 'execution-before-restart' },
    });

    const runtimeService = service();
    expect(await runtimeService.start()).toEqual(['workspace-1:service-demo']);
    await eventually(() => controller.getMission('service-demo').status === 'completed');
    expect(executor.executed[0]).toBe('task-a');
  });

  it('fails admission for unenforceable effects and workspace-prefix escapes', async () => {
    const runtimeService = service();
    const external = fixture({
      workItems: fixture().workItems.map((item) => item.id === 'task-a'
        ? {
            ...item,
            effect: 'external-mutation',
            requiredEvidence: [{ id: 'mutation-receipt', description: 'Host receipt', kind: 'receipt' }],
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
          }
        : item),
    });
    await expect(runtimeService.createAndStart('workspace-1', external)).rejects.toThrow(/broker-backed/);

    await expect(runtimeService.createAndStart('workspace-1', fixture({
      id: 'cwd-escape', cwd: `${root}-escape`,
    }))).rejects.toThrow(/not authorized/);

    expect(() => fixture({
      id: 'write-without-envelope',
      workItems: fixture().workItems.map((item) => item.id === 'task-a'
        ? { ...item, effect: 'workspace-write' }
        : item),
    })).toThrow(/allowed write path/i);

    expect(() => fixture({
      id: 'write-safe-profile',
      workItems: fixture().workItems.map((item) => item.id === 'task-a'
        ? { ...item, effect: 'workspace-write', execution: { allowed_write_paths: ['.'] } }
        : item),
    })).toThrow(/safe-mode worker profile/);
  });

  it('admits a workspace write only with explicit paths and a non-safe worker profile', async () => {
    const base = fixture();
    const spec = fixture({
      id: 'write-valid',
      agentProfiles: base.agentProfiles.map((profile) => profile.id === 'worker'
        ? { ...profile, permissionMode: 'ask' }
        : profile),
      workItems: base.workItems.map((item) => item.id === 'task-a'
        ? { ...item, effect: 'workspace-write', execution: { allowed_write_paths: ['.'] } }
        : item),
    });
    const runtimeService = service({ workspacePermissionMode: 'ask', externalActionPolicy: 'confirm' });
    await runtimeService.createAndStart('workspace-1', spec);
    await eventually(async () => (await runtimeService.getMission('workspace-1', spec.id)).status === 'completed');
  });

  it('admits mission network access only for fully inherited Execute profiles', async () => {
    const base = fixture();
    const networkSpec = fixture({
      id: 'network-valid',
      agentProfiles: base.agentProfiles.map((profile) => ({
        ...profile,
        permissionMode: 'allow-all',
      })),
      workItems: base.workItems.map((item) => item.id === 'task-a'
        ? {
            ...item,
            execution: {
              network_access: 'allow-list',
              allowed_hosts: ['api.example.com'],
            },
          }
        : item),
    });

    await expect(service({
      workspacePermissionMode: 'allow-all',
      externalActionPolicy: 'confirm',
    }).createAndStart('workspace-1', networkSpec)).rejects.toThrow(/fully inherited Execute autonomy/);

    const runtimeService = service({
      workspacePermissionMode: 'allow-all',
      externalActionPolicy: 'allow-in-execute',
    });
    await runtimeService.createAndStart('workspace-1', networkSpec);
    await eventually(async () =>
      (await runtimeService.getMission('workspace-1', networkSpec.id)).status === 'completed');
  });

  it('delivers the supervisor report once to the origin chat and persists the receipt', async () => {
    const origin = {
      id: 'origin-session', workspaceId: 'workspace-1', workspaceName: 'Test',
      lastMessageAt: Date.now(), messages: [], isProcessing: false,
    } as Session;
    const listeners = new Set<(event: SessionCompletionEvent) => void>();
    let sends = 0;
    sessionManager = {
      waitForInit: async () => {},
      getSessions: () => [origin],
      getSession: async () => origin,
      cancelProcessing: async () => {},
      onSessionComplete: (listener: (event: SessionCompletionEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      sendMessage: async (_sessionId: string, message: string, _a?: unknown, _b?: unknown, options?: { hidden?: boolean },
        _c?: unknown, _d?: unknown, onAck?: (messageId: string) => void) => {
        sends += 1;
        expect(options?.hidden).toBe(true);
        const userMessage = { id: 'report-user-1', role: 'user' as const, content: message, timestamp: Date.now(), hidden: true };
        origin.messages.push(userMessage);
        onAck?.(userMessage.id);
        queueMicrotask(() => {
          const assistant = {
            id: 'report-assistant-1', role: 'assistant' as const,
            content: 'Mission terminée.', timestamp: Date.now(),
          };
          origin.messages.push(assistant);
          const event: SessionCompletionEvent = {
            sessionId: origin.id, workspaceId: origin.workspaceId, reason: 'complete',
            finalMessageId: assistant.id, finalText: assistant.content,
          };
          for (const listener of listeners) listener(event);
        });
      },
    } as unknown as ISessionManager;

    const runtimeService = service();
    await runtimeService.createAndStart('workspace-1', fixture({ originSessionId: origin.id }));
    await eventually(async () =>
      (await runtimeService.getMission('workspace-1', 'service-demo')).report?.status === 'delivered');
    const delivered = await runtimeService.getMission('workspace-1', 'service-demo');
    expect(delivered.report).toMatchObject({
      status: 'delivered', messageId: 'report-user-1', finalMessageId: 'report-assistant-1',
    });
    expect(origin.messages[0]?.content).toContain('<mission-final-report');
    expect(sends).toBe(1);

    const restarted = service();
    await restarted.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sends).toBe(1);
  });
});
