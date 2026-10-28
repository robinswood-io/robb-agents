import { resolve } from "node:path";
import { isTargetFreeGenericContinuation } from "../sensitive-external-action.ts";
import { detectHighStakesEvidenceDomain } from "../objective-evidence-gate.ts";
import { normalizeUserInstructionForChannelMatch } from './browser-channel.ts';
import { isQuotedOrReportedBoundedSoftwareContract } from './portable-scope.ts';
import { explicitlyAuthorizesStructuredRemoteReadChannel } from './remote-identity.ts';
import { remotePathMatchesOperationalObjective } from './remote-read-authority.ts';
import { boundedSoftwareInstructionPhases, boundedSoftwareMutationIsRevoked, boundedSoftwareTargetOccurrenceIsNegated, remotePathIsWithinRoot } from './software-scope.ts';
import { explicitlyAuthorizesBoundedSoftwareMutationScope, isNonSubstantiveBoundedSoftwareFollowUp } from './software-targets.ts';

/** Orion's DEV manager keeps task checkouts under /opt. Admit only its
 * canonical integration checkout for reads and a two-component task worktree
 * for reads or writes. The shared integration checkout is never an upload
 * destination. */
export function managedDevOrionPath(path: string, taskOnly = false): boolean {
  const task = /^\/opt\/ia-webdev\/agent-dev\/worktrees\/orion\/[a-z0-9][a-z0-9-]{0,63}(?:\/|$)/u.test(path);
  return task || !taskOnly
    && /^\/opt\/ia-webdev\/agent-dev\/integration\/orion(?:\/|$)/u.test(path);
}

/** One task-bound Orion edit or named check through the audited DEV executor.
 * The sensitive-action classifier has already proved the whole shell graph is
 * a bounded implementation command; this adds the exact human target grant.
 * Keep script/control-file edits on the existing bounded upload path. */
export function isBoundedOrionWorktreeCommand(
  toolName: string,
  input: Record<string, unknown>,
  boundedLifecycle: boolean,
  objectiveSegments: readonly string[],
): boolean {
  if (toolName !== 'mcp__rbw-servers__ssh_execute' || !boundedLifecycle
    || Object.keys(input).some(key => !['server', 'cwd', 'command', 'timeout', '_displayName', '_intent'].includes(key))
    || input["server"] !== 'dev' || typeof input["cwd"] !== 'string'
    || !/^\/opt\/ia-webdev\/agent-dev\/worktrees\/orion\/[a-z0-9][a-z0-9-]{0,63}$/u.test(input["cwd"])
    || typeof input["command"] !== 'string') return false;
  const command = input["command"];
  const namedCheck = /^bun (?:run )?(?:test|check|typecheck|verify|scripts\/[A-Za-z0-9_./-]+)(?::[a-z0-9][a-z0-9:-]{0,79})?(?: [A-Za-z0-9_./ -]+)?$/u.test(command);
  const sourceEdit = /^sed -i '[^'\r\n]{1,4096}' (?:apps|packages|tests)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx)$/u.test(command);
  if (!namedCheck && !sourceEdit) return false;
  const latest = [...objectiveSegments].reverse().find(segment => (
    normalizeUserInstructionForChannelMatch(segment).length > 0
      && !isNonSubstantiveBoundedSoftwareFollowUp(segment)
  ));
  return !!latest && !isQuotedOrReportedBoundedSoftwareContract(latest)
    && !boundedSoftwareMutationIsRevoked(boundedSoftwareInstructionPhases(latest))
    && detectHighStakesEvidenceDomain(latest) === undefined
    && explicitlyAuthorizesStructuredRemoteReadChannel(latest)
    && explicitlyAuthorizesBoundedSoftwareMutationScope(latest, 'dev', input["cwd"]);
}

export function boundedRemoteCwd(
  input: Record<string, unknown>,
  endpoint: string,
  segment: string,
): string | undefined {
  const raw = input["cwd"];
  if (typeof raw !== 'string' || raw !== raw.trim()
    || !raw.startsWith('/srv/') && !(endpoint === 'dev' && managedDevOrionPath(raw))
    || raw.length > 2_048 || /[$`*?[\]{}~\0\r\n]/u.test(raw)) return undefined;
  const parts = raw.slice(1).split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return undefined;
  if (remotePathMatchesOperationalObjective(raw, endpoint, segment)) return raw;
  // Production resume prompts use one authenticated, literal tuple in this
  // exact form. Bind it directly rather than relying on prose phase pairing.
  const tuple = /P[ée]rim[eè]tre autoris[ée] exact\s*:\s*serveur\s+`([a-z0-9](?:[a-z0-9_-]|[.:](?=[a-z0-9])){0,255})`\s*,\s*d[ée]p[oô]t\s+`(\/srv\/[A-Za-z0-9_@%+=:,./()\-]{1,2044})`/iu.exec(segment);
  return tuple?.[1]?.toLowerCase() === endpoint.toLowerCase() && tuple[2] === raw
    ? raw : undefined;
}

export function resolveBoundedRemotePath(cwd: string, path: string): string | undefined {
  const resolved = path.startsWith('/') ? resolve(path) : resolve(cwd, path);
  if (!resolved.startsWith('/srv/') && !managedDevOrionPath(resolved)
    || resolved.length > 2_048
    || !remotePathIsWithinRoot(resolved, cwd)) return undefined;
  return resolved;
}

export function isSignedResumeSegment(segment: string): boolean {
  return /^\[robb-resume:[A-Za-z0-9][A-Za-z0-9:._-]{1,300}\]$/mu.test(segment);
}

/** Resolve a closed live-resume grant only when no newer authenticated human
 * segment has replaced or revoked it. A target-free "continue" can preserve
 * the exact contract; every substantive later instruction owns the authority
 * boundary and must restate a new closed grant. */
export function latestSignedResumeAuthoritySegment(
  objectiveSegments: readonly string[],
): string | undefined {
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const segment = objectiveSegments[index] ?? '';
    if (!segment.trim()) continue;
    if (isTargetFreeGenericContinuation(segment)) continue;
    return isSignedResumeSegment(segment) ? segment : undefined;
  }
  return undefined;
}

export function objectiveSegmentPositivelyMentionsAny(
  segment: string,
  literals: readonly string[],
): boolean {
  let latest: { index: number; length: number } | undefined;
  for (const literal of literals) {
    const index = segment.lastIndexOf(literal);
    if (index >= 0 && (!latest || index > latest.index)) latest = { index, length: literal.length };
  }
  return !!latest
    && !boundedSoftwareTargetOccurrenceIsNegated(segment, latest.index, latest.length);
}
