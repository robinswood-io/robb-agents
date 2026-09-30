import { describe, expect, it } from 'bun:test';
import { MissionSpecSchema } from '@craft-agent/shared/missions';
import type { MissionPreflightRequest } from '@craft-agent/shared/protocol';
import { assertMissionPreflightRequest } from './missions.ts';

const spec = MissionSpecSchema.parse({
  schemaVersion: 2,
  id: 'rpc-preflight',
  title: 'RPC preflight',
  objective: 'Keep observations host-owned',
  acceptanceCriteria: [{ id: 'mission-ok', description: 'Complete' }],
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
  policy: {},
  workItems: [
    { id: 'objective', kind: 'objective', title: 'Objective', acceptanceCriteria: [{ id: 'objective-ok', description: 'Complete' }] },
    { id: 'task', kind: 'task', title: 'Task', prompt: 'Work', objectiveId: 'objective', acceptanceCriteria: [{ id: 'task-ok', description: 'Complete' }] },
  ],
});

describe('Mission digital twin RPC trust boundary', () => {
  it('accepts only a Mission identity/spec and rejects client-authored policy or connector observations', () => {
    expect(() => assertMissionPreflightRequest({ spec })).not.toThrow();
    expect(() => assertMissionPreflightRequest({ missionId: 'rpc-preflight' })).not.toThrow();
    expect(() => assertMissionPreflightRequest({
      spec,
      policyAllowed: true,
      connectorReady: true,
      availableBudgetUsd: 1_000,
    } as unknown as MissionPreflightRequest)).toThrow(/Unexpected Mission preflight request fields/);
    expect(() => assertMissionPreflightRequest({
      missionId: 'rpc-preflight',
      spec,
    } as unknown as MissionPreflightRequest)).toThrow(/exactly one/);
  });
});
