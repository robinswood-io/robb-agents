import type { ThinkingLevel } from "../../agent/thinking-levels.ts";
import type { SignedExecutionProof } from "../../governance/execution-proof.ts";

export const TASKS_DIR = 'tasks';

export const TASK_FILE = 'task.yaml';

export const RUNS_DIR = 'runs';

export const RUN_LOG = 'run-log.jsonl';

export const NODES_DIR = 'nodes';

// ---------------------------------------------------------------------------
// Run-state types
// ---------------------------------------------------------------------------

/** Per-node lifecycle state recorded in the run log. Richer than the board's SubtaskRunState. */
export type NodeRunState = 'pending' | 'waiting-approval' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';

/** Append-only run-log event. `t` is an ISO-8601 timestamp. */
export type RunLogEntry =
  | { t: string; kind: 'run-started'; taskId: string; runId: string; orchestratorSessionId?: string }
  | { t: string; kind: 'node-scheduled'; nodeId: string }
  | {
      t: string;
      kind: 'node-routed';
      nodeId: string;
      attempt: number;
      connectionSlug?: string;
      model?: string;
      thinkingLevel?: ThinkingLevel;
      connectionRoutePinned?: boolean;
      modelRoutePinned?: boolean;
      thinkingLevelPinned?: boolean;
      strategy: 'primary' | 'retry-fallback' | 'pinned';
    }
  | { t: string; kind: 'node-spawned'; nodeId: string; sessionId: string }
  | {
      t: string;
      kind: 'node-checkpoint';
      nodeId: string;
      idempotencyKey: string;
      status: 'prepared' | 'executing' | 'confirmed';
      proofHash?: string;
      executionProof?: SignedExecutionProof;
    }
  | { t: string; kind: 'node-finished'; nodeId: string; sessionId: string; state: NodeRunState; reason?: string }
  | {
      t: string;
      kind: 'node-retry';
      nodeId: string;
      attempt: number;
      reason: string;
      delayMs?: number;
      retryAt?: string;
    }
  | { t: string; kind: 'run-paused' | 'run-resumed' | 'run-stopped' | 'run-completed' | 'run-failed' | 'run-verifying' }
  | {
      t: string;
      kind: 'run-pause-draining';
      /** Exact worker identities that still have to be proven idle while the
       * non-terminal run remains paused. */
      sessionIds: string[];
    }
  | { t: string; kind: 'run-pause-drained' }
  | {
      t: string;
      kind: 'run-draining';
      target: 'failed' | 'stopped';
      cause: 'budget' | 'deadline' | 'kill-switch' | 'operator' | 'timeout' | 'recovery' | 'reviewer';
      /** Exact worker identities that must be proven idle before the terminal
       * state may be published. Persisting them closes the crash window between
       * requesting cancellation and appending the terminal event. */
      sessionIds: string[];
      /** Reviewer identities are kept separate so recovery cannot mistake a
       * completed receipt for an ordinary worker result. */
      reviewerSessionIds?: string[];
      reason?: string;
      scope?: 'global' | 'workspace' | 'mission';
    }
  | {
      t: string;
      kind: 'verdict';
      result: 'pass' | 'fail' | 'unparsed';
      reason?: string;
      nodes?: string[];
      /** Canonical hash of the outputs evaluated for this FAIL verdict. */
      outputFingerprint?: string;
      /** Materialized repair frontier, retained for crash-safe reflective memory. */
      frontier?: string[];
      /** Number of repeated rejected fingerprints observed in the current no-progress streak. */
      stagnantRepeats?: number;
    }
  | {
      t: string;
      kind: 'stagnation-detected';
      fingerprint: string;
      repetitions: number;
      limit: number;
      nodes: string[];
      reason: string;
    }
  | {
      t: string;
      kind: 'approval-requested';
      requestId: string;
      nodeId: string;
      reason: string;
      impact: 'low' | 'medium' | 'high' | 'critical';
      owner?: string;
    }
  | {
      t: string;
      kind: 'approval-resolved';
      requestId: string;
      nodeId: string;
      decision: 'approved' | 'rejected';
      actor: string;
      comment?: string;
    }
  | { t: string; kind: 'run-replayed'; sourceRunId: string; externalMutationsApproved: boolean }
  | { t: string; kind: 'node-reused'; nodeId: string; sourceRunId: string; proofHash?: string }
  | {
      t: string;
      kind: 'usage-updated';
      tokensUsed: number;
      costUsed?: number;
      currency?: 'USD' | 'EUR';
      /** Durable per-session high-water marks prevent a recovered cumulative
       * provider receipt from being charged a second time after a crash. */
      sourceSessionId?: string;
      cumulativeTokens?: number;
      cumulativeCostUsd?: number;
    }
  | { t: string; kind: 'budget-breach'; metric: 'tokens' | 'cost' | 'parallel' | 'iterations'; value: number; limit: number }
  | { t: string; kind: 'deadline-breach'; deadline: string }
  | { t: string; kind: 'kill-switch'; scope: 'global' | 'workspace' | 'mission'; reason: string };
