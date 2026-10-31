import type { ObjectiveAcceptanceCriterion, ObjectiveProcedureId } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR, criterionIdentity } from './criterion-identities.ts';

/** A receipt-only terminal reconciliation may observe evidence, never rewrite its reviewed contract. */
export function assertTerminalReconciliationAcceptanceContract(
  objective: ActiveSessionObjective,
  criteria: ObjectiveAcceptanceCriterion[],
  procedureId?: ObjectiveProcedureId,
): void {
  if (!objective.terminalReconciliation) return;
  if (procedureId !== undefined && procedureId !== objective.procedure?.id) {
    throw new Error(TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR);
  }
  const registered = objective.acceptanceCriteria ?? [];
  if (!Array.isArray(criteria) || criteria.length !== registered.length) {
    throw new Error(TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR);
  }
  try {
    const incoming = new Map<string, ObjectiveAcceptanceCriterion>();
    for (const criterion of criteria) {
      if (!criterion || typeof criterion.id !== 'string' || incoming.has(criterion.id)) {
        throw new Error(TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR);
      }
      incoming.set(criterion.id, criterion);
    }
    if (incoming.size !== registered.length || registered.some((criterion) => {
      const repeated = incoming.get(criterion.id);
      return !repeated || criterionIdentity(repeated) !== criterionIdentity(criterion);
    })) throw new Error(TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR);
  } catch {
    throw new Error(TERMINAL_RECONCILIATION_ACCEPTANCE_ERROR);
  }
}
