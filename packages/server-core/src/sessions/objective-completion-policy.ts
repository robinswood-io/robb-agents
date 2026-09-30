import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';

/** Registration is a completion obligation, regardless of initial intent wording. */
export function requiresStructuredObjectiveOutcome(objective: ActiveSessionObjective): boolean {
  return objective.orchestrationMode === 'mission'
    || objective.requiresExecutionEvidence === true
    || objective.requiresObservationEvidence === true
    || objective.requiresAcceptanceCriteria === true
    || (objective.acceptanceCriteria?.length ?? 0) > 0;
}
