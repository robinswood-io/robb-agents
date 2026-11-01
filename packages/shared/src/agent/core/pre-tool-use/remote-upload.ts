import { lstatSync, realpathSync } from "node:fs";
import { isProtectedApplicationPath } from "@craft-agent/session-tools-core";
import { posix, resolve } from "node:path";
import { isPathWithinDirectory } from "../../mode-manager.ts";
import { isSensitiveRemoteTransferSource } from "../sensitive-external-action.ts";
import { detectHighStakesEvidenceDomain, isConcreteOperationalSoftwareRestatement } from "../objective-evidence-gate.ts";
import { normalizeUserInstructionForChannelMatch } from './browser-channel.ts';
import { PORTABLE_SESSION_PATH_TOKEN, explicitPortableSessionDataRoots, isQuotedOrReportedBoundedSoftwareContract, pathUsesSymbolicLinkBelowBoundary } from './portable-scope.ts';
import { explicitlyAuthorizesStructuredRemoteReadChannel, isCanonicalRemoteEndpoint } from './remote-identity.ts';
import { managedDevOrionPath } from './signed-resume-targets.ts';
import { explicitBoundedSoftwareRemoteRoots, remotePathIsWithinRoot } from './software-scope.ts';
import { boundedSoftwareTupleAuthorizesRemotePath, explicitlyAuthorizesBoundedSoftwareMutationScope, explicitlyAuthorizesBoundedSoftwareRemoteEndpoint, isNonSubstantiveBoundedSoftwareFollowUp } from './software-targets.ts';

/** Direct upload authority for one current, fully restated software recovery
 * mission. Endpoint, destination root, audited channel and mutation verb all
 * come from the same newest human segment. This does not downgrade the tool's
 * external-mutation effect and therefore never bypasses evidence, permission,
 * application-protection or secret-transfer checks. */
export function isBoundedStructuredRemoteTechnicalUpload(
  toolName: string,
  input: Record<string, unknown>,
  dataFolderPath: string | undefined,
  objectiveSegments: readonly string[],
  _authenticatedUserAuthorizationSegments: readonly string[] = [],
): string | undefined {
  if (toolName !== 'mcp__rbw-servers__ssh_upload' || !dataFolderPath
    || Object.keys(input).some(key => ![
      'server', 'localPath', 'remotePath', '_displayName', '_intent',
    ].includes(key))) return undefined;
  const server = typeof input["server"] === 'string' ? input["server"].trim() : '';
  const requestedLocalPath = typeof input["localPath"] === 'string' ? input["localPath"].trim() : '';
  const remotePath = typeof input["remotePath"] === 'string' ? input["remotePath"].trim() : '';
  if (!server || server !== input["server"] || !isCanonicalRemoteEndpoint(server)
    || !requestedLocalPath || requestedLocalPath !== input["localPath"]
    || !remotePath || remotePath !== input["remotePath"]
    || remotePath.length > 2_048
    || !remotePath.startsWith('/srv/')
      && !(server === 'dev' && managedDevOrionPath(remotePath, true))
    || /[$`*?[\]{}~\0\r\n]/u.test(remotePath)
    || remotePath.split('/').some((part, index) => index > 0 && (!part || part === '.' || part === '..'))
    || isSensitiveRemoteTransferSource({ localPath: requestedLocalPath })
    || isSensitiveRemoteTransferSource({ localPath: remotePath })) {
    return undefined;
  }

  const sessionPath = resolve(dataFolderPath, '..');
  let localPath = requestedLocalPath;
  const portableSessionSource = requestedLocalPath.startsWith(`${PORTABLE_SESSION_PATH_TOKEN}/`);
  if (portableSessionSource) {
    const suffix = requestedLocalPath.slice(PORTABLE_SESSION_PATH_TOKEN.length);
    if (!suffix.startsWith('/data/') || posix.normalize(suffix) !== suffix
      || /[$`*?[\]{}~\\\0\r\n]/u.test(suffix)) return undefined;
    localPath = resolve(sessionPath, `.${suffix}`);
  } else if (requestedLocalPath.includes(PORTABLE_SESSION_PATH_TOKEN)) {
    return undefined;
  }

  const newestApplicableSegment = [...objectiveSegments].reverse().find(segment => (
    normalizeUserInstructionForChannelMatch(segment).length > 0
      && !isNonSubstantiveBoundedSoftwareFollowUp(segment)
  ));
  if (!newestApplicableSegment
    || isQuotedOrReportedBoundedSoftwareContract(newestApplicableSegment)
    || detectHighStakesEvidenceDomain(newestApplicableSegment) !== undefined
    || !isConcreteOperationalSoftwareRestatement(newestApplicableSegment)
    || !explicitlyAuthorizesStructuredRemoteReadChannel(newestApplicableSegment)
    || !explicitlyAuthorizesBoundedSoftwareRemoteEndpoint(server, newestApplicableSegment)
    || !explicitlyAuthorizesBoundedSoftwareMutationScope(newestApplicableSegment, server, remotePath)) return undefined;
  // Pi expands {{SESSION_PATH}} before PreToolUse. Bind both the model-facing
  // token form and that real runtime absolute form to the one declared source
  // root, otherwise an absolute sibling under the same session data directory
  // could inherit this upload authority.
  const declaredSourceRoots = explicitPortableSessionDataRoots(newestApplicableSegment!);
  if (declaredSourceRoots.length > 1) return undefined;
  const declaredSourceRoot = declaredSourceRoots.length === 1
    ? resolve(
      sessionPath,
      `.${declaredSourceRoots[0]!.slice(PORTABLE_SESSION_PATH_TOKEN.length)}`,
    )
    : undefined;

    const remoteRoots = explicitBoundedSoftwareRemoteRoots(newestApplicableSegment!);
    if (remoteRoots.excluded.some(root => remotePathIsWithinRoot(remotePath, root))
      || !remoteRoots.authorized.some(root => remotePathIsWithinRoot(remotePath, root))
      || !boundedSoftwareTupleAuthorizesRemotePath(
        newestApplicableSegment!,
        server,
        remotePath,
      )) {
      return undefined;
    }


  try {
    const configuredDataRoot = resolve(dataFolderPath);
    const source = resolve(localPath);
    const dataRoot = realpathSync.native(configuredDataRoot);
    if (!isPathWithinDirectory(source, configuredDataRoot)
      && !isPathWithinDirectory(source, dataRoot)) return undefined;
    if (isProtectedApplicationPath(dataRoot)) return undefined;
    let canonicalDeclaredSourceRoot = dataRoot;
    if (declaredSourceRoot) {
      const declaredRootStat = lstatSync(declaredSourceRoot);
      if (!declaredRootStat.isDirectory() || declaredRootStat.isSymbolicLink()) return undefined;
      if (pathUsesSymbolicLinkBelowBoundary(declaredSourceRoot, configuredDataRoot)) return undefined;
      canonicalDeclaredSourceRoot = realpathSync.native(declaredSourceRoot);
      if (!isPathWithinDirectory(canonicalDeclaredSourceRoot, dataRoot)) return undefined;
    }
    const sourceStat = lstatSync(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) return undefined;
    const canonicalSource = realpathSync.native(source);
    return isPathWithinDirectory(canonicalSource, canonicalDeclaredSourceRoot)
      && !pathUsesSymbolicLinkBelowBoundary(source, declaredSourceRoot ?? configuredDataRoot)
      && !isSensitiveRemoteTransferSource({ localPath: canonicalSource })
      && !isProtectedApplicationPath(canonicalSource)
      ? canonicalSource : undefined;
  } catch {
    return undefined;
  }
}
