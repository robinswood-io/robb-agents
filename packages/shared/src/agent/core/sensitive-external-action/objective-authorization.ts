import { BOUNDED_OSS_ATOMIC_WRITE_TOOL } from './connector-classification.ts';
import { HOST_AUTHENTICATED_USER_AUTHORIZATION_MARKER, UNRESOLVED_TARGET_SENTINELS, externalActionAuthorityPolicySegments, hostAuthenticatedAuthorizationContainsNoEffectDirective, parseHostAuthenticatedUserAuthorization } from './host-authorization.ts';
import { genericHostAuthenticatedUserAuthorization } from './host-authorization-policy.ts';
import { isSensitiveExternalActionExplicitlyAuthorized, requestMatchesConditionalTargets, requestNamesSensitiveAction, requestNamesSensitiveActionCategory } from './request-authority-clauses.ts';
import { EXPLICIT_ACTION_AFTER_CONFIRMATION, EXPLICIT_STOP_BEFORE_EXTERNAL_ACTION, externalConfirmationContinuationAlias, hasGlobalExternalActionRevocation, isNonAuthorizingRequest, requestClauses, requestExplicitlyRetargets, targetIsNamed, targetIsNegatedInClause } from './request-authorization.ts';
import { AFFIRMATIVE_BOUNDED_REMOTE_EXACT_SCOPE_DECLARATION, BOUNDED_REMOTE_EXACT_SCOPE_DECLARATION, COLON_BOUNDED_REMOTE_EXACT_SCOPE_DECLARATION, EXPLICIT_BOUNDED_REMOTE_EXECUTION_AUTHORIZATION, NEGATED_BOUNDED_REMOTE_EXECUTION_AUTHORIZATION, NEGATIVE_EXACT_SCOPE_VALUE, READ_ONLY_EXACT_SCOPE_QUALIFIER, signedOssAtomicWriteDecision } from './signed-oss-write.ts';
import { isTargetFreeGenericContinuation } from './structured-gmail-send.ts';
import { normalizeForMatch } from './target-syntax.ts';
import type { SensitiveExternalAction } from './types.ts';

function hasAffirmativeBoundedRemoteExactScopeDeclaration(rawRequest: string): boolean {
  // `requestClauses` deliberately treats `:` as an instruction boundary. Read
  // this common labelled form directly so “Cible exacte : serveur dev, …”
  // keeps its value attached to the declaration instead of becoming an empty
  // heading. All negative/read-only qualifiers remain fail-closed below.
  for (const match of rawRequest.matchAll(COLON_BOUNDED_REMOTE_EXACT_SCOPE_DECLARATION)) {
    const declaredScope = normalizeForMatch(match[1] ?? '').trim();
    if (declaredScope.length > 0
      && !NEGATIVE_EXACT_SCOPE_VALUE.test(declaredScope)
      && !READ_ONLY_EXACT_SCOPE_QUALIFIER.test(declaredScope)) return true;
  }
  return requestClauses(rawRequest).some((rawClause) => {
    const clause = normalizeForMatch(rawClause);
    const declaration = AFFIRMATIVE_BOUNDED_REMOTE_EXACT_SCOPE_DECLARATION.exec(clause);
    if (!declaration) return false;
    const declaredScope = clause.slice(declaration[0].length).trim();
    return declaredScope.length > 0
      && !NEGATIVE_EXACT_SCOPE_VALUE.test(declaredScope)
      && !READ_ONLY_EXACT_SCOPE_QUALIFIER.test(declaredScope);
  });
}

function boundedRemoteCommandHostPromptRequested(
  action: SensitiveExternalAction,
  objectiveSegments: readonly string[],
): boolean | undefined {
  if (!action.remoteCommand) return undefined;
  // Connector and tool identity are part of this compatibility boundary.
  // A similarly named executor from another MCP source must not inherit the
  // rbw-servers confirmation path from matching command/cwd text alone.
  if (!action.boundedRemoteHostPrompt) return false;
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const rawRequest = objectiveSegments[index] ?? '';
    const normalizedRequest = normalizeForMatch(rawRequest);
    if (!normalizedRequest) continue;
    if (hasGlobalExternalActionRevocation(rawRequest)) return false;
    const namesAction = requestNamesSensitiveAction(action, normalizedRequest);
    const declaresExactScope = hasAffirmativeBoundedRemoteExactScopeDeclaration(rawRequest);
    if (!namesAction && !declaresExactScope) {
      if (isTargetFreeGenericContinuation(normalizedRequest)) continue;
      // Newest meaningful human scope owns this narrow compatibility path.
      // An analysis, retarget, pause or unclassified amendment cannot be
      // skipped to resurrect an older remote authorization.
      return false;
    }
    if (!namesAction || !declaresExactScope
      || isNonAuthorizingRequest(rawRequest, normalizedRequest)) return false;
    const clauses = requestClauses(rawRequest);
    return action.targetCandidates.every(target => (
      targetIsNamed(rawRequest, target)
      && !clauses.some(clause => targetIsNamed(clause, target)
        && targetIsNegatedInClause(clause, target))
    ));
  }
  return false;
}

/** A bounded remote objective that merely names an exact scope still reaches
 * the host confirmation UI. It becomes direct execution authority only when
 * the same newest authenticated segment also says that scope is already
 * authorized. The ordinary action, target, negation and retarget checks above
 * still apply in full. */
function boundedRemoteCommandDirectExecutionAuthorized(
  action: SensitiveExternalAction,
  objectiveSegments: readonly string[],
): boolean {
  if (!action.remoteCommand || !action.boundedRemoteHostPrompt) return false;
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const rawRequest = objectiveSegments[index] ?? '';
    const normalizedRequest = normalizeForMatch(rawRequest);
    if (!normalizedRequest) continue;
    if (isTargetFreeGenericContinuation(normalizedRequest)) continue;
    // The authorization must qualify the mutation itself, not merely another
    // capability mentioned somewhere in the same long objective. In
    // particular, “read-only SSH access is already authorized; start the
    // service” must still reach the scoped confirmation boundary. The live
    // Orion contract keeps the start/restart verb and “périmètre déjà
    // autorisé” in one clause, so it remains directly executable.
    const actionBoundAuthorization = requestClauses(rawRequest).some(rawClause => {
      const clause = normalizeForMatch(rawClause);
      const authorization = EXPLICIT_BOUNDED_REMOTE_EXECUTION_AUTHORIZATION.exec(clause);
      if (!authorization || NEGATED_BOUNDED_REMOTE_EXECUTION_AUTHORIZATION.test(clause)
        || READ_ONLY_EXACT_SCOPE_QUALIFIER.test(clause)) return false;
      const before = clause.slice(0, authorization.index).trim();
      const after = clause.slice(authorization.index + authorization[0].length).trim();
      const actionScope = /\b(?:mission|perimetre|scope|action|operation|mutation|demarrage|redemarrage|start|restart|deploiement|deployment|correction|intervention)\b/u;
      const unrelatedReadCapability = /\b(?:acces|access|connexion|ssh|logs?|consultation|lecture|read|audit|inspection|observation)\b/u;
      const authorizationQualifiesPriorAction = requestNamesSensitiveAction(action, before)
        && actionScope.test(before)
        && !unrelatedReadCapability.test(before);
      const authorizationDirectlyIntroducesAction = /^(?:a|to)\b/u.test(after)
        && requestNamesSensitiveAction(action, after)
        && !unrelatedReadCapability.test(after);
      return authorizationQualifiesPriorAction || authorizationDirectlyIntroducesAction;
    });
    if (!actionBoundAuthorization) return false;
    return boundedRemoteCommandHostPromptRequested(action, [rawRequest]) === true;
  }
  return false;
}

function confirmationAliasIsBoundInSegment(
  action: SensitiveExternalAction,
  rawRequest: string,
  alias: string,
): boolean {
  if (action.targetCandidates.length !== 1
    || !targetIsNamed(rawRequest, action.targetCandidates[0]!)) return false;
  const affirmativeAliases = new Set<string>();
  for (const clause of requestClauses(rawRequest)) {
    const normalizedClause = normalizeForMatch(clause);
    const bindings = normalizedClause.matchAll(
      /\b(?:ecris|ecrire|envoie|envoyer|send|write)\b[^.!?;\n]{0,100}?\b(?:a|to|vers)\s+([a-z0-9][a-z0-9-]*)\b/gu,
    );
    for (const binding of bindings) {
      const candidate = binding[1];
      if (!candidate) continue;
      const aliasOffset = binding[0].lastIndexOf(candidate);
      const aliasIndex = (binding.index ?? 0) + aliasOffset;
      const beforeAlias = normalizedClause.slice(0, aliasIndex);
      const negated = /\b(?:do not|don t|never|not)\b/u.test(beforeAlias)
        || /\b(?:ne|n)\b[^.!?;\n]{0,80}\b(?:jamais|pas|plus)\b/u.test(beforeAlias)
        || /\b(?:jamais|never|pas|sans|without)\b[^.!?;\n]{0,40}\b(?:a|to|vers)\s*$/u.test(beforeAlias);
      if (!negated) affirmativeAliases.add(candidate);
    }
  }
  // An alias can resume a target-bound confirmation only when the root names
  // exactly one affirmative human alias. Multiple recipients in the same
  // segment are ambiguous without an explicit alias-to-address relation.
  return affirmativeAliases.size === 1 && affirmativeAliases.has(alias);
}

/**
 * Detect a host-confirmation boundary that the human explicitly requested for
 * this exact action and target. This is not execution authority: it only lets
 * the attempted tool reach the host's scoped permission prompt. A generic
 * question answer, model prose, tool output, retarget, or prohibition cannot
 * satisfy this predicate.
 */
export function isSensitiveExternalActionConfirmationRequestedByObjective(
  action: SensitiveExternalAction,
  objectiveSegments: readonly string[],
): boolean {
  const policySegments = externalActionAuthorityPolicySegments(objectiveSegments);
  if (action.targetCandidates.length === 0
    || action.targetCandidates.some(target => UNRESOLVED_TARGET_SENTINELS.has(target))) return false;

  if (boundedRemoteCommandDirectExecutionAuthorized(action, policySegments)) return false;
  const boundedRemotePrompt = boundedRemoteCommandHostPromptRequested(
    action,
    policySegments,
  );
  if (boundedRemotePrompt !== undefined) return boundedRemotePrompt;

  let resumedBoundaryAlias: string | undefined;
  for (let index = policySegments.length - 1; index >= 0; index -= 1) {
    const rawRequest = policySegments[index] ?? '';
    const normalizedRequest = normalizeForMatch(rawRequest);
    if (!normalizedRequest) continue;
    if (hasGlobalExternalActionRevocation(rawRequest)) return false;

    const namesCategory = requestNamesSensitiveActionCategory(action, normalizedRequest);
    const retargets = requestExplicitlyRetargets(action, rawRequest, normalizedRequest);
    const continuation = externalConfirmationContinuationAlias(normalizedRequest);
    if (!namesCategory && !retargets && !continuation) continue;
    if (retargets) return false;
    if (isNonAuthorizingRequest(rawRequest, normalizedRequest)) return false;

    const clauses = requestClauses(rawRequest);
    const everyTargetNamed = action.targetCandidates.every(target => (
      targetIsNamed(rawRequest, target)
      && !clauses.some(clause => targetIsNamed(clause, target)
        && targetIsNegatedInClause(clause, target))
    ));
    if (!everyTargetNamed || !requestMatchesConditionalTargets(action, rawRequest)) {
      if (!continuation || action.targetCandidates.length !== 1) return false;
      resumedBoundaryAlias = continuation.alias;
      continue;
    }

    const hasBoundary = EXPLICIT_STOP_BEFORE_EXTERNAL_ACTION.test(normalizedRequest)
      || EXPLICIT_ACTION_AFTER_CONFIRMATION.test(normalizedRequest);
    if (!hasBoundary) return false;
    return resumedBoundaryAlias === undefined
      || confirmationAliasIsBoundInSegment(action, rawRequest, resumedBoundaryAlias);
  }
  return false;
}

/**
 * Resolve a sensitive action against authenticated objective segments without
 * joining unrelated text. The newest segment that names this action category
 * owns its target: a retarget, question, analysis request, or negation cannot
 * fall through to an older authorization, while a generic "continue" can.
 */
export function isSensitiveExternalActionAuthorizedByObjective(
  action: SensitiveExternalAction,
  objectiveSegments: readonly string[],
  authenticatedUserAuthorizationSegments: readonly string[] = [],
): boolean {
  const policySegments = externalActionAuthorityPolicySegments(objectiveSegments);
  const markerCount = (segments: readonly string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const segment of segments) {
      if (!segment.startsWith(`${HOST_AUTHENTICATED_USER_AUTHORIZATION_MARKER}\n`)) continue;
      counts.set(segment, (counts.get(segment) ?? 0) + 1);
    }
    return counts;
  };
  const policyMarkerCounts = markerCount(policySegments);
  const authenticatedMarkerCounts = markerCount(authenticatedUserAuthorizationSegments);
  const remainingAuthenticatedMarkers = new Map(authenticatedMarkerCounts);
  if (action.commandPreview === BOUNDED_OSS_ATOMIC_WRITE_TOOL
    && action.boundedOssAtomicWrite !== true) return false;
  const exactOssAtomicWrite = signedOssAtomicWriteDecision(
    action,
    policySegments,
  );
  if (exactOssAtomicWrite !== undefined) return exactOssAtomicWrite.authorized;
  if (boundedRemoteCommandDirectExecutionAuthorized(action, policySegments)) return true;
  if (action.remoteCommand) {
    const newestExactScopeSegment = [...policySegments].reverse().find(segment => (
      BOUNDED_REMOTE_EXACT_SCOPE_DECLARATION.test(normalizeForMatch(segment))
    ));
    // An explicit exact-scope contract belongs only to the audited remote
    // connector, and a negative/read-only declaration cannot become generic
    // Execute authority merely because it still names the same project.
    if (newestExactScopeSegment && (
      !action.boundedRemoteHostPrompt
      || !hasAffirmativeBoundedRemoteExactScopeDeclaration(newestExactScopeSegment)
    )) return false;
  }
  for (let index = policySegments.length - 1; index >= 0; index -= 1) {
    const rawRequest = policySegments[index] ?? '';
    const normalizedRequest = normalizeForMatch(rawRequest);
    if (!normalizedRequest) continue;
    // A structured question answer is accepted by the host only after the
    // user selected one affirmative option. For the audited rbw-servers
    // executor, that selection is the scoped confirmation boundary: the
    // displayed question must still name the mutation and every concrete
    // target. Generic answers remain closed to resolved non-remote actions.
    if (rawRequest.startsWith(`${HOST_AUTHENTICATED_USER_AUTHORIZATION_MARKER}\n`)) {
      const policyCount = policyMarkerCounts.get(rawRequest) ?? 0;
      const authenticatedCount = authenticatedMarkerCounts.get(rawRequest) ?? 0;
      const remaining = remainingAuthenticatedMarkers.get(rawRequest) ?? 0;
      // String equality alone is not provenance: a public amendment can copy
      // a real hidden marker. Require an exact occurrence-for-occurrence
      // correspondence and consume this host capability once for this scan.
      const authenticated = parseHostAuthenticatedUserAuthorization(rawRequest);
      if (policyCount !== authenticatedCount || remaining <= 0
        || !authenticated
        || hostAuthenticatedAuthorizationContainsNoEffectDirective(authenticated, action)) return false;
      remainingAuthenticatedMarkers.set(rawRequest, remaining - 1);
      if (genericHostAuthenticatedUserAuthorization(action, rawRequest)) return true;
      // Distinct authenticated answers may authorize independent categories.
      // Only an answer that names or retargets this action owns its boundary;
      // unrelated host answers do not erase older still-valid authority.
      if (requestNamesSensitiveActionCategory(action, normalizedRequest)
        || requestExplicitlyRetargets(action, rawRequest, normalizedRequest)) return false;
      continue;
    }
    if (isSensitiveExternalActionExplicitlyAuthorized(action, rawRequest)) return true;
    if (requestNamesSensitiveActionCategory(action, normalizedRequest)) return false;
    if (requestExplicitlyRetargets(action, rawRequest, normalizedRequest)) return false;
  }
  return false;
}
