import type { ActiveSessionObjective } from '@craft-agent/shared/sessions'

export interface ObjectiveSessionStatusInput {
  sessionStatus?: string
  activeObjective?: Pick<ActiveSessionObjective, 'terminalState'>
}

/**
 * Project host objective truth into the UI status taxonomy.
 *
 * Persisted board status can lag the objective event (or retain an old
 * lifecycle handoff such as `needs-review`). Terminal objective state is the
 * stronger signal and must win everywhere the UI groups, filters or labels a
 * conversation. Active objectives intentionally retain the persisted status:
 * users may organize ongoing work with custom open statuses.
 */
export function resolveObjectiveSessionStatus(
  session: ObjectiveSessionStatusInput,
): string {
  switch (session.activeObjective?.terminalState) {
    case 'complete_verified':
      return 'done'
    case 'blocked_human':
    case 'blocked_policy':
    case 'exhausted': {
      // Preserve an already-terminal lifecycle projection (including localized
      // aliases). Only replace statuses that still claim the work is active.
      const persisted = session.sessionStatus?.normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
      if (persisted && ['blocked', 'bloque', 'needs-review', 'a-valider'].includes(persisted)) {
        return session.sessionStatus!
      }
      return 'needs-review'
    }
    default:
      return session.sessionStatus || 'todo'
  }
}
