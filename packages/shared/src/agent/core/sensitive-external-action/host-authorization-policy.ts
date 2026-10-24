import { UNRESOLVED_TARGET_SENTINELS, hostAuthenticatedAuthorizationContainsNoEffectDirective, parseHostAuthenticatedUserAuthorization } from './host-authorization.ts';
import { requestMatchesConditionalTargets, requestNamesSensitiveActionCategory } from './request-authority-clauses.ts';
import { hasGlobalExternalActionRevocation, requestClauses, targetIsNamed, targetIsNegatedInClause } from './request-authorization.ts';
import { normalizeForMatch } from './target-syntax.ts';
import type { SensitiveExternalAction } from './types.ts';

export function genericHostAuthenticatedUserAuthorization(
  action: SensitiveExternalAction,
  rawRequest: string,
): boolean {
  const authenticated = parseHostAuthenticatedUserAuthorization(rawRequest);
  if (!authenticated || hostAuthenticatedAuthorizationContainsNoEffectDirective(authenticated, action)
    || action.remoteCommand
    || action.targetCandidates.length === 0
    || action.targetCandidates.some(target => UNRESOLVED_TARGET_SENTINELS.has(target))) return false;
  const affirmed = `${authenticated.selection}. ${authenticated.displayedScope}`;
  const normalized = normalizeForMatch(affirmed);
  if (!normalized || hasGlobalExternalActionRevocation(affirmed)
    || !requestNamesSensitiveActionCategory(action, normalized)
    || !requestMatchesConditionalTargets(action, affirmed)) return false;
  const clauses = requestClauses(affirmed);
  return action.targetCandidates.every(target => (
    targetIsNamed(affirmed, target)
    && !clauses.some(clause => targetIsNamed(clause, target)
      && targetIsNegatedInClause(clause, target))
  ));
}
