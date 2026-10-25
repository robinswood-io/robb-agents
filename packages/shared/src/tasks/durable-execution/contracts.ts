
export type NetworkAccessMode = 'disabled' | 'allow-list';

export interface ExecutionIsolationPolicy {
  workspaceRoot: string;
  allowedReadPaths: readonly string[];
  allowedWritePaths: readonly string[];
  /**
   * Host-preflighted connector observations available to a read-only Mission
   * reviewer. The central permission pipeline must still classify the live
   * invocation as a read; this only prevents the task-isolation layer from
   * rejecting the exact same source/tool/input tuple afterwards.
   */
  allowedReadToolInvocations?: readonly ExactReadToolInvocation[];
  networkAccess: NetworkAccessMode;
  allowedHosts: readonly string[];
  maxCpuPercent: number;
  maxMemoryMb: number;
  timeoutMs: number;
}

export interface ExactReadToolInvocation {
  toolName: string;
  /** Canonical JSON object produced by canonicalExecutionIsolationToolInput. */
  inputJson: string;
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
