import { describe, expect, it } from 'bun:test';
import { MissionSpecSchema, type MissionSnapshot, type MissionWorkItem } from './index.ts';
import { previewMissionReplan, simulateMissionDigitalTwin } from './digital-twin.ts';

function spec() {
  return MissionSpecSchema.parse({
    schemaVersion: 2, id: 'mission-twin', title: 'Twin', objective: 'Verify before execution',
    acceptanceCriteria: [{ id: 'mission-ok', description: 'Mission complete' }],
    plannerProfileId: 'planner', defaultWorkerProfileId: 'worker',
    reviewerProfileId: 'reviewer', supervisorProfileId: 'supervisor',
    agentProfiles: [
      { id: 'planner', role: 'planner', specialty: 'plan', systemPrompt: 'Plan.' },
      { id: 'worker', role: 'worker', specialty: 'work', systemPrompt: 'Work.' },
      { id: 'reviewer', role: 'reviewer', specialty: 'review', systemPrompt: 'Review.' },
      { id: 'supervisor', role: 'supervisor', specialty: 'supervise', systemPrompt: 'Supervise.' },
    ],
    policy: { maxConcurrentAgents: 2, maxCorrectionCycles: 2, maxWorkItems: 20, maxDepth: 4 },
    workItems: [
      { id: 'objective', kind: 'objective', title: 'Objective', acceptanceCriteria: [{ id: 'objective-ok', description: 'OK' }] },
      { id: 'source', kind: 'task', title: 'Source', prompt: 'Read', objectiveId: 'objective', acceptanceCriteria: [{ id: 'source-ok', description: 'OK' }] },
      { id: 'dependent', kind: 'task', title: 'Dependent', prompt: 'Use source', objectiveId: 'objective', dependsOn: ['source'], acceptanceCriteria: [{ id: 'dependent-ok', description: 'OK' }] },
      { id: 'independent', kind: 'task', title: 'Independent', prompt: 'Work alone', objectiveId: 'objective', acceptanceCriteria: [{ id: 'independent-ok', description: 'OK' }] },
    ],
  });
}

describe('Mission digital twin', () => {
  it('is a pure dry-run and fails closed on missing host observations', () => {
    const mission = spec();
    const before = JSON.stringify(mission);
    const report = simulateMissionDigitalTwin({ spec: mission, generatedAt: '2026-08-20T12:00:00.000Z' });
    expect(report).toMatchObject({ mode: 'dry-run', mutationMode: 'forbidden', readyToStart: false });
    expect(report.gates.some((gate) => gate.status === 'unknown')).toBe(true);
    expect(JSON.stringify(mission)).toBe(before);
  });

  it('passes only when routes, paths, and budget are host-observed', () => {
    const mission = spec();
    const ids = ['source', 'dependent', 'independent'];
    const report = simulateMissionDigitalTwin({
      spec: mission,
      routeByProfileId: {
        worker: { policyAllowed: true, connectionSlug: 'local-safe' },
        reviewer: { policyAllowed: true, connectionSlug: 'local-safe' },
        supervisor: { policyAllowed: true, connectionSlug: 'local-safe' },
      },
      pathPolicyAllowedByWorkItemId: Object.fromEntries(ids.map((id) => [id, true])),
      estimatedCostUsdByWorkItemId: Object.fromEntries(ids.map((id) => [id, 0.1])),
      availableBudgetUsd: 1,
    });
    expect(report).toMatchObject({ readyToStart: true, budgetVarianceKnown: true });
    expect(report.projectedCostUsd).toBeCloseTo(0.3);
  });

  it('fails preflight when a mission-local cost ceiling or deadline is already breached', () => {
    const base = spec();
    const mission = MissionSpecSchema.parse({
      ...base,
      policy: {
        ...base.policy,
        maxTotalCostUsd: 0.2,
        deadline: '2026-09-04T12:00:00Z',
      },
    });
    const ids = ['source', 'dependent', 'independent'];
    const report = simulateMissionDigitalTwin({
      spec: mission,
      routeByProfileId: {
        worker: { policyAllowed: true, connectionSlug: 'local-safe' },
        reviewer: { policyAllowed: true, connectionSlug: 'local-safe' },
        supervisor: { policyAllowed: true, connectionSlug: 'local-safe' },
      },
      pathPolicyAllowedByWorkItemId: Object.fromEntries(ids.map((id) => [id, true])),
      estimatedCostUsdByWorkItemId: Object.fromEntries(ids.map((id) => [id, 0.1])),
      availableBudgetUsd: mission.policy.maxTotalCostUsd,
      generatedAt: '2026-09-04T12:00:00Z',
    });

    expect(report.readyToStart).toBe(false);
    expect(report.gates.find((gate) => gate.id === 'policy.deadline')?.status).toBe('fail');
    expect(report.gates.find((gate) => gate.id === 'budget.projected')?.status).toBe('fail');
  });

  it('invalidates a changed item and its dependants while preserving independent accepted work', () => {
    const mission = spec();
    const runtime = (item: MissionWorkItem) => ({
      definition: item, status: 'accepted' as const, attempt: 1, executionHistory: [],
      externalSessionHistory: [], attemptTelemetry: [],
    });
    const snapshot = {
      spec: mission, status: 'running', revision: 12,
      planVersion: 3, replans: [],
      createdAt: '2026-08-20T10:00:00.000Z', updatedAt: '2026-08-20T11:00:00.000Z',
      correctionCycles: {},
      workItems: Object.fromEntries(mission.workItems.map((item) => [item.id, runtime(item)])),
    } satisfies MissionSnapshot;
    const proposed = mission.workItems.map((item) =>
      item.id === 'source' ? { ...item, prompt: 'Read with new rule' } : item);
    const preview = previewMissionReplan({
      snapshot, expectedRevision: 12, currentPlanVersion: 3, proposedWorkItems: proposed,
    });
    expect(preview).toMatchObject({
      nextPlanVersion: 4,
      changedWorkItemIds: ['source'],
      invalidatedWorkItemIds: ['dependent', 'objective', 'source'],
      preservedAcceptedWorkItemIds: ['independent'],
    });
    expect(() => previewMissionReplan({
      snapshot, expectedRevision: 11, currentPlanVersion: 3, proposedWorkItems: proposed,
    })).toThrow(/revision conflict/);
  });
});
