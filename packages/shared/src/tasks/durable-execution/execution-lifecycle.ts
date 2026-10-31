import type { GuardDecision, KillSwitchSnapshot, MutationCheckpoint, RecoveryDecision, SecretLeaseMetadata, SecretLeaseRequest } from './contracts.ts';

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
