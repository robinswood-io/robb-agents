
export type MissionBlockerStatus = 'open' | 'resolved';

export interface MissionBlocker {
  id: string;
  cause: string;
  owner: string;
  resolution: string;
  status: MissionBlockerStatus;
  nodeId?: string;
}

export interface MissionApproval {
  requestId: string;
  nodeId: string;
  reason: string;
  impact: 'low' | 'medium' | 'high' | 'critical';
  owner: string;
  status: 'pending' | 'approved' | 'rejected';
  actor?: string;
  comment?: string;
  requestedAt: string;
  resolvedAt?: string;
}

export type MissionEvaluationStatus = 'not-evaluated' | 'pending' | 'passing' | 'failing';

export interface MissionEvaluationReport {
  status: MissionEvaluationStatus;
  acceptance: 'not-evaluated' | 'pass' | 'fail' | 'unparsed';
  evaluatedNodes: number;
  successfulNodes: number;
  failedNodes: number;
  nodeSuccessRate?: number;
  safetyIssueCount: number;
  evidenceCount: number;
  failures: string[];
}

export interface MissionCostReport {
  status: 'untracked' | 'tracking' | 'within-budget' | 'warning' | 'exceeded';
  currency: 'USD' | 'EUR';
  used?: number;
  limit?: number;
  remaining?: number;
  percentUsed?: number;
  warningPercent: number;
}

export interface MissionControlSnapshot {
  schemaVersion: 1;
  missionId: string;
  runId: string;
  title: string;
  objective: string;
  status: 'not-started' | 'running' | 'paused' | 'waiting-approval' | 'verifying' | 'completed' | 'failed' | 'stopped';
  progress: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    pending: number;
    percent: number;
  };
  budget: {
    maxTokens?: number;
    maxCost?: number;
    currency?: 'USD' | 'EUR';
    tokensUsed?: number;
    costUsed?: number;
  };
  evaluation: MissionEvaluationReport;
  cost: MissionCostReport;
  deadline?: string;
  approvals: MissionApproval[];
  blockers: MissionBlocker[];
  nextActions: string[];
  eventCount: number;
  latestEventAt?: string;
}

export interface MissionControlTelemetry {
  tokensUsed?: number;
  costUsed?: number;
  currency?: 'USD' | 'EUR';
  maxTokens?: number;
  maxCost?: number;
  warningPercent?: number;
}

export interface MissionReplayNodePlan {
  nodeId: string;
  action: 'reuse' | 'retry' | 'block';
  reason: string;
  effect: 'read' | 'workspace-write' | 'external-mutation';
}

export interface MissionReplayPlan {
  sourceRunId: string;
  safeByDefault: boolean;
  nodes: MissionReplayNodePlan[];
  requiresApproval: boolean;
  blockedNodeIds: string[];
}
