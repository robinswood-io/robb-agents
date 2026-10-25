import { isTargetFreeGenericContinuation } from "../sensitive-external-action.ts";
import { detectHighStakesEvidenceDomain } from "../objective-evidence-gate.ts";
import { normalizeUserInstructionForChannelMatch } from './browser-channel.ts';
import { isQuotedOrReportedBoundedSoftwareContract } from './portable-scope.ts';
import { explicitlyAuthorizesStructuredRemoteReadChannel, isCanonicalRemoteEndpoint, objectiveNamesRemoteEndpoint } from './remote-identity.ts';
import type { BoundedSoftwareRemoteEndpointOccurrence, BoundedSoftwareRemoteTargetTuple } from './software-scope.ts';
import { BOUNDED_SOFTWARE_ENDPOINT_DECLARATION_PATTERN, BOUNDED_SOFTWARE_EXPLICIT_MUTATION_REVOCATION_PATTERN, BOUNDED_SOFTWARE_READ_ONLY_PHASE_PATTERN, BOUNDED_SOFTWARE_SCOPE_DECLARATION_PATTERN, boundedSoftwareInstructionPhases, boundedSoftwareMutationIsRevoked, boundedSoftwareTargetOccurrenceIsNegated, explicitBoundedSoftwareRemoteRootOccurrences, explicitBoundedSoftwareRemoteRoots, explicitlyAuthorizesBoundedSoftwareMutationClause, remotePathIsWithinRoot } from './software-scope.ts';

function explicitBoundedSoftwareRemoteEndpointOccurrences(
  clause: string,
): BoundedSoftwareRemoteEndpointOccurrence[] {
  const occurrences: BoundedSoftwareRemoteEndpointOccurrence[] = [];
  const pattern = /\b(?:serveur|server|h[oô]te|host)\s+(?:exacte?\s+)?([a-z0-9](?:[a-z0-9_-]|[.:](?=[a-z0-9])){0,255})/giu;
  for (const match of clause.matchAll(pattern)) {
    const endpoint = match[1]?.toLowerCase();
    if (!endpoint || match.index === undefined || !isCanonicalRemoteEndpoint(endpoint)) continue;
    const relativeIndex = match[0].toLowerCase().lastIndexOf(endpoint);
    const index = match.index + relativeIndex;
    if (relativeIndex < 0
      || boundedSoftwareTargetOccurrenceIsNegated(clause, index, endpoint.length)) continue;
    occurrences.push({ endpoint, index, end: index + endpoint.length });
  }
  return occurrences;
}

function explicitBoundedSoftwareRemoteTargetTuples(
  segment: string,
): BoundedSoftwareRemoteTargetTuple[] {
  const tuples: BoundedSoftwareRemoteTargetTuple[] = [];
  for (const clause of boundedSoftwareInstructionPhases(segment)) {
    const endpoints = explicitBoundedSoftwareRemoteEndpointOccurrences(clause);
    const roots = explicitBoundedSoftwareRemoteRootOccurrences(clause)
      .filter(root => !root.negated);
    if (endpoints.length === 0 || roots.length === 0) continue;

    if (endpoints.length === 1) {
      for (const root of roots) tuples.push({ endpoint: endpoints[0]!.endpoint, root: root.path });
      continue;
    }

    // With several endpoints, bind only a locally expressed pair. This avoids
    // treating two explicit pairs as the Cartesian product of all endpoints
    // and roots. Ambiguous shared-root prose remains fail-closed.
    for (const root of roots) {
      const following = endpoints.find((endpoint) => {
        if (endpoint.index < root.index + root.rawLength) return false;
        const relation = normalizeUserInstructionForChannelMatch(
          clause.slice(root.index + root.rawLength, endpoint.index),
        );
        return /^(?:sur|on)\s+(?:(?:le|la|the)\s+)?$/u.test(relation);
      });
      if (following) {
        tuples.push({ endpoint: following.endpoint, root: root.path });
        continue;
      }
      const preceding = [...endpoints].reverse().find((endpoint) => {
        if (endpoint.end > root.index) return false;
        const relation = normalizeUserInstructionForChannelMatch(
          clause.slice(endpoint.end, root.index),
        );
        return /^(?:[,=:]\s*)?(?:(?:dans|in|at|on|sur|sous|under|a|racine|root|path|chemin)\s*)?$/u.test(relation);
      });
      if (preceding) tuples.push({ endpoint: preceding.endpoint, root: root.path });
    }
  }
  return tuples.filter((tuple, index, all) => all.findIndex(candidate => (
    candidate.endpoint === tuple.endpoint && candidate.root === tuple.root
  )) === index);
}

export function explicitlyAuthorizesBoundedSoftwareRemoteEndpoint(
  endpoint: string,
  segment: string,
): boolean {
  if (!objectiveNamesRemoteEndpoint(endpoint, [segment])) return false;
  const normalized = normalizeUserInstructionForChannelMatch(segment);
  const identifiers = [...normalized.matchAll(
    /[a-z0-9](?:[a-z0-9_-]|[.:](?=[a-z0-9])){0,255}/g,
  )].filter(match => match[0] === endpoint.toLowerCase() && match.index !== undefined);
  return identifiers.length > 0
    && identifiers.every(match => !boundedSoftwareTargetOccurrenceIsNegated(
      normalized,
      match.index!,
      match[0].length,
    ));
}

export function boundedSoftwareTupleAuthorizesRemotePath(
  segment: string,
  endpoint: string,
  remotePath: string,
): boolean {
  const canonicalEndpoint = endpoint.toLowerCase();
  return explicitBoundedSoftwareRemoteTargetTuples(segment).some(tuple => (
    tuple.endpoint === canonicalEndpoint && remotePathIsWithinRoot(remotePath, tuple.root)
  ));
}

export function explicitlyAuthorizesBoundedSoftwareMutationScope(
  segment: string,
  endpoint: string,
  remotePath: string,
): boolean {
  const clauses = boundedSoftwareInstructionPhases(segment);
  if (boundedSoftwareMutationIsRevoked(clauses)) return false;
  const declaredScopes = clauses.filter((clause) => {
    return BOUNDED_SOFTWARE_SCOPE_DECLARATION_PATTERN.test(clause)
      && explicitBoundedSoftwareRemoteTargetTuples(clause).length > 0;
  });
  const matchingDeclaredScopes = declaredScopes.filter((clause) => {
    return explicitlyAuthorizesBoundedSoftwareRemoteEndpoint(endpoint, clause)
      && boundedSoftwareTupleAuthorizesRemotePath(clause, endpoint, remotePath);
  });

  return clauses.some((clause) => {
    if (!explicitlyAuthorizesBoundedSoftwareMutationClause(clause)) return false;
    const roots = explicitBoundedSoftwareRemoteRoots(clause);
    if (explicitlyAuthorizesBoundedSoftwareRemoteEndpoint(endpoint, clause)
      && boundedSoftwareTupleAuthorizesRemotePath(clause, endpoint, remotePath)) {
      return true;
    }
    // A unique explicit scope declaration (“Cible … serveur + racine”) may
    // bind a later mutation clause only while that clause does not introduce
    // another endpoint or root. This preserves the concrete Orion wording but
    // prevents cross-pairing “Inspect dev/root-a. Fix pns/root-b.”.
    return roots.authorized.length === 0
      && roots.excluded.length === 0
      && !BOUNDED_SOFTWARE_ENDPOINT_DECLARATION_PATTERN.test(clause)
      && declaredScopes.length === 1
      && matchingDeclaredScopes.length === 1;
  });
}

export function isNonSubstantiveBoundedSoftwareFollowUp(segment: string): boolean {
  const normalized = normalizeUserInstructionForChannelMatch(segment)
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .trim();
  // A current stop or retarget overrides the previous execution scope.
  if (/^(?:(?:merci de|please) )?(?:arrete\w*|stop|cancel|annule\w*)\b|\bne (?:poursui\w*|continu\w*|reprend\w*)[^.!?;]{0,40}\b(?:pas|plus|jamais)\b|\b(?:cible|target|serveur|server|repertoire|directory) (?:devient|becomes)\b/u.test(normalized)) return false;
  if (/\b(?:sans|without|no)\s+(?:ssh|navigateur|browser|api)\b|\/srv\/|\b(?:continue\w*|reprend\w*|poursui\w*)\b[^.!?;]{0,40}\b(?:sur|on|dans|in|vers|to)\s+\S+/u.test(normalized)) return false;
  if (isTargetFreeGenericContinuation(segment)) return true;
  if (/^(?:ou en (?:es tu|sommes nous)|(?:quel(?:le)?s? (?:est|sont) )?(?:(?:le|la|les) )?(?:statut|avancement)|(?:(?:peux tu|pouvez vous|pourrais tu|pourriez vous) )?(?:(?:me|nous) )?(?:donner|donne|donnez|faire|fais|faites) (?:(?:moi|nous) )?(?:un|le) (?:point davancement|point de situation|statut)|(?:can|could|would) you (?:give|send) (?:me|us) (?:a )?(?:status|progress) update|(?:give|send) (?:me|us) (?:a )?(?:status|progress) update|what(?:s| is) the (?:status|progress)|where are we|how is it going|status|progress|merci|thanks)$/u.test(normalized)) {
    return true;
  }
  if (explicitlyAuthorizesStructuredRemoteReadChannel(segment) || BOUNDED_SOFTWARE_ENDPOINT_DECLARATION_PATTERN.test(segment)) {
    return false;
  }
  const hasRevocation = BOUNDED_SOFTWARE_EXPLICIT_MUTATION_REVOCATION_PATTERN.test(segment)
    || /\b(?:ne\s+(?:modifi\w*|touche\w*|chang\w*|synchronis\w*|committ\w*|d[ée]ploi\w*)|don?['’]t\s+(?:modify|touch|change|sync|commit|deploy))\b/iu.test(segment)
    || BOUNDED_SOFTWARE_READ_ONLY_PHASE_PATTERN.test(segment);
  const hasScopeOrEndpoint = BOUNDED_SOFTWARE_SCOPE_DECLARATION_PATTERN.test(segment)
    || BOUNDED_SOFTWARE_ENDPOINT_DECLARATION_PATTERN.test(segment)
    || /\b(?:api|navigateur|browser|site|base|db|bdd)\s+(?:uniquement|only)\b/iu.test(segment);
  const isQuoted = isQuotedOrReportedBoundedSoftwareContract(segment);
  const isHighStakes = detectHighStakesEvidenceDomain(segment) !== undefined;
  if (!hasRevocation && !hasScopeOrEndpoint && !isQuoted && !isHighStakes) {
    if (/\b(?:corrige\w*|fix\w*|r[ée]pare\w*|relance\w*|rerun\w*|continue\w*|it[èe]re\w*|v[ée]rifie\w*|check\w*|test\w*|reprend\w*|poursui\w*|fais\w*|applique\w*|pourquoi\b|avance\w*|termine\w*|finish\w*)\b/iu.test(segment)) {
      return true;
    }
  }
  return false;
}
