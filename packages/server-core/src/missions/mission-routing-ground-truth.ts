import { createHash } from 'node:crypto';
import { RoutingOutcomeStore, type RoutingOutcome } from '@craft-agent/shared/config';
import type { MissionSnapshot } from '@craft-agent/shared/missions';

export interface MissionRoutingGroundTruthResult {
  recorded: number;
  alreadyRecorded: number;
  missingRuntimeObservationWorkItemIds: string[];
}

function verifiedOutcomeId(missionId: string, workItemId: string, sourceId: string): string {
  return `mission-verified-${createHash('sha256')
    .update(`${missionId}\0${workItemId}\0${sourceId}`)
    .digest('hex')}`;
}

/**
 * Converts one accepted Mission work item into at most one business-grounded
 * routing outcome. A completed provider stream alone never reaches this path:
 * the Mission must have passed independent review and Proof Passport issuance.
 */
export function recordMissionRoutingGroundTruth(
  workspaceRoot: string,
  snapshot: MissionSnapshot,
): MissionRoutingGroundTruthResult {
  if (snapshot.status !== 'completed') {
    throw new Error('Routing ground truth requires a completed Mission');
  }
  const store = new RoutingOutcomeStore(workspaceRoot);
  const runtime = store.read({ missionId: snapshot.spec.id })
    .filter((outcome) => (outcome.evidenceKind ?? 'runtime') === 'runtime');
  let recorded = 0;
  let alreadyRecorded = 0;
  const missingRuntimeObservationWorkItemIds: string[] = [];

  for (const workItem of Object.values(snapshot.workItems)) {
    if (workItem.status !== 'accepted' || !workItem.externalSessionId) continue;
    const source = latestSuccessful(runtime, workItem.externalSessionId);
    if (!source) {
      missingRuntimeObservationWorkItemIds.push(workItem.definition.id);
      continue;
    }
    const groundTruth: RoutingOutcome = {
      ...source,
      id: verifiedOutcomeId(snapshot.spec.id, workItem.definition.id, source.id),
      evidenceKind: 'mission',
      status: 'success',
      qualityScore: 1,
      timestamp: snapshot.updatedAt,
      missionId: snapshot.spec.id,
    };
    if (store.record(groundTruth)) recorded += 1;
    else alreadyRecorded += 1;
  }

  return { recorded, alreadyRecorded, missingRuntimeObservationWorkItemIds };
}

function latestSuccessful(outcomes: RoutingOutcome[], sessionId: string): RoutingOutcome | undefined {
  return outcomes
    .filter((outcome) => outcome.sessionId === sessionId && outcome.status === 'success')
    .sort((left, right) => (right.timestamp ?? '').localeCompare(left.timestamp ?? ''))[0];
}
