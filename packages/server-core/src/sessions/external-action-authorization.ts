import type {
  ExternalActionAuthorization,
  ExternalActionAuthorizationCategory,
} from '@craft-agent/shared/sessions';

export const DEFAULT_EXTERNAL_ACTION_GRANT_TTL_MS = 60 * 60 * 1000;
const MAX_EXTERNAL_ACTION_GRANTS = 50;

function normalizeTarget(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function uniqueTargets(targetCandidates: string[]): string[] {
  return [...new Set(targetCandidates
    .map(target => target.trim())
    .filter(target => target.length > 0 && target.length <= 200))]
    .slice(0, 12);
}

function canonicalTargetSet(targetCandidates: string[]): string[] {
  return [...new Set(targetCandidates.map(normalizeTarget).filter(Boolean))].sort();
}

function hasSameTargetSet(left: string[], right: string[]): boolean {
  const canonicalLeft = canonicalTargetSet(left);
  const canonicalRight = canonicalTargetSet(right);
  return canonicalLeft.length === canonicalRight.length
    && canonicalLeft.every((target, index) => target === canonicalRight[index]);
}

export function pruneExternalActionAuthorizations(
  grants: ExternalActionAuthorization[] | undefined,
  nowMs = Date.now(),
): ExternalActionAuthorization[] {
  return (grants ?? [])
    .filter(grant => grant.expiresAt > nowMs && grant.targetCandidates.length > 0)
    .slice(-MAX_EXTERNAL_ACTION_GRANTS);
}

export function hasMatchingExternalActionAuthorization(
  grants: ExternalActionAuthorization[] | undefined,
  request: {
    category?: ExternalActionAuthorizationCategory;
    targetCandidates?: string[];
  },
  nowMs = Date.now(),
): boolean {
  const requestTargets = request.targetCandidates;
  if (!request.category || !requestTargets?.length) return false;
  if (canonicalTargetSet(requestTargets).length === 0) return false;

  return pruneExternalActionAuthorizations(grants, nowMs).some(grant =>
    grant.category === request.category
    && hasSameTargetSet(grant.targetCandidates, requestTargets)
  );
}

export function rememberExternalActionAuthorization(
  grants: ExternalActionAuthorization[] | undefined,
  request: {
    category?: ExternalActionAuthorizationCategory;
    targetCandidates?: string[];
    toolName?: string;
  },
  nowMs = Date.now(),
  ttlMs = DEFAULT_EXTERNAL_ACTION_GRANT_TTL_MS,
): ExternalActionAuthorization[] {
  const targetCandidates = uniqueTargets(request.targetCandidates ?? []);
  if (!request.category || !request.toolName || targetCandidates.length === 0) {
    return pruneExternalActionAuthorizations(grants, nowMs);
  }

  const next: ExternalActionAuthorization = {
    category: request.category,
    targetCandidates,
    toolName: request.toolName,
    grantedAt: nowMs,
    expiresAt: nowMs + Math.max(1, ttlMs),
  };
  const withoutSuperseded = pruneExternalActionAuthorizations(grants, nowMs).filter(grant =>
    grant.category !== next.category
    || !hasSameTargetSet(grant.targetCandidates, targetCandidates)
  );
  return [...withoutSuperseded, next].slice(-MAX_EXTERNAL_ACTION_GRANTS);
}

/** Sensitive confirmations are remembered only by the host's exact scoped grant. */
export function providerAlwaysAllowForExternalAction(
  alwaysAllow: boolean,
  category?: ExternalActionAuthorizationCategory,
): boolean {
  return alwaysAllow && !category;
}
