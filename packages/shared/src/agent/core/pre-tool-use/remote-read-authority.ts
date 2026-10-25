import { detectHighStakesEvidenceDomain, isConcreteOperationalSoftwareRestatement, isOperationalTechnicalContractLifecycleObjective } from "../objective-evidence-gate.ts";
import { explicitlyAuthorizesStructuredRemoteReadChannel, objectiveNamesRemoteEndpoint, remoteProjectTargetMatchesEndpoint } from './remote-identity.ts';
import { explicitBoundedSoftwareRemoteRoots, remotePathIsWithinRoot } from './software-scope.ts';
import { boundedSoftwareTupleAuthorizesRemotePath, explicitlyAuthorizesBoundedSoftwareRemoteEndpoint, isNonSubstantiveBoundedSoftwareFollowUp } from './software-targets.ts';

export function targetBoundOperationalTechnicalReadAuthoritySegment(
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
): string | undefined {
  const server = typeof input.server === 'string' ? input.server.trim() : '';
  if (!server) return undefined;
  // The newest substantive human segment is an authority boundary. It must
  // fully restate the endpoint and audited channel; never search past a stop,
  // retargeting or partial amendment to resurrect an older signed grant.
  const segment = [...objectiveSegments].reverse().find(
    candidate => !isNonSubstantiveBoundedSoftwareFollowUp(candidate),
  );
  if (!segment
    || detectHighStakesEvidenceDomain(segment) !== undefined
    || !(isOperationalTechnicalContractLifecycleObjective(segment)
      || isConcreteOperationalSoftwareRestatement(segment))
    || !explicitlyAuthorizesStructuredRemoteReadChannel(segment)
    // Preserve the raw ASCII identity check before the polarity-aware folded
    // matcher; Unicode lookalikes such as `pñs` must never authorize `pns`.
    || !objectiveNamesRemoteEndpoint(server, [segment])
    || !explicitlyAuthorizesBoundedSoftwareRemoteEndpoint(server, segment)) {
    return undefined;
  }
  return segment;
}

export function hasTargetBoundOperationalTechnicalReadAuthority(
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
): boolean {
  return targetBoundOperationalTechnicalReadAuthoritySegment(input, objectiveSegments) !== undefined;
}

export function remotePathMatchesOperationalObjective(
  remotePath: string,
  endpoint: string,
  segment: string,
): boolean {
  const roots = explicitBoundedSoftwareRemoteRoots(segment);
  if (roots.excluded.some(root => remotePathIsWithinRoot(remotePath, root))) return false;
  if (roots.authorized.length > 0) {
    return boundedSoftwareTupleAuthorizesRemotePath(segment, endpoint, remotePath);
  }
  const projectDirectory = remotePath.startsWith('/srv/')
    ? remotePath.slice('/srv/'.length).split('/')[0] ?? ''
    : '';
  return !!projectDirectory && remoteProjectTargetMatchesEndpoint(projectDirectory, endpoint);
}
