import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isProtectedApplicationPath } from "@craft-agent/session-tools-core";
import { resolve } from "node:path";
import { isPathWithinDirectory } from "../../mode-manager.ts";
import { classifyBoundedTargetedRemoteOperationalInspection, isBoundedRemoteStaticSourceInspection, remoteStaticSourceInspectionLiteralPath, remoteStaticSourceInspectionLiteralPaths, type BoundedTargetedRemoteOperationalInspection } from "../registered-observation.ts";
import { normalizeUserInstructionForChannelMatch } from './browser-channel.ts';
import { boundedStructuredRemoteExecutionInput, explicitDockerRegistryFromImageTarget, isCanonicalRemoteEndpoint, objectiveExplicitlyAuthorizesDockerRegistry, remoteProjectTargetMatchesEndpoint, staticSourceInspectionRemotePath } from './remote-identity.ts';
import { remotePathMatchesOperationalObjective, targetBoundOperationalTechnicalReadAuthoritySegment } from './remote-read-authority.ts';
import { resumedRemoteReadCommandMatchesObjective } from './resumed-remote-reads.ts';
import { boundedRemoteCwd, resolveBoundedRemotePath } from './signed-resume-targets.ts';

function operationalInspectionMatchesObjective(
  inspection: BoundedTargetedRemoteOperationalInspection,
  endpoint: string,
  segment: string,
): boolean {
  if (inspection.kind === 'http') {
    if (inspection.followsRedirects || inspection.method !== 'GET') return false;
    let url: URL;
    try { url = new URL(inspection.url); } catch { return false; }
    if (url.protocol !== 'http:' || url.port !== '8888'
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())
      || url.username || url.password || url.search || url.hash
      || endpoint.toLowerCase() !== 'pns') return false;
    const route = /^\/api\/v1\/edoc-optimized\/status\/([1-9]\d{0,18})\/?$/u.exec(url.pathname);
    if (!route) return false;
    const identifiers: string[] = normalizeUserInstructionForChannelMatch(segment)
      .match(/[a-z0-9](?:[a-z0-9_-]|[.:](?=[a-z0-9])){0,255}/g) ?? [];
    return identifiers.includes(route[1]!);
  }
  if (inspection.kind === 'docker-compose') {
    return remotePathMatchesOperationalObjective(inspection.path, endpoint, segment);
  }
  if (inspection.kind === 'docker-manifest') {
    const registry = explicitDockerRegistryFromImageTarget(inspection.target);
    return !!registry
      && objectiveExplicitlyAuthorizesDockerRegistry(registry, segment)
      && remoteProjectTargetMatchesEndpoint(inspection.target, endpoint);
  }
  if (inspection.output === 'unsafe') return false;
  const targets = inspection.targets;
  return targets.every((target) => {
    if (!remoteProjectTargetMatchesEndpoint(target, endpoint)) return false;
    // A locally named image (`sample-app:local`) is resolved only from the
    // target daemon and remains useful as deployment evidence. Once a target
    // carries an explicit registry qualifier, bind that registry exactly to
    // the human objective just like `docker manifest inspect`; matching only
    // the trailing project basename could otherwise attest the wrong image.
    const registry = explicitDockerRegistryFromImageTarget(target);
    return registry === undefined
      || objectiveExplicitlyAuthorizesDockerRegistry(registry, segment);
  });
}

/** The configured SSH connector may open an observational transport or copy a
 * technical source into this session's isolated data folder. Bind that read
 * authority to the explicitly named server; discovered source paths under the
 * target inherit it, but arbitrary destinations, secret-like files and every
 * remote write remain outside this exception. */
export function isBoundedStructuredRemoteTechnicalRead(
  toolName: string,
  input: Record<string, unknown>,
  dataFolderPath: string | undefined,
  objectiveSegments: readonly string[],
): boolean {
  const rawServer = typeof input.server === 'string' ? input.server : '';
  const server = rawServer.trim();
  if (rawServer !== server || !isCanonicalRemoteEndpoint(server)) return false;
  const authoritySegment = targetBoundOperationalTechnicalReadAuthoritySegment(input, objectiveSegments);
  if (!authoritySegment) return false;
  if (toolName === 'mcp__rbw-servers__ssh_execute') {
    if (!boundedStructuredRemoteExecutionInput(input)) return false;
    const command = typeof input.command === 'string' ? input.command : '';
    const operationalInspection = classifyBoundedTargetedRemoteOperationalInspection(command);
    if (operationalInspection) {
      return operationalInspectionMatchesObjective(operationalInspection, server, authoritySegment);
    }
    if (isBoundedRemoteStaticSourceInspection(command)) {
      const remotePath = staticSourceInspectionRemotePath(command);
      return !!remotePath && remotePathMatchesOperationalObjective(
        remotePath,
        server,
        authoritySegment,
      );
    }
    const cwd = boundedRemoteCwd(input, server, authoritySegment);
    if (!cwd) return false;
    const sourcePaths = remoteStaticSourceInspectionLiteralPaths(command);
    if (sourcePaths) {
      return sourcePaths.every(sourcePath => !!resolveBoundedRemotePath(cwd, sourcePath));
    }
    const sourcePath = remoteStaticSourceInspectionLiteralPath(command);
    if (sourcePath) {
      const remotePath = resolveBoundedRemotePath(cwd, sourcePath);
      // `boundedRemoteCwd` already proved the exact server/root tuple and the
      // resolver confines this one literal source path below that root.
      return !!remotePath;
    }
    return resumedRemoteReadCommandMatchesObjective(
      command,
      cwd,
      authoritySegment,
    );
  }
  if (toolName === 'mcp__rbw-servers__ssh_session_start') {
    if (Object.keys(input).some(key => !['server', 'name', '_displayName', '_intent'].includes(key))) {
      return false;
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name);
  }
  if (toolName !== 'mcp__rbw-servers__ssh_download' || !dataFolderPath) return false;
  if (Object.keys(input).some(key => ![
    'server', 'remotePath', 'localPath', '_displayName', '_intent',
  ].includes(key))) return false;
  const remotePath = typeof input.remotePath === 'string' ? input.remotePath.trim() : '';
  const localPath = typeof input.localPath === 'string' ? input.localPath.trim() : '';
  const remoteSegments = remotePath.startsWith('/srv/')
    ? remotePath.slice('/srv/'.length).split('/')
    : [];
  if (!/^\/srv\/[A-Za-z0-9_@%+=:,./()\-]{1,2044}\.(?:c?js|mjs|ts|tsx|json|sql|ya?ml|toml|ini|conf|md|service)$/i.test(remotePath)
    || remoteSegments.length === 0
    || remoteSegments.some(segment => !segment || segment === '.' || segment === '..')
    || /(?:^|\/)(?:\.env(?:\.[^\/]*)?|\.ssh|secret[^\/]*|credentials?[^\/]*|private[_-]?key[^\/]*)(?=\/|$)/i.test(remotePath)) {
    return false;
  }
  if (!remotePathMatchesOperationalObjective(remotePath, server, authoritySegment)) return false;
  const dataRoot = resolve(dataFolderPath);
  const destination = resolve(localPath);
  if (destination === dataRoot || !isPathWithinDirectory(destination, dataRoot)) return false;
  try {
    // A replaced data root or a symlink/hardlink leaf could turn this local
    // observation artifact into a write outside the session (including the
    // installed application bundle). Keep the downgrade to read-only limited
    // to a real session directory and an ordinary confined destination.
    const rootStat = lstatSync(dataRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
    const canonicalRoot = realpathSync.native(dataRoot);
    if (isProtectedApplicationPath(canonicalRoot)) return false;
    if (existsSync(destination)) {
      const destinationStat = lstatSync(destination);
      if (!destinationStat.isFile()
        || destinationStat.isSymbolicLink()
        || destinationStat.nlink !== 1) return false;
    }
  } catch {
    return false;
  }
  return true;
}
