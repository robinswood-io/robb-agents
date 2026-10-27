/**
 * Optional operations-control extension contract.
 *
 * This file is deliberately implementation-free: public Robb Agents builds
 * expose the host seam but do not ship the commercial policy engine.
 */

import type { ThinkingLevel } from '../agent/thinking-levels.ts';

export const ROBB_OPERATIONS_API_VERSION = 1 as const;

export type OperationsBudgetWarningAction = 'notify' | 'require-approval';
export type OperationsBudgetHardLimitAction = 'notify' | 'require-approval' | 'block';

export interface OperationsBudgetSettingsDto {
  warningAction: OperationsBudgetWarningAction;
  hardLimitAction: OperationsBudgetHardLimitAction;
  sessionWarningUsd: number;
  sessionHardUsd: number;
  missionWarningUsd: number;
  missionHardUsd: number;
  workspaceDailyWarningUsd: number;
  workspaceDailyHardUsd: number;
}

export interface OperationsSettingsDto {
  budgets: OperationsBudgetSettingsDto;
}

export interface OperationsNotice {
  code: 'budget-warning' | 'budget-limit';
  level: 'warning';
  message: string;
  recommendation?: string;
}

export type OperationsStatusDto =
  | { available: false }
  | { available: true; extensionId: string; snapshot: unknown; settings?: OperationsSettingsDto };

export interface OperationsTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
  contextWindow?: number;
  costUsd?: number;
}

export interface OperationsConnectionCandidate {
  slug: string;
  providerType: string;
  defaultModel?: string;
  models?: string[];
  miniModel?: string;
  modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier';
}

export interface OperationsTurnInput {
  now: string;
  workspaceId: string;
  workspaceRootPath: string;
  sessionId: string;
  missionId?: string;
  workItemId?: string;
  missionRole?: 'planner' | 'worker' | 'reviewer' | 'supervisor';
  /** Host-derived continuity intent. Commercial routing must not infer resumes from word count alone. */
  turnKind?: 'new-request' | 'resume' | 'automatic-recovery' | 'quality-correction';
  /** Number of independent correction rounds already requested for this objective. */
  qualityIteration?: number;
  message: string;
  hidden: boolean;
  messageCount: number;
  completedAssistantTurns: number;
  /** Recent visible user requests, oldest first, bounded by the host. */
  recentUserMessages?: string[];
  /** Last visible final answer, bounded by the host, for continuity-aware routing. */
  lastFinalText?: string;
  pendingRecovery?: {
    active: boolean;
    attempts: number;
    cause?: 'app_restart' | 'stream_ended' | 'runtime_error' | 'premature_final';
  };
  tokenUsage?: OperationsTokenUsage;
  currentConnectionSlug?: string;
  currentModel?: string;
  currentThinkingLevel?: ThinkingLevel;
  enabledSourceSlugs: string[];
  sourceSensitivity?: 'public' | 'internal' | 'confidential' | 'restricted';
  connections: OperationsConnectionCandidate[];
}

export type OperationsAdmissionDecision = 'allow' | 'require-approval' | 'block';

export interface OperationsTurnDecision {
  decision: OperationsAdmissionDecision;
  reason?: string;
  approvalId?: string;
  /** Host persists and sends this value instead of the original when supplied. */
  sanitizedMessage?: string;
  /** Optional adaptive route. The host still verifies that the connection exists. */
  connectionSlug?: string;
  /** Model inside the selected account/connection. The host validates it. */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  agentSpecialty?: string;
  modelTier?: 'fast' | 'balanced' | 'best';
  /** Persist a durable state checkpoint before execution. */
  checkpoint?: boolean;
  explanation?: string;
  /** Non-blocking notices surfaced by the host before the turn continues. */
  notices?: OperationsNotice[];
  /** Proactive context maintenance requested before the admitted user turn. */
  contextManagement?: {
    action: 'compact-before-turn';
    reason: string;
    instructions: string;
  };
  /** Independent, account-pinned verification before a completion is shown. */
  completionReview?: {
    mode: 'claims-and-actions';
    reviewerModel: string;
    reviewerThinkingLevel: ThinkingLevel;
    maxIterations: number;
    reason: string;
  };
}

export interface OperationsToolInput {
  now: string;
  workspaceId: string;
  workspaceRootPath: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  permissionMode: 'safe' | 'ask' | 'allow-all';
  workingDirectory?: string;
}

export type OperationsToolDecision =
  | { decision: 'allow'; input?: Record<string, unknown>; classification?: string }
  | { decision: 'block'; reason: string; classification?: string }
  | {
      decision: 'require-approval';
      reason: string;
      classification?: string;
      input?: Record<string, unknown>;
    };

export type OperationsRuntimeEvent =
  | {
      kind: 'turn.started';
      at: string;
      workspaceId: string;
      sessionId: string;
      missionId?: string;
      workItemId?: string;
      turnId: string;
      connectionSlug?: string;
      model?: string;
      thinkingLevel?: ThinkingLevel;
    }
  | {
      kind: 'turn.finished';
      at: string;
      workspaceId: string;
      sessionId: string;
      missionId?: string;
      workItemId?: string;
      turnId?: string;
      outcome: 'complete' | 'interrupted' | 'error' | 'timeout';
      finalText?: string;
      completionVerdict?: 'pass' | 'iterate' | 'blocked' | 'review-error';
      tokenUsage?: OperationsTokenUsage;
    }
  | {
      kind: 'tool.finished';
      at: string;
      workspaceId: string;
      sessionId: string;
      missionId?: string;
      workItemId?: string;
      toolCallId: string;
      toolName: string;
      isError: boolean;
      /** Already redacted by the host and bounded to a diagnostic tail. */
      diagnostic?: string;
    }
  | {
      kind: 'cost.recorded';
      at: string;
      workspaceId: string;
      sessionId: string;
      missionId?: string;
      workItemId?: string;
      turnId?: string;
      source: string;
      estimatedCostUsd?: number;
      actualCostUsd?: number;
      pricingCatalogVersion?: string;
    }
  | {
      kind: 'compaction.recorded';
      at: string;
      workspaceId: string;
      sessionId: string;
      missionId?: string;
      workItemId?: string;
      turnId?: string;
      inputTokens?: number;
    }
  | {
      kind: 'completion.reviewed';
      at: string;
      workspaceId: string;
      sessionId: string;
      missionId?: string;
      workItemId?: string;
      turnId?: string;
      reviewerModel: string;
      iteration: number;
      verdict: 'pass' | 'iterate' | 'blocked' | 'review-error';
      confidence?: number;
      missingCriteria?: string[];
    };

export interface RobbOperationsExtension {
  readonly apiVersion: typeof ROBB_OPERATIONS_API_VERSION;
  readonly id: string;
  readonly edition: 'commercial';
  /** Keep the user-selected subscription/account fixed across delegated work. */
  readonly connectionPolicy?: 'pinned-account';
  beforeTurn(input: OperationsTurnInput): Promise<OperationsTurnDecision> | OperationsTurnDecision;
  beforeTool(input: OperationsToolInput): OperationsToolDecision;
  onRuntimeEvent(event: OperationsRuntimeEvent): Promise<void> | void;
  /** Optional control-plane projection exposed by paid hosts. */
  getSnapshot?(workspaceId: string): unknown;
  /** Safe, user-visible commercial settings. Never include secrets. */
  getSettings?(): OperationsSettingsDto;
  /** Persist a validated settings replacement using host-authenticated identity. */
  updateSettings?(workspaceId: string, settings: OperationsSettingsDto, actorId: string): OperationsSettingsDto;
  /** Resolve one budget approval without exposing model-authored identity. */
  resolveApproval?(workspaceId: string, approvalId: string, approved: boolean, actorId: string): boolean;
  dispose?(): Promise<void> | void;
}

let activeExtension: RobbOperationsExtension | undefined;

export function registerRobbOperationsExtension(extension: RobbOperationsExtension): void {
  if (extension.apiVersion !== ROBB_OPERATIONS_API_VERSION) {
    throw new Error(`Unsupported Robb Operations API version: ${String(extension.apiVersion)}`);
  }
  if (!extension.id.trim() || extension.edition !== 'commercial') {
    throw new Error('Invalid Robb Operations extension identity');
  }
  if (activeExtension && activeExtension !== extension) {
    throw new Error(`Robb Operations extension already registered: ${activeExtension.id}`);
  }
  activeExtension = extension;
}

export function getRobbOperationsExtension(): RobbOperationsExtension | undefined {
  return activeExtension;
}

/** Test/process-shutdown helper. Production code should normally register once. */
export async function clearRobbOperationsExtension(): Promise<void> {
  const previous = activeExtension;
  activeExtension = undefined;
  await previous?.dispose?.();
}
