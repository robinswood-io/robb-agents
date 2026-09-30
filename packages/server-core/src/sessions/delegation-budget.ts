import type { ActiveSessionObjective, SessionDelegation } from '@craft-agent/shared/sessions';
import { assertCanonicalPermissionMode, type PermissionMode } from '@craft-agent/shared/agent/mode-manager';

/** Host-only limits shared by the entire objective, including restored children. */
export const DELEGATION_LIMITS = Object.freeze({ maxDepth: 2, maxChildren: 8, maxConcurrent: 4 });
export interface DelegationSession {
  id: string;
  delegation?: SessionDelegation;
  activeObjective?: ActiveSessionObjective;
  isProcessing: boolean;
}
export class DelegationBudgetError extends Error {
  readonly code = 'delegation_budget_exceeded';
  readonly retryable = false;
}

/** A tool-created child can retain or reduce its parent's authority. */
export function resolveDelegatedPermissionMode(
  parentMode: PermissionMode,
  requestedMode?: PermissionMode,
  role: 'worker' | 'reviewer' = 'worker',
): PermissionMode {
  assertCanonicalPermissionMode(parentMode);
  if (requestedMode !== undefined) assertCanonicalPermissionMode(requestedMode);
  if (role === 'reviewer') return 'safe';
  const rank: Record<PermissionMode, number> = { safe: 0, ask: 1, 'allow-all': 2 };
  return requestedMode !== undefined && rank[requestedMode] < rank[parentMode] ? requestedMode : parentMode;
}

function objectiveId(session: DelegationSession): string {
  return session.activeObjective?.objectiveId ?? session.activeObjective?.userMessageId ?? session.id;
}

/** Recheck after asynchronous creation/attachment reads, before dispatching work. */
export function assertCurrentDelegationObjective(
  parent: DelegationSession,
  sessions: Iterable<DelegationSession>,
  delegation: SessionDelegation,
): void {
  const all = [...sessions];
  const currentParent = all.find(session => session.id === parent.id);
  const root = all.find(session => session.id === delegation.rootSessionId);
  if (!root || !currentParent || objectiveId(root) !== delegation.rootObjectiveId
    || objectiveId(currentParent) !== delegation.parentObjectiveId
    || (root.activeObjective && root.activeObjective.terminalState !== 'active')
    || (currentParent.activeObjective && currentParent.activeObjective.terminalState !== 'active')) {
    throw new DelegationBudgetError('The originating objective is no longer current; return findings to its owner.');
  }
}

export class DelegationBudget {
  private reservations = new Map<symbol, SessionDelegation>();

  reserve(parent: DelegationSession, sessions: Iterable<DelegationSession>, role: 'worker' | 'reviewer' = 'worker') {
    if (parent.delegation && (!Number.isInteger(parent.delegation.depth) || parent.delegation.depth < 1
      || !['worker', 'reviewer'].includes(parent.delegation.role))) {
      throw new DelegationBudgetError('Invalid persisted delegation lineage; restore its originating task before creating children.');
    }
    if (parent.delegation?.role === 'reviewer') {
      throw new DelegationBudgetError('A reviewer must return its findings directly; it cannot spawn another session.');
    }
    const all = [...sessions];
    const rootId = parent.delegation?.rootSessionId ?? parent.id;
    const rootObjectiveId = parent.delegation?.rootObjectiveId
      ?? parent.activeObjective?.objectiveId ?? parent.activeObjective?.userMessageId ?? parent.id;
    const delegation: SessionDelegation = {
      rootSessionId: rootId, rootObjectiveId,
      parentObjectiveId: parent.activeObjective?.objectiveId ?? parent.activeObjective?.userMessageId ?? parent.id,
      depth: (parent.delegation?.depth ?? 0) + 1, role,
    };
    assertCurrentDelegationObjective(parent, all, delegation);
    const belongs = (value?: SessionDelegation) => value?.rootSessionId === rootId && value.rootObjectiveId === rootObjectiveId;
    const family = all.filter(session => belongs(session.delegation));
    const pending = [...this.reservations.values()].filter(belongs).length;
    // A just-created child without an objective is already dispatched, including after restart.
    const active = family.filter(session => session.isProcessing || (!session.delegation?.finishedAt
      && (!session.activeObjective || session.activeObjective.terminalState === 'active'))).length;
    if (delegation.depth > DELEGATION_LIMITS.maxDepth) throw new DelegationBudgetError('Maximum delegation depth reached; finish the bounded work in this session.');
    if (family.length + pending >= DELEGATION_LIMITS.maxChildren) throw new DelegationBudgetError('Objective child-session budget reached; consolidate existing results and finish remaining work locally.');
    if (active + pending >= DELEGATION_LIMITS.maxConcurrent) throw new DelegationBudgetError('Concurrent child-session budget reached; wait for existing children before dispatching independent work.');
    const token = Symbol('delegation');
    this.reservations.set(token, delegation);
    return { delegation, release: () => { this.reservations.delete(token); } };
  }
}
