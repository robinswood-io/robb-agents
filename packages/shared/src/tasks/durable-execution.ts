/**
 * Durable execution guardrails shared by the Task runner and future connector
 * workers. This module intentionally stores metadata only: secret values never
 * belong in a checkpoint, run log, or dead-letter record.
 */
import { existsSync, realpathSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { isIP } from 'node:net';

export type NetworkAccessMode = 'disabled' | 'allow-list';

export interface ExecutionIsolationPolicy {
  workspaceRoot: string;
  allowedReadPaths: readonly string[];
  allowedWritePaths: readonly string[];
  networkAccess: NetworkAccessMode;
  allowedHosts: readonly string[];
  maxCpuPercent: number;
  maxMemoryMb: number;
  timeoutMs: number;
}

export type ExecutionEffect = 'read' | 'workspace-write' | 'external-mutation';

/**
 * Immutable-by-contract execution envelope persisted with every Conductor
 * child session. The effect is kept alongside the path/network policy so the
 * central tool gateway can reject a write even when a task-level policy has a
 * broader write allow-list for another DAG node.
 */
export interface SessionExecutionIsolation {
  policy: ExecutionIsolationPolicy;
  effect: ExecutionEffect;
}

export interface GuardDecision {
  allowed: boolean;
  reason?: string;
}

export interface ResolvedNetworkAddress {
  address: string;
  family: 4 | 6;
}

export type NetworkHostResolver = (hostname: string) => Promise<readonly ResolvedNetworkAddress[]>;

export interface SecretLeaseMetadata {
  leaseId: string;
  secretName: string;
  workspaceId: string;
  missionId?: string;
  toolName?: string;
  issuedAt: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
}

export interface SecretLeaseRequest {
  workspaceId: string;
  missionId?: string;
  toolName?: string;
  now: string;
}

export interface KillSwitchSnapshot {
  global: boolean;
  workspaceIds: readonly string[];
  missionIds: readonly string[];
}

export type MutationCheckpointStatus = 'prepared' | 'executing' | 'confirmed' | 'failed';

export interface MutationCheckpoint {
  idempotencyKey: string;
  workspaceId: string;
  missionId: string;
  nodeId: string;
  status: MutationCheckpointStatus;
  attempts: number;
  updatedAt: string;
  /** Provider receipt, response digest, or another non-secret confirmation. */
  proofHash?: string;
}

export type RecoveryAction = 'retry' | 'reuse-confirmed' | 'require-approval' | 'blocked';

export interface RecoveryDecision {
  action: RecoveryAction;
  reason: string;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function nearestExistingAncestor(candidate: string): string {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * Reject lexical traversal and existing symlink escapes. For a path that does
 * not exist yet, its nearest existing ancestor is canonicalized first.
 */
export function authorizeWorkspacePath(
  workspaceRoot: string,
  candidatePath: string,
  allowedPaths: readonly string[],
): GuardDecision {
  if (candidatePath.includes('\0')) {
    return { allowed: false, reason: 'Path contains a null byte' };
  }

  const lexicalRoot = resolve(workspaceRoot);
  if (!existsSync(lexicalRoot)) {
    return { allowed: false, reason: 'Workspace root does not exist' };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(lexicalRoot);
  } catch {
    return { allowed: false, reason: 'Workspace root cannot be canonicalized' };
  }
  const lexicalCandidate = isAbsolute(candidatePath)
    ? resolve(candidatePath)
    : resolve(lexicalRoot, candidatePath);
  if (!isInside(lexicalRoot, lexicalCandidate)) {
    return { allowed: false, reason: 'Path escapes the workspace root' };
  }

  let ancestor: string;
  try {
    ancestor = realpathSync(nearestExistingAncestor(lexicalCandidate));
  } catch {
    return { allowed: false, reason: 'Path cannot be canonicalized' };
  }
  if (!isInside(canonicalRoot, ancestor)) {
    return { allowed: false, reason: 'Path escapes the workspace through a symbolic link' };
  }

  const allowed = allowedPaths.some((allowedPath) => {
    const allowedAbsolute = isAbsolute(allowedPath)
      ? resolve(allowedPath)
      : resolve(lexicalRoot, allowedPath);
    if (!isInside(lexicalRoot, allowedAbsolute)) return false;
    return isInside(allowedAbsolute, lexicalCandidate);
  });

  return allowed
    ? { allowed: true }
    : { allowed: false, reason: 'Path is outside the configured allow-list' };
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function normalizeIpAddress(address: string): string {
  const withoutBrackets = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return withoutBrackets.split('%')[0] ?? withoutBrackets;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = normalizeIpAddress(address);
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) {
    return isPrivateIpv4(normalized.slice('::ffff:'.length));
  }

  const firstGroup = normalized.split(':')[0];
  const first = Number.parseInt(firstGroup ?? '', 16);
  if (!Number.isInteger(first)) return false;
  return (first >= 0xfc00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf);
}

function isPrivateIpAddress(address: string): boolean {
  const normalized = normalizeIpAddress(address);
  const family = isIP(normalized);
  return family === 4 ? isPrivateIpv4(normalized) : family === 6 ? isPrivateIpv6(normalized) : false;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = normalizeIpAddress(hostname);
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    isPrivateIpAddress(normalized)
  );
}

function hostMatchesRule(hostname: string, rule: string): boolean {
  const normalizedRule = rule.trim().toLowerCase();
  if (normalizedRule.startsWith('*.')) {
    const suffix = normalizedRule.slice(1);
    return hostname.endsWith(suffix) && hostname !== suffix.slice(1);
  }
  return hostname === normalizedRule;
}

/** Validate outbound HTTP(S) access without allowing localhost/private SSRF. */
export function authorizeNetworkUrl(
  urlString: string,
  mode: NetworkAccessMode,
  allowedHosts: readonly string[],
): GuardDecision {
  if (mode === 'disabled') {
    return { allowed: false, reason: 'Network access is disabled for this task' };
  }

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { allowed: false, reason: 'Network target is not a valid URL' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { allowed: false, reason: 'Only HTTP(S) network targets are supported' };
  }
  const hostname = url.hostname.toLowerCase();
  if (isLocalHostname(hostname)) {
    return { allowed: false, reason: 'Local and private network targets are blocked' };
  }
  if (!allowedHosts.some((rule) => hostMatchesRule(hostname, rule))) {
    return { allowed: false, reason: 'Network host is outside the configured allow-list' };
  }
  return { allowed: true };
}

const defaultNetworkHostResolver: NetworkHostResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.flatMap(({ address, family }) =>
    family === 4 || family === 6 ? [{ address, family }] : [],
  );
};

/**
 * Resolve an allow-listed hostname and reject the request if any answer points
 * at a local/private address. This closes the DNS-rebinding gap left by a
 * lexical host allow-list alone.
 */
export async function authorizeResolvedNetworkUrl(
  urlString: string,
  mode: NetworkAccessMode,
  allowedHosts: readonly string[],
  resolver: NetworkHostResolver = defaultNetworkHostResolver,
): Promise<GuardDecision> {
  const lexicalDecision = authorizeNetworkUrl(urlString, mode, allowedHosts);
  if (!lexicalDecision.allowed) return lexicalDecision;

  const hostname = new URL(urlString).hostname.toLowerCase();
  if (isIP(normalizeIpAddress(hostname)) !== 0) {
    return lexicalDecision;
  }

  let addresses: readonly ResolvedNetworkAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    return { allowed: false, reason: 'Network host could not be resolved safely' };
  }
  if (addresses.length === 0) {
    return { allowed: false, reason: 'Network host did not resolve to an address' };
  }
  if (addresses.some(({ address }) => isPrivateIpAddress(address))) {
    return { allowed: false, reason: 'Network host resolves to a local or private address' };
  }
  return { allowed: true };
}

/**
 * Validate a task's complete isolation envelope against the actual workspace
 * owned by the host. This is admission control; operating-system sandboxing is
 * still delegated to the host execution guard.
 */
export function validateExecutionIsolationPolicy(
  policy: ExecutionIsolationPolicy,
  hostWorkspaceRoot: string,
): GuardDecision {
  const rootDecision = authorizeWorkspacePath(hostWorkspaceRoot, policy.workspaceRoot, ['.']);
  if (!rootDecision.allowed) {
    return { allowed: false, reason: `Isolation root rejected: ${rootDecision.reason}` };
  }

  for (const path of [...policy.allowedReadPaths, ...policy.allowedWritePaths]) {
    const pathDecision = authorizeWorkspacePath(policy.workspaceRoot, path, ['.']);
    if (!pathDecision.allowed) {
      return { allowed: false, reason: `Isolation path "${path}" rejected: ${pathDecision.reason}` };
    }
  }

  if (
    !Number.isFinite(policy.maxCpuPercent) ||
    policy.maxCpuPercent <= 0 ||
    policy.maxCpuPercent > 100 ||
    !Number.isInteger(policy.maxMemoryMb) ||
    policy.maxMemoryMb <= 0 ||
    !Number.isInteger(policy.timeoutMs) ||
    policy.timeoutMs <= 0
  ) {
    return { allowed: false, reason: 'Resource envelope contains invalid limits' };
  }

  if (policy.networkAccess === 'disabled' && policy.allowedHosts.length > 0) {
    return { allowed: false, reason: 'Network hosts are configured while network access is disabled' };
  }
  for (const rule of policy.allowedHosts) {
    const normalized = rule.trim().toLowerCase();
    const hostname = normalized.startsWith('*.') ? normalized.slice(2) : normalized;
    if (
      hostname.length === 0 ||
      hostname.includes('/') ||
      hostname.includes(':') ||
      hostname.includes('*') ||
      isLocalHostname(hostname)
    ) {
      return { allowed: false, reason: `Network allow-list rule "${rule}" is unsafe` };
    }
  }

  return { allowed: true };
}

/** Validate the complete per-session envelope before it is persisted or used. */
export function validateSessionExecutionIsolation(
  isolation: SessionExecutionIsolation,
  hostWorkspaceRoot: string,
): GuardDecision {
  if (!['read', 'workspace-write', 'external-mutation'].includes(isolation.effect)) {
    return { allowed: false, reason: 'Execution effect is invalid' };
  }
  return validateExecutionIsolationPolicy(isolation.policy, hostWorkspaceRoot);
}

/** Authorize a short-lived, scoped secret lease without reading its value. */
export function authorizeSecretLease(
  lease: SecretLeaseMetadata,
  request: SecretLeaseRequest,
): GuardDecision {
  if (lease.workspaceId !== request.workspaceId) {
    return { allowed: false, reason: 'Secret lease belongs to another workspace' };
  }
  if (lease.missionId !== undefined && lease.missionId !== request.missionId) {
    return { allowed: false, reason: 'Secret lease belongs to another mission' };
  }
  if (lease.toolName !== undefined && lease.toolName !== request.toolName) {
    return { allowed: false, reason: 'Secret lease is not scoped to this tool' };
  }
  if (Date.parse(request.now) >= Date.parse(lease.expiresAt)) {
    return { allowed: false, reason: 'Secret lease has expired' };
  }
  if (lease.uses >= lease.maxUses) {
    return { allowed: false, reason: 'Secret lease use limit is exhausted' };
  }
  return { allowed: true };
}

export function evaluateKillSwitch(
  snapshot: KillSwitchSnapshot,
  workspaceId: string,
  missionId: string,
): GuardDecision {
  if (snapshot.global) return { allowed: false, reason: 'Global kill switch is active' };
  if (snapshot.workspaceIds.includes(workspaceId)) {
    return { allowed: false, reason: 'Workspace kill switch is active' };
  }
  if (snapshot.missionIds.includes(missionId)) {
    return { allowed: false, reason: 'Mission kill switch is active' };
  }
  return { allowed: true };
}

/**
 * Recovery never retries a confirmed mutation. An interrupted mutation without
 * provider proof is ambiguous and must be reviewed rather than replayed.
 */
export function decideMutationRecovery(
  checkpoint: MutationCheckpoint,
  killSwitch: GuardDecision = { allowed: true },
): RecoveryDecision {
  if (!killSwitch.allowed) {
    return { action: 'blocked', reason: killSwitch.reason ?? 'Execution is blocked' };
  }
  if (checkpoint.status === 'confirmed') {
    return {
      action: 'reuse-confirmed',
      reason: checkpoint.proofHash
        ? 'Mutation is confirmed by durable proof'
        : 'Mutation is marked confirmed and must not be repeated',
    };
  }
  if (checkpoint.status === 'executing') {
    return {
      action: 'require-approval',
      reason: 'Mutation outcome is ambiguous after interruption; inspect provider state before replay',
    };
  }
  return {
    action: 'retry',
    reason: checkpoint.status === 'failed'
      ? 'A failed mutation may be retried under its bounded retry policy'
      : 'Prepared mutation has not started',
  };
}
