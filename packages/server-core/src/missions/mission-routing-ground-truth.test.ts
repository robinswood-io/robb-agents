import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutingOutcomeStore } from '@craft-agent/shared/config';
import type { MissionSnapshot } from '@craft-agent/shared/missions';
import { recordMissionRoutingGroundTruth } from './mission-routing-ground-truth.ts';

function snapshot(): MissionSnapshot {
  return {
    spec: {
      schemaVersion: 2,
      id: 'verified-mission',
      title: 'Verified mission',
      objective: 'Produce verified output',
      acceptanceCriteria: [{ id: 'mission-pass', description: 'Mission passes' }],
      plannerProfileId: 'planner',
      defaultWorkerProfileId: 'worker',
      reviewerProfileId: 'reviewer',
      supervisorProfileId: 'supervisor',
      agentProfiles: [],
      policy: {} as never,
      workItems: [],
    },
    status: 'completed',
    revision: 8,
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T11:00:00.000Z',
    workItems: {
      work: {
        definition: {
          id: 'work', kind: 'task', title: 'Work', prompt: 'Do work', objectiveId: 'objective',
          dependsOn: [], acceptanceCriteria: [{ id: 'done', description: 'Done' }],
          requiredEvidence: [], effect: 'read',
        },
        status: 'accepted',
        attempts: 1,
        correctionCycles: 0,
        externalSessionId: 'session-1',
      },
    },
  } as unknown as MissionSnapshot;
}

describe('recordMissionRoutingGroundTruth', () => {
  it('promotes exactly one accepted work item observation after Mission PASS', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-mission-routing-'));
    const store = new RoutingOutcomeStore(root);
    store.record({
      id: 'runtime-1', connectionSlug: 'candidate', difficulty: 'standard',
      status: 'success', durationMs: 25, evidenceKind: 'runtime',
      workspaceId: 'workspace-1', missionId: 'verified-mission', sessionId: 'session-1',
      timestamp: '2026-08-20T10:30:00.000Z',
    });
    expect(recordMissionRoutingGroundTruth(root, snapshot())).toMatchObject({
      recorded: 1, alreadyRecorded: 0, missingRuntimeObservationWorkItemIds: [],
    });
    expect(recordMissionRoutingGroundTruth(root, snapshot())).toMatchObject({
      recorded: 0, alreadyRecorded: 1,
    });
    expect(store.read().filter((outcome) => outcome.evidenceKind === 'mission')).toEqual([
      expect.objectContaining({
        connectionSlug: 'candidate', missionId: 'verified-mission',
        sessionId: 'session-1', qualityScore: 1, status: 'success',
      }),
    ]);
  });

  it('does not invent ground truth when no routed observation exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-mission-routing-missing-'));
    expect(recordMissionRoutingGroundTruth(root, snapshot())).toMatchObject({
      recorded: 0,
      missingRuntimeObservationWorkItemIds: ['work'],
    });
  });
});
