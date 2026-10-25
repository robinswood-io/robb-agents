import { beginObjectiveEvidenceGate as beginAuthorizedObjectiveEvidenceGate } from "../../objective-evidence-gate.ts";



export function beginObjectiveEvidenceGate(sessionId: string, objectiveId: string, objectiveText: string) {
  return beginAuthorizedObjectiveEvidenceGate(sessionId, objectiveId, objectiveText);
}
