import { expect } from "bun:test";
import { MissionSpecSchema, readMissionEvents, type MissionSnapshot, type MissionSpec, type MissionWorkItem, type StructuredMissionVerdict } from "@craft-agent/shared/missions";
import { MissionController } from "../MissionController.ts";



export function routeConnection(slug: string, models = ['pi/gpt-5.6-luna', 'pi/gpt-5.6-terra', 'pi/gpt-5.6-sol']) {
  const defaultModel = models[1] ?? models[0];
  return {
    slug,
    providerType: 'pi' as const,
    piAuthProvider: 'openai',
    models,
    ...(defaultModel !== undefined ? { defaultModel } : {}),
  };
}


export function fixture(id = 'twin-integration'): MissionSpec {
  return MissionSpecSchema.parse({
    schemaVersion: 2,
    id,
    title: 'Mission twin integration',
    objective: 'Replan safely',
    acceptanceCriteria: [{ id: 'mission-ok', description: 'Mission complete' }],
    plannerProfileId: 'planner',
    defaultWorkerProfileId: 'worker',
    reviewerProfileId: 'reviewer',
    supervisorProfileId: 'supervisor',
    agentProfiles: [
      { id: 'planner', role: 'planner', specialty: 'plan', systemPrompt: 'Plan.' },
      { id: 'worker', role: 'worker', specialty: 'work', systemPrompt: 'Work.' },
      { id: 'reviewer', role: 'reviewer', specialty: 'review', systemPrompt: 'Review.' },
      { id: 'supervisor', role: 'supervisor', specialty: 'supervise', systemPrompt: 'Supervise.' },
    ],
    policy: { maxConcurrentAgents: 3, maxWorkItems: 40 },
    workItems: [
      {
        id: 'objective', kind: 'objective', title: 'Objective',
        acceptanceCriteria: [{ id: 'objective-ok', description: 'Objective complete' }],
      },
      {
        id: 'source', kind: 'task', title: 'Source', prompt: 'Read source', objectiveId: 'objective',
        acceptanceCriteria: [{ id: 'source-ok', description: 'Source complete' }],
      },
      {
        id: 'dependent', kind: 'task', title: 'Dependent', prompt: 'Use source', objectiveId: 'objective',
        dependsOn: ['source'], acceptanceCriteria: [{ id: 'dependent-ok', description: 'Dependent complete' }],
      },
      {
        id: 'independent', kind: 'task', title: 'Independent', prompt: 'Independent work', objectiveId: 'objective',
        acceptanceCriteria: [{ id: 'independent-ok', description: 'Independent complete' }],
      },
    ],
  });
}


export function externalFixture(id = 'twin-external'): MissionSpec {
  const base = fixture(id);
  return MissionSpecSchema.parse({
    ...base,
    workItems: base.workItems.map((item) => item.id === 'source' ? {
      ...item,
      effect: 'external-mutation',
      requiredEvidence: [{ id: 'mutation-receipt', description: 'Mutation receipt', kind: 'receipt' }],
      connectorInvocation: {
        schemaVersion: 1,
        pack: 'googleWorkspace',
        operationId: 'drive.update',
        resourceType: 'file',
        resourceId: 'file-1',
        payload: { name: 'report.xlsx' },
        autonomy: 'A3',
        receiptRequirementId: 'mutation-receipt',
        compensation: { strategy: 'manual' },
      },
    } : item),
  });
}


export function expectPreviewRefusalWithoutWrites(
  workspaceRoot: string,
  controller: MissionController,
  snapshot: MissionSnapshot,
  proposedWorkItems: MissionWorkItem[],
  expected: RegExp,
): void {
  const missionId = snapshot.spec.id;
  const eventsBefore = readMissionEvents(workspaceRoot, missionId);
  expect(() => controller.previewReplan(
    missionId,
    snapshot.revision,
    proposedWorkItems,
  )).toThrow(expected);
  expect(readMissionEvents(workspaceRoot, missionId)).toEqual(eventsBefore);
}


export function objectivePass(_missionId: string): StructuredMissionVerdict {
  return {
    targetType: 'objective',
    targetId: 'objective',
    result: 'pass',
    summary: 'Objective passed',
    criteria: [{
      criterionId: 'objective-ok',
      result: 'pass',
      evidenceRefs: ['workspace:///objective-proof.json'],
      explanation: 'All work passed',
    }],
    affectedWorkItemIds: [],
    corrections: [],
  };
}


export async function eventually(assertion: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Mission runtime');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
