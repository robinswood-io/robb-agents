import { describe, expect, it } from 'bun:test';
import { MissionSpecSchema, StructuredMissionVerdictSchema, type MissionSpec } from './schema.ts';

export function missionFixture(overrides: Record<string, unknown> = {}): MissionSpec {
  return MissionSpecSchema.parse({
    schemaVersion: 2,
    id: 'mission-demo',
    title: 'Mission demo',
    objective: 'Produire un résultat vérifié',
    acceptanceCriteria: [{ id: 'mission-ok', description: 'La mission est complète' }],
    originSessionId: 'origin-session',
    plannerSessionId: 'planner-session',
    plannerProfileId: 'planner',
    defaultWorkerProfileId: 'worker',
    reviewerProfileId: 'reviewer',
    supervisorProfileId: 'supervisor',
    agentProfiles: [
      { id: 'planner', role: 'planner', specialty: 'planification', systemPrompt: 'Planifier.' },
      { id: 'worker', role: 'worker', specialty: 'exécution', systemPrompt: 'Exécuter.' },
      { id: 'reviewer', role: 'reviewer', specialty: 'qualité', systemPrompt: 'Contrôler.' },
      { id: 'supervisor', role: 'supervisor', specialty: 'supervision', systemPrompt: 'Superviser.' },
    ],
    policy: { maxConcurrentAgents: 2, maxCorrectionCycles: 2, maxWorkItems: 30, maxDepth: 4 },
    workItems: [
      {
        id: 'objective-one', kind: 'objective', title: 'Objectif un',
        acceptanceCriteria: [{ id: 'objective-ok', description: 'Objectif conforme' }],
      },
      {
        id: 'task-a', kind: 'task', title: 'Travail A', prompt: 'Faire A',
        parentId: 'objective-one', objectiveId: 'objective-one',
        acceptanceCriteria: [{ id: 'task-a-ok', description: 'A conforme' }],
        requiredEvidence: [{ id: 'test-a', description: 'Test de A', kind: 'test' }],
      },
      {
        id: 'task-b', kind: 'subtask', title: 'Travail B', prompt: 'Faire B',
        parentId: 'task-a', objectiveId: 'objective-one', dependsOn: ['task-a'],
        acceptanceCriteria: [{ id: 'task-b-ok', description: 'B conforme' }],
      },
    ],
    ...overrides,
  });
}

describe('MissionSpecSchema', () => {
  it('separates containment from dependencies and applies profile defaults', () => {
    const spec = missionFixture();
    expect(spec.workItems[2]?.parentId).toBe('task-a');
    expect(spec.workItems[2]?.dependsOn).toEqual(['task-a']);
    expect(spec.agentProfiles[1]?.permissionMode).toBe('safe');
    expect(spec.policy.requireIndependentReview).toBe(true);
  });

  it('rejects dependency cycles and reused control profiles', () => {
    const base = missionFixture();
    expect(MissionSpecSchema.safeParse({
      ...base,
      workItems: base.workItems.map((item) => item.id === 'task-a' ? { ...item, dependsOn: ['task-b'] } : item),
    }).success).toBe(false);
    expect(MissionSpecSchema.safeParse({
      ...base,
      reviewerProfileId: 'worker',
    }).success).toBe(false);
  });

  it('reserves review and correction work for the host controller', () => {
    const base = missionFixture();
    expect(MissionSpecSchema.safeParse({
      ...base,
      workItems: [...base.workItems, {
        id: 'premature-review', kind: 'objective-review', title: 'Review', prompt: 'Review',
        reviewTargetId: 'objective-one', acceptanceCriteria: base.acceptanceCriteria,
      }],
    }).success).toBe(false);
  });

  it('validates mission-local runtime ceilings and timezone-stable deadlines', () => {
    const base = missionFixture();
    expect(MissionSpecSchema.safeParse({
      ...base,
      policy: {
        ...base.policy,
        maxTotalTokens: 50_000,
        maxTotalCostUsd: 2.5,
        deadline: '2026-09-05T18:00:00+02:00',
      },
    }).success).toBe(true);
    expect(MissionSpecSchema.safeParse({
      ...base,
      policy: { ...base.policy, maxTotalTokens: 0 },
    }).success).toBe(false);
    expect(MissionSpecSchema.safeParse({
      ...base,
      policy: { ...base.policy, deadline: '2026-09-05 18:00' },
    }).success).toBe(false);
  });
});
describe('StructuredMissionVerdictSchema', () => {
  it('requires failed work for FAIL and forbids corrections on PASS', () => {
    expect(StructuredMissionVerdictSchema.safeParse({
      targetType: 'objective', targetId: 'objective-one', result: 'fail', summary: 'Échec',
      criteria: [{ criterionId: 'objective-ok', result: 'fail', evidenceRefs: ['test://failed'], explanation: 'Échec' }],
    }).success).toBe(false);
    expect(StructuredMissionVerdictSchema.safeParse({
      targetType: 'objective', targetId: 'objective-one', result: 'pass', summary: 'OK',
      criteria: [{ criterionId: 'objective-ok', result: 'pass', evidenceRefs: ['test://ok'], explanation: 'OK' }],
      affectedWorkItemIds: ['task-a'],
    }).success).toBe(false);
  });
});
