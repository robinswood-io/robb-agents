import { MAX_ISOLATED_READ_TOOL_INVOCATIONS, canonicalExecutionIsolationToolInput } from './canonical-input.ts';
import type { ExecutionIsolationPolicy, GuardDecision, SessionExecutionIsolation } from './contracts.ts';
import { isLocalHostname } from './network.ts';
import { authorizeWorkspacePath } from './workspace-paths.ts';

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

  const allowedReadToolInvocations = policy.allowedReadToolInvocations ?? [];
  if (allowedReadToolInvocations.length > MAX_ISOLATED_READ_TOOL_INVOCATIONS) {
    return {
      allowed: false,
      reason: `Read tool invocation allow-list exceeds ${MAX_ISOLATED_READ_TOOL_INVOCATIONS} entries`,
    };
  }
  const invocationIdentities = new Set<string>();
  for (const invocation of allowedReadToolInvocations) {
    if (!invocation || typeof invocation.toolName !== 'string'
      || !/^mcp__[A-Za-z0-9._-]+__[A-Za-z0-9._-]+$/.test(invocation.toolName)
      || invocation.toolName.length > 512
      || typeof invocation.inputJson !== 'string') {
      return { allowed: false, reason: 'Read tool invocation allow-list entry is malformed' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(invocation.inputJson);
    } catch {
      return { allowed: false, reason: 'Read tool invocation input is not valid JSON' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || canonicalExecutionIsolationToolInput(parsed as Record<string, unknown>) !== invocation.inputJson) {
      return { allowed: false, reason: 'Read tool invocation input is not canonical' };
    }
    const identity = `${invocation.toolName}\u0000${invocation.inputJson}`;
    if (invocationIdentities.has(identity)) {
      return { allowed: false, reason: 'Read tool invocation allow-list contains duplicates' };
    }
    invocationIdentities.add(identity);
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
