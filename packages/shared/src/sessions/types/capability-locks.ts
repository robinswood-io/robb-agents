import type { ThinkingLevel } from "../../agent/thinking-levels.ts";

/**
 * Session fields that persist to disk.
 * Add new fields here - they automatically propagate to JSONL read/write
 * via pickSessionFields() utility.
 *
 * IMPORTANT: When adding a new field:
 * 1. Add it to this array
 * 2. Add it to SessionConfig interface below
 * 3. Done - serialization is automatic
 */
export const SESSION_PERSISTENT_FIELDS = [
  // Identity
  'id', 'workspaceRootPath', 'sdkSessionId', 'sdkCwd',
  // Timestamps
  'createdAt', 'lastUsedAt', 'lastMessageAt',
  // App build provenance
  'createdByApp', 'lastUsedByApp',
  // Display
  'name', 'isFlagged', 'sessionStatus', 'labels', 'hidden',
  // Read tracking
  'lastReadMessageId', 'hasUnread',
  // Config
  'enabledSourceSlugs', 'permissionMode', 'previousPermissionMode', 'workingDirectory',
  // Model/Connection
  'model', 'modelRoutePinned', 'llmConnection', 'connectionRoutePinned', 'connectionLocked', 'thinkingLevel', 'thinkingLevelPinned',
  // Sharing
  'sharedUrl', 'sharedId',
  // Plan execution
  'pendingPlanExecution',
  // Archive
  'isArchived', 'archivedAt',
  // Branching
  'branchFromMessageId',
  'branchFromSdkSessionId',
  'branchFromSessionPath',
  'branchFromSdkCwd',
  'branchFromSdkTurnId',
  // Remote transfer handoff
  'transferredSessionSummary',
  'transferredSessionSummaryApplied',
  // Automation origin
  'triggeredBy',
  // Project binding (workspace-scoped grouping)
  'projectId',
  // Kanban: task/subtask hierarchy + board column
  'parentSessionId', 'delegation',
  'kanbanColumn',
  // Tasks Conductor: link a session back to the task spec / run / DAG node that owns it
  'taskSlug',
  'taskRunId',
  'taskNodeId',
  'taskNodeCount',
  'taskDraft',
  'executionIsolation',
  // Mission Orchestration v2: durable dispatch identity for crash recovery
  'missionId',
  'missionWorkItemId',
  'missionDispatchId',
  'missionRole',
  'missionRouteLockSha256',
  'missionOrdinaryRouteLock',
  'missionCapabilityLock',
  // Runtime evidence of autonomous resolution and human-only blockers
  'autonomyEvents',
  'playbookSlug',
  'externalActionAuthorizations',
  // Durable in-flight turn marker used to recover after a host restart/stream loss
  'pendingTurnRecovery',
  // Durable objective contract used for continuation routing and per-objective budgets
  'activeObjective',
  // Durable bounded backoff preventing repeated context-compaction charges after restart
  'contextCompactionAttempt',
  // Earliest transcript row allowed into provider recovery after a fresh-context handoff
  'providerContextBoundaryMessageId',
  'pendingAgentDeliveryIds',
  'pendingQueuedMessageIds',
  'pendingAuthRequestId',
  'userInputRequests',
] as const;

/** Host-internal immutable capability lease for a specialized Mission session. */
export interface MissionCapabilityLock {
  schemaVersion: 1;
  capabilityEnvelopeSha256: string;
  capabilities: Array<{
    kind: 'skill' | 'tool' | 'source' | 'workspace-read' | 'workspace-write' | 'network' | 'external-mutation';
    name: string;
    identitySha256?: string;
    authorityBindingId?: string;
  }>;
}

/** Privacy-safe identity and credential generation of one effective source. */
export interface MissionOrdinarySourceBinding {
  slug: string;
  identitySha256: string;
  authorityBindingId?: string;
}

/**
 * Host-created, privacy-safe identity of one ordinary Mission provider
 * dispatch. Persisting the complete lock lets a recovered session reject
 * silent route, credential, source, cwd, or runtime drift before provider
 * handoff without recomputing the Mission budget decision.
 */
export interface MissionOrdinaryRouteLock {
  schemaVersion: 1;
  routeDecisionSha256: string;
  routeConfigIdentitySha256: string;
  connectionIdentitySha256: string;
  sourceIdentitySha256: string;
  agentProfileId: string;
  connectionSlug: string;
  version: number;
  profile: 'maximum-quality' | 'balanced';
  origin: 'router' | 'cost-control' | 'conductor' | 'mission';
  requestedModel?: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  measuredMissionUsd: number;
  projectedRemainingUsd?: number;
  effectiveSourceSlugs: string[];
  effectiveSourceBindings: MissionOrdinarySourceBinding[];
  cwd: string;
  runtimeIdentitySha256?: string;
}

export type SessionPersistentField = typeof SESSION_PERSISTENT_FIELDS[number];

export type ContextCompactionOutcome =
  | 'succeeded'
  | 'ineffective'
  | 'unverified'
  | 'failed'
  | 'skipped-not-needed';
