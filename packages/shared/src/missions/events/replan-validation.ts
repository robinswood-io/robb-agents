import { type MissionReplanPreview } from "../digital-twin.ts";

export function assertExactReplanPreview(
  actual: MissionReplanPreview,
  expected: MissionReplanPreview,
): void {
  const scalarKeys = [
    'schemaVersion',
    'missionId',
    'baseRevision',
    'previousPlanVersion',
    'nextPlanVersion',
    'previousFingerprint',
    'proposedFingerprint',
  ] as const;
  for (const key of scalarKeys) {
    if (actual[key] !== expected[key]) {
      throw new Error(`Mission replan preview drift at ${key}`);
    }
  }
  const listKeys = [
    'addedWorkItemIds',
    'removedWorkItemIds',
    'changedWorkItemIds',
    'invalidatedWorkItemIds',
    'preservedAcceptedWorkItemIds',
  ] as const;
  for (const key of listKeys) {
    if (actual[key].length !== expected[key].length
        || actual[key].some((value, index) => value !== expected[key][index])) {
      throw new Error(`Mission replan preview drift at ${key}`);
    }
  }
}
