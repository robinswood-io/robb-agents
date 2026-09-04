import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MissionSpecSchema,
  type MissionExecutionBinding,
  type MissionSpec,
} from '@craft-agent/shared/missions';
import { MissionController } from './MissionController.ts';
import {
  MissionRuntime,
  type MissionExecutionInput,
  type MissionExecutionResult,
  type MissionWorkExecutor,
} from './MissionRuntime.ts';

function fixture(): MissionSpec {
  return MissionSpecSchema.parse({
    schemaVersion: 2,
    id: 'runtime-demo',
    title: 'Runtime demo',
    objective: 'Livrer un résultat contrôlé',
    acceptanceCriteria: [{ id: 'mission-ok', description: 'Mission complète' }],
    originSessionId: 'origin',
    plannerSessionId: 'planner-session',
    plannerProfileId: 'planner',
    defaultWorkerProfileId: 'worker',
    reviewerProfileId: 'reviewer',
    supervisorProfileId: 'supervisor',
    agentProfiles: [
      { id: 'planner', role: 'planner', specialty: 'plan', systemPrompt: 'Planifier.' },
      { id: 'worker', role: 'worker', specialty: 'travail', systemPrompt: 'Exécuter.' },
      { id: 'reviewer', role: 'reviewer', specialty: 'qualité', systemPrompt: 'Contrôler.' },
      { id: 'supervisor', role: 'supervisor', specialty: 'global', systemPrompt: 'Superviser.' },
    ],
    policy: { maxConcurrentAgents: 2, maxCorrectionCycles: 2, maxTechnicalAttempts: 2, maxWorkItems: 20, maxDepth: 4 },
    workItems: [
      {
        id: 'objective-one', kind: 'objective', title: 'Objectif',
        acceptanceCriteria: [{ id: 'objective-ok', description: 'Objectif conforme' }],
      },
      {
        id: 'task-a', kind: 'task', title: 'Travail A', prompt: 'Faire A',
        parentId: 'objective-one', objectiveId: 'objective-one',
        acceptanceCriteria: [{ id: 'task-ok', description: 'Travail conforme' }],
        requiredEvidence: [{ id: 'test-a', description: 'Test A', kind: 'test' }],
      },
    ],
  });
}

function successfulResult(input: MissionExecutionInput): MissionExecutionResult {
  if (input.item.kind === 'objective-review') {
    return {
      status: 'verdict',
      verdict: {
        targetType: 'objective', targetId: 'objective-one', result: 'pass', summary: 'Objectif conforme',
        criteria: [{ criterionId: 'objective-ok', result: 'pass', evidenceRefs: ['test://objective'], explanation: 'OK' }],
        affectedWorkItemIds: [], corrections: [],
      },
    };
  }
  if (input.item.kind === 'final-review') {
    return {
      status: 'verdict',
      verdict: {
        targetType: 'mission', targetId: 'runtime-demo', result: 'pass', summary: 'Mission conforme',
        criteria: [{ criterionId: 'mission-ok', result: 'pass', evidenceRefs: ['test://mission'], explanation: 'OK' }],
        affectedWorkItemIds: [], corrections: [],
      },
    };
  }
  return {
    status: 'submission',
    submission: {
      summary: 'Travail terminé', outputRefs: ['artifact://a'],
      evidence: [{ requirementId: 'test-a', uri: 'test://a', kind: 'test' }],
    },
  };
}

class ScriptedExecutor implements MissionWorkExecutor {
  readonly prepared: MissionExecutionInput[] = [];
  readonly executed: MissionExecutionInput[] = [];
  failuresBeforeSuccess = 0;

  async prepare(input: MissionExecutionInput): Promise<MissionExecutionBinding> {
    this.prepared.push(input);
    return { executorKind: 'scripted', executionId: `execution-${input.dispatchId}` };
  }

  async execute(input: MissionExecutionInput): Promise<MissionExecutionResult> {
    this.executed.push(input);
    if (input.item.id === 'task-a' && this.failuresBeforeSuccess > 0) {
      this.failuresBeforeSuccess -= 1;
      return { status: 'failed', reason: 'transient provider failure', retryable: true };
    }
    return successfulResult(input);
  }
}

describe('MissionRuntime', () => {
  let root: string;
  let controller: MissionController;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mission-runtime-'));
    controller = new MissionController({ workspaceRoot: root, now: () => new Date('2026-08-18T10:00:00.000Z') });
    controller.createMission(fixture());
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function runtime(executor: MissionWorkExecutor): MissionRuntime {
    return new MissionRuntime({
      workspaceRoot: root,
      controller,
      executor,
      genDispatchId: (missionId, workItemId, attempt) => `${missionId}-${workItemId}-${attempt}`,
    });
  }

  it('drives worker, objective reviewer, and final supervisor through durable reservations', async () => {
    const executor = new ScriptedExecutor();
    const settled = await runtime(executor).runUntilSettled('runtime-demo');
    expect(settled.status).toBe('completed');
    expect(executor.executed.map((input) => input.item.kind)).toEqual([
      'task', 'objective-review', 'final-review',
    ]);
    expect(executor.executed.map((input) => input.profile.role)).toEqual([
      'worker', 'reviewer', 'supervisor',
    ]);
    expect(settled.workItems['task-a']?.executionHistory).toHaveLength(1);
    expect(settled.workItems['final-review-0']?.status).toBe('accepted');
  });

  it('retries a transient read failure with a new durable dispatch identity', async () => {
    const executor = new ScriptedExecutor();
    executor.failuresBeforeSuccess = 1;
    const settled = await runtime(executor).runUntilSettled('runtime-demo');
    expect(settled.status).toBe('completed');
    expect(executor.executed.filter((input) => input.item.id === 'task-a')).toHaveLength(2);
    expect(settled.workItems['task-a']?.attempt).toBe(2);
    expect(settled.workItems['task-a']?.executionHistory).toHaveLength(2);
    expect(new Set(settled.workItems['task-a']?.executionHistory).size).toBe(2);
  });

  it('recovers a reserved dispatch without preparing or reserving a duplicate', async () => {
    controller.startMission('runtime-demo');
    controller.reserveWorkItem('runtime-demo', 'task-a', {
      dispatchId: 'reserved-before-crash',
      binding: { executorKind: 'scripted', executionId: 'execution-before-crash' },
    });
    const executor = new ScriptedExecutor();
    const settled = await runtime(executor).runUntilSettled('runtime-demo');
    expect(settled.status).toBe('completed');
    expect(executor.prepared.some((input) => input.item.id === 'task-a')).toBe(false);
    expect(executor.executed.find((input) => input.item.id === 'task-a')?.dispatchId).toBe('reserved-before-crash');
    expect(settled.workItems['task-a']?.executionHistory).toEqual(['execution-before-crash']);
  });

  it('does not dispatch when a host runtime policy is already terminal', async () => {
    const executor = new ScriptedExecutor();
    const guarded = new MissionRuntime({
      workspaceRoot: root,
      controller,
      executor,
      evaluateRunPolicy: () => ({ status: 'cancelled', reason: 'Emergency stop is active' }),
    });

    const settled = await guarded.runUntilSettled('runtime-demo');
    expect(settled.status).toBe('cancelled');
    expect(executor.prepared).toHaveLength(0);
    expect(executor.executed).toHaveLength(0);
  });

  it('fails closed after a measured attempt crosses a host runtime budget', async () => {
    const executor = new ScriptedExecutor();
    executor.execute = async (input) => {
      executor.executed.push(input);
      return {
        ...successfulResult(input),
        telemetry: {
          durationMs: 10,
          tokenUsage: {
            inputTokens: 80,
            outputTokens: 30,
            totalTokens: 110,
            contextTokens: 80,
            costUsd: 0.02,
          },
        },
      };
    };
    const guarded = new MissionRuntime({
      workspaceRoot: root,
      controller,
      executor,
      evaluateRunPolicy: (_snapshot, telemetry, completedAttempt) =>
        completedAttempt && (telemetry?.tokenUsage?.totalTokens ?? 0) > 100
          ? { status: 'failed', reason: 'Mission token budget 100 exceeded' }
          : null,
    });

    const settled = await guarded.runUntilSettled('runtime-demo');
    expect(settled.status).toBe('failed');
    expect(settled.workItems['task-a']?.status).toBe('blocked');
    expect(settled.workItems['task-a']?.attemptTelemetry[0]?.tokenUsage?.totalTokens).toBe(110);
    expect(executor.executed.map((input) => input.item.id)).toEqual(['task-a']);
  });
});
