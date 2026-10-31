import { IN_SCOPE_IMPLEMENTATION_ALIASES } from './action-vocabulary.ts';
import { ACTION_DETAILS, UNRESOLVED_REMOTE_SCOPE, externalActionAuthorityPolicySegments, hasUnresolvedRemoteScopeTarget } from './host-authorization.ts';
import { isSensitiveExternalActionAuthorizedByObjective, isSensitiveExternalActionConfirmationRequestedByObjective } from './objective-authorization.ts';
import type { SensitiveExternalAction } from './types.ts';

export function isSensitiveExternalActionOtherwiseAuthorizedByObjective(
  action: SensitiveExternalAction,
  authorizationSegments: readonly string[],
): boolean {
  const policySegments = externalActionAuthorityPolicySegments(authorizationSegments);
  if (!hasUnresolvedRemoteScopeTarget(action)) return false;
  const concreteTargets = action.targetCandidates.filter(
    target => target !== UNRESOLVED_REMOTE_SCOPE,
  );
  if (concreteTargets.length === 0) return false;
  const candidateTargetSets = [concreteTargets];
  const promptAction = action.boundedRemoteHostPrompt && action.category === 'external_mutation'
    ? {
      ...action,
      authorizationTermGroups: [[...new Set([
        ...(action.authorizationTermGroups ?? []).flat(),
        ...ACTION_DETAILS.external_mutation.authorizationTermGroups[0]!,
        ...IN_SCOPE_IMPLEMENTATION_ALIASES,
      ])]],
    }
    : action;
  return candidateTargetSets.some(targetCandidates => (
    isSensitiveExternalActionConfirmationRequestedByObjective(
      { ...promptAction, targetCandidates }, policySegments,
    ) || isSensitiveExternalActionAuthorizedByObjective(
      { ...promptAction, targetCandidates }, policySegments,
    )
  ));
}
