import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MissionSpecSchema, type MissionSpec, type StructuredMissionVerdict } from '@craft-agent/shared/missions';
import { MissionController } from './MissionController.ts';

function fixture(policy: Record<string, unknown> = {}): MissionSpec {
  return MissionSpecSchema.parse({
    schemaVersion: 2,
    id: 'mission-demo', title: 'Mission demo', objective: 'Livrer un résultat vérifié',
    acceptanceCriteria: [{ id: 'mission-ok', description: 'Mission complète' }],
    originSessionId: 'origin-session', plannerSessionId: 'planner-session',
    plannerProfileId: 'planner', defaultWorkerProfileId: 'worker',
    reviewerProfileId: 'reviewer', supervisorProfileId: 'supervisor',
    agentProfiles: [
      { id: 'planner', role: 'planner', specialty: 'plan', systemPrompt: 'Planifier.' },
      { id: 'worker', role: 'worker', specialty: 'travail', systemPrompt: 'Travailler.' },
      { id: 'reviewer', role: 'reviewer', specialty: 'qualité', systemPrompt: 'Contrôler.' },
      { id: 'supervisor', role: 'supervisor', specialty: 'global', systemPrompt: 'Superviser.' },
    ],
    policy: { maxConcurrentAgents: 2, maxCorrectionCycles: 2, maxWorkItems: 30, maxDepth: 4, ...policy },
    workItems: [
      { id: 'objective-one', kind: 'objective', title: 'Objectif', acceptanceCriteria: [{ id: 'objective-ok', description: 'Objectif conforme' }] },
      {
        id: 'task-a', kind: 'task', title: 'A', prompt: 'Faire A', parentId: 'objective-one', objectiveId: 'objective-one',
        acceptanceCriteria: [{ id: 'a-ok', description: 'A conforme' }],
        requiredEvidence: [{ id: 'test-a', description: 'Test A', kind: 'test' }],
      },
      {
        id: 'task-b', kind: 'subtask', title: 'B', prompt: 'Faire B', parentId: 'task-a', objectiveId: 'objective-one',
        dependsOn: ['task-a'], acceptanceCriteria: [{ id: 'b-ok', description: 'B conforme' }],
      },
    ],
  });
}

const submissionA = {
  summary: 'A terminé', outputRefs: ['artifact://a'],
  evidence: [{ requirementId: 'test-a', uri: 'test://a', kind: 'test' as const }],
};
const submissionB = { summary: 'B terminé', outputRefs: ['artifact://b'], evidence: [] };

function objectiveVerdict(result: 'pass' | 'fail', affectedWorkItemIds: string[] = []): StructuredMissionVerdict {
  return {
    targetType: 'objective', targetId: 'objective-one', result,
    summary: result === 'pass' ? 'Objectif conforme' : 'A doit être corrigé',
    criteria: [{
      criterionId: 'objective-ok', result,
      evidenceRefs: [result === 'pass' ? 'test://objective-ok' : 'test://objective-failed'],
      explanation: result === 'pass' ? 'Conforme' : 'Non conforme',
    }],
    affectedWorkItemIds,
    corrections: [],
  };
}

function finalVerdict(result: 'pass' | 'fail', affectedWorkItemIds: string[] = []): StructuredMissionVerdict {
  return {
    targetType: 'mission', targetId: 'mission-demo', result,
    summary: result === 'pass' ? 'Mission conforme' : 'Mission à corriger',
    criteria: [{
      criterionId: 'mission-ok', result,
      evidenceRefs: [result === 'pass' ? 'test://mission-ok' : 'test://mission-failed'],
      explanation: result === 'pass' ? 'Conforme' : 'Non conforme',
    }],
    affectedWorkItemIds,
    corrections: [],
  };
}

describe('MissionController', () => {
  let root: string;
  let controller: MissionController;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mission-controller-'));
    controller = new MissionController({ workspaceRoot: root, now: () => new Date('2026-08-18T10:00:00.000Z') });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function executeInitialWork(): void {
    controller.createMission(fixture());
    controller.startMission('mission-demo');
    expect(controller.listReadyWork('mission-demo').map(({ item }) => item.id)).toEqual(['task-a']);
    controller.dispatchWorkItem('mission-demo', 'task-a', 'worker-a');
    controller.submitWorkItem('mission-demo', 'task-a', 'worker-a', submissionA);
    expect(controller.listReadyWork('mission-demo').map(({ item }) => item.id)).toEqual(['task-b']);
    controller.dispatchWorkItem('mission-demo', 'task-b', 'worker-b');
    controller.submitWorkItem('mission-demo', 'task-b', 'worker-b', submissionB);
  }

  it('creates linked corrections, rechecks the objective, then requires an independent final supervisor', () => {
    executeInitialWork();
    expect(controller.listReadyWork('mission-demo')[0]?.item.id).toBe('review-objective-one-0');
    expect(() => controller.dispatchWorkItem('mission-demo', 'review-objective-one-0', 'worker-a')).toThrow(/independent session/);
    controller.dispatchWorkItem('mission-demo', 'review-objective-one-0', 'reviewer-1');
    const correcting = controller.recordVerdict(
      'mission-demo', 'review-objective-one-0', 'reviewer-1', objectiveVerdict('fail', ['task-a']),
    );
    expect(correcting.status).toBe('correcting');
    expect(correcting.workItems['task-a']?.status).toBe('superseded');
    expect(correcting.workItems['task-b']?.status).toBe('superseded');
    expect(correcting.workItems['task-a-fix-1']?.definition.correctsWorkItemId).toBe('task-a');
    expect(correcting.workItems['task-b-fix-1']?.definition.dependsOn).toEqual(['task-a-fix-1']);

    controller.dispatchWorkItem('mission-demo', 'task-a-fix-1', 'worker-a-fix');
    controller.submitWorkItem('mission-demo', 'task-a-fix-1', 'worker-a-fix', submissionA);
    controller.dispatchWorkItem('mission-demo', 'task-b-fix-1', 'worker-b-fix');
    controller.submitWorkItem('mission-demo', 'task-b-fix-1', 'worker-b-fix', submissionB);
    expect(controller.listReadyWork('mission-demo')[0]?.item.id).toBe('review-objective-one-1');
    controller.dispatchWorkItem('mission-demo', 'review-objective-one-1', 'reviewer-1');
    controller.recordVerdict('mission-demo', 'review-objective-one-1', 'reviewer-1', objectiveVerdict('pass'));

    expect(controller.listReadyWork('mission-demo')[0]?.item.id).toBe('final-review-0');
    expect(() => controller.dispatchWorkItem('mission-demo', 'final-review-0', 'reviewer-1')).toThrow(/independent session/);
    controller.dispatchWorkItem('mission-demo', 'final-review-0', 'supervisor-1');
    expect(controller.recordVerdict('mission-demo', 'final-review-0', 'supervisor-1', finalVerdict('pass')).status).toBe('completed');
    expect(controller.listReadyWork('mission-demo')).toEqual([]);
  });

  it('reopens an accepted objective when the final supervisor rejects affected work', () => {
    executeInitialWork();
    controller.dispatchWorkItem('mission-demo', 'review-objective-one-0', 'reviewer-1');
    controller.recordVerdict('mission-demo', 'review-objective-one-0', 'reviewer-1', objectiveVerdict('pass'));
    controller.dispatchWorkItem('mission-demo', 'final-review-0', 'supervisor-1');
    const snapshot = controller.recordVerdict('mission-demo', 'final-review-0', 'supervisor-1', finalVerdict('fail', ['task-b']));
    expect(snapshot.status).toBe('correcting');
    expect(snapshot.workItems['objective-one']?.status).toBe('rejected');
    expect(snapshot.workItems['task-b-fix-1']?.definition.correctsWorkItemId).toBe('task-b');
  });

  it('requires declared evidence and fails closed at the correction cap', () => {
    controller.createMission(fixture({ maxCorrectionCycles: 0 }));
    controller.startMission('mission-demo');
    controller.dispatchWorkItem('mission-demo', 'task-a', 'worker-a');
    expect(() => controller.submitWorkItem('mission-demo', 'task-a', 'worker-a', {
      summary: 'sans preuve', outputRefs: [], evidence: [],
    })).toThrow(/Missing required evidence/);
    controller.submitWorkItem('mission-demo', 'task-a', 'worker-a', submissionA);
    controller.dispatchWorkItem('mission-demo', 'task-b', 'worker-b');
    controller.submitWorkItem('mission-demo', 'task-b', 'worker-b', submissionB);
    controller.dispatchWorkItem('mission-demo', 'review-objective-one-0', 'reviewer-1');
    const failed = controller.recordVerdict(
      'mission-demo', 'review-objective-one-0', 'reviewer-1', objectiveVerdict('fail', ['task-a']),
    );
    expect(failed.status).toBe('failed');
    expect(failed.workItems['task-a-fix-1']).toBeUndefined();
  });

  it('counts controller-created reviews against the durable work-item cap', () => {
    controller.createMission(fixture({ maxWorkItems: 3 }));
    controller.startMission('mission-demo');
    controller.dispatchWorkItem('mission-demo', 'task-a', 'worker-a');
    controller.submitWorkItem('mission-demo', 'task-a', 'worker-a', submissionA);
    controller.dispatchWorkItem('mission-demo', 'task-b', 'worker-b');
    const failed = controller.submitWorkItem('mission-demo', 'task-b', 'worker-b', submissionB);
    expect(failed.status).toBe('failed');
    expect(failed.statusReason).toMatch(/maxWorkItems/);
    expect(failed.workItems['review-objective-one-0']).toBeUndefined();
  });

  it('rejects incomplete rubrics and recovers the exact projection after reconstruction', () => {
    executeInitialWork();
    controller.dispatchWorkItem('mission-demo', 'review-objective-one-0', 'reviewer-1');
    expect(() => controller.recordVerdict('mission-demo', 'review-objective-one-0', 'reviewer-1', {
      ...objectiveVerdict('pass'), criteria: [],
    })).toThrow();
    const recovered = new MissionController({ workspaceRoot: root });
    expect(recovered.getMission('mission-demo')).toEqual(controller.getMission('mission-demo'));
    expect(recovered.listReadyWork('mission-demo')).toEqual([]);
  });

  it('journals session binding and accepted-turn identities idempotently across restart', () => {
    controller.createMission(fixture());
    controller.startMission('mission-demo');
    controller.reserveWorkItem('mission-demo', 'task-a', {
      dispatchId: 'dispatch-a',
      binding: { executorKind: 'session', executionId: 'dispatch-a' },
    });
    controller.confirmWorkItemDispatch('mission-demo', 'task-a', 'dispatch-a');

    controller.bindWorkItemSession('mission-demo', 'task-a', 'dispatch-a', 'actual-session-a');
    controller.bindWorkItemSession('mission-demo', 'task-a', 'dispatch-a', 'actual-session-a');
    controller.recordWorkItemTurnAccepted(
      'mission-demo', 'task-a', 'dispatch-a', 'actual-session-a', 'user-message-a',
    );
    controller.recordWorkItemTurnAccepted(
      'mission-demo', 'task-a', 'dispatch-a', 'actual-session-a', 'user-message-a',
    );

    expect(() => controller.bindWorkItemSession(
      'mission-demo', 'task-a', 'dispatch-a', 'different-session',
    )).toThrow(/already bound/);
    expect(() => controller.recordWorkItemTurnAccepted(
      'mission-demo', 'task-a', 'dispatch-a', 'actual-session-a', 'different-message',
    )).toThrow(/already accepted/);

    const recovered = new MissionController({ workspaceRoot: root }).getMission('mission-demo');
    expect(recovered.workItems['task-a']).toMatchObject({
      externalSessionId: 'actual-session-a',
      externalSessionHistory: ['actual-session-a'],
      acceptedMessageId: 'user-message-a',
    });
  });

  it('preserves a user pause while in-flight work settles, then resumes from the journal', () => {
    controller.createMission(fixture());
    controller.startMission('mission-demo');
    controller.dispatchWorkItem('mission-demo', 'task-a', 'worker-a');
    controller.pauseMission('mission-demo', 'User requested a checkpoint');

    const paused = controller.submitWorkItem('mission-demo', 'task-a', 'worker-a', submissionA);
    expect(paused.status).toBe('paused');
    expect(paused.statusReason).toBe('User requested a checkpoint');
    expect(controller.listReadyWork('mission-demo')).toEqual([]);

    const resumed = controller.startMission('mission-demo');
    expect(resumed.status).toBe('running');
    expect(controller.listReadyWork('mission-demo').map(({ item }) => item.id)).toEqual(['task-b']);
  });

  it('cancels every unfinished work item atomically and is idempotent', () => {
    controller.createMission(fixture());
    controller.startMission('mission-demo');
    controller.dispatchWorkItem('mission-demo', 'task-a', 'worker-a');

    const cancelled = controller.cancelMission('mission-demo', 'User cancelled the mission');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.workItems['objective-one']?.status).toBe('cancelled');
    expect(cancelled.workItems['task-a']?.status).toBe('cancelled');
    expect(cancelled.workItems['task-b']?.status).toBe('cancelled');
    expect(controller.cancelMission('mission-demo', 'Repeated cancellation')).toEqual(cancelled);
  });

  it('journals final report reservation, acceptance, and delivery after completion', () => {
    executeInitialWork();
    controller.dispatchWorkItem('mission-demo', 'review-objective-one-0', 'reviewer-1');
    controller.recordVerdict('mission-demo', 'review-objective-one-0', 'reviewer-1', objectiveVerdict('pass'));
    controller.dispatchWorkItem('mission-demo', 'final-review-0', 'supervisor-1');
    controller.recordVerdict('mission-demo', 'final-review-0', 'supervisor-1', finalVerdict('pass'));

    controller.reserveMissionReport('mission-demo', 'report-1', 'origin-session');
    controller.reserveMissionReport('mission-demo', 'report-1', 'origin-session');
    controller.recordMissionReportAccepted('mission-demo', 'report-1', 'origin-session', 'user-report-1');
    controller.recordMissionReportDelivered('mission-demo', 'report-1', 'origin-session', 'assistant-report-1');

    const recovered = new MissionController({ workspaceRoot: root }).getMission('mission-demo');
    expect(recovered.status).toBe('completed');
    expect(recovered.report).toEqual({
      reportId: 'report-1',
      originSessionId: 'origin-session',
      status: 'delivered',
      messageId: 'user-report-1',
      finalMessageId: 'assistant-report-1',
    });
  });
});
