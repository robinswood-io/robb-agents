import { type PermissionMode } from "@craft-agent/shared/agent";
import { type AgentBackend } from "@craft-agent/shared/agent/backend";
import { type SessionExecutionIsolation } from "@craft-agent/shared/tasks";
import { type MissionOrdinaryRouteLock } from "@craft-agent/shared/sessions";
import { type Session, type SendMessageOptions } from "@craft-agent/shared/protocol";
import { type TokenUsage } from "@craft-agent/core/types";
import { type ThinkingLevel } from "@craft-agent/shared/agent/thinking-levels";

/** Agent type - unified backend interface for all providers */
export type AgentInstance = AgentBackend

export interface CostControlledTurnContext {
  message: string
  messageId: string
  options?: SendMessageOptions
}

/**
 * Status of a background task in the main-process registry.
 * - `running`   — backgrounded and no terminal notification seen yet.
 * - `completed`/`failed`/`stopped` — a real SDK task_notification arrived.
 * - `orphaned`  — the turn that owned the task ended before a terminal
 *   notification arrived. With the (default) per-turn subprocess model the task
 *   almost certainly died with the subprocess, so reporting it as still
 *   "running" would be a lie. Once WS2 keep-alive is enabled these are no longer
 *   produced because the query outlives the turn.
 */
type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'orphaned'

/** A background task tracked from launch, for cross-subprocess status queries. */
export interface RunningBackgroundTask {
  taskId: string
  toolUseId?: string
  intent?: string
  /** ms timestamp when the task was backgrounded */
  startTime: number
  /** ms timestamp of the last task_progress notification, if any */
  lastProgressAt?: number
  /** elapsed seconds from the most recent progress notification, if any */
  elapsedSeconds?: number
  status: BackgroundTaskStatus
  /** ms timestamp when the task reached a terminal/orphaned status */
  completedAt?: number
  /** turn that launched the task (used to orphan on that turn's completion) */
  turnId?: string
  /** Workflow run id (wf_...) — set when this task is a Workflow launch. */
  workflowId?: string
  /** Count of workflow sub-agents completed so far (Workflow tasks only). */
  agentsCompleted?: number
}

export interface RuntimeGenerationTelemetryRef {
  generationId: string
  turnId: string
  /** Captured before routing metadata is cleared by the completed message. */

}

export interface RuntimeCompactionTelemetry {
  startedAt: number
  inputTokens?: number
  turnId?: string
  generationId?: string
}

/**
 * In-process session-completion signal for the Tasks Conductor.
 *
 * Emitted once per turn from `onProcessingStopped` when the session's message
 * queue is empty (i.e. true completion, not a hand-off between queued turns),
 * carrying the stop `reason`. This is an internal, side-effect-free seam — it is
 * NOT a renderer event and NOT exposed to agents. The Conductor maps the reason
 * onto a node run-state: complete→done, error/timeout→failed, interrupted→cancelled.
 */
export interface SessionCompletionEvent {
  sessionId: string
  workspaceId: string
  reason: 'complete' | 'interrupted' | 'error' | 'timeout'
  /** The final (non-intermediate) assistant message id for this turn, if any. */
  finalMessageId?: string
  /** Convenience copy of the final assistant message text (same as getSessionFinalText). */
  finalText?: string
  /** The session's cumulative token usage, so the Conductor can meter token_budget without re-fetching. */
  tokenUsage?: TokenUsage
  /** Host-collected, signed proof for a reconciled external mutation, never model-authored text. */
  executionProof?: import('@craft-agent/shared/governance').SignedExecutionProof
}

export interface MissionPendingTurnRecoveryClaim {
  missionId: string
  missionWorkItemId: string
  missionDispatchId: string
  boundary: {
    permissionMode?: PermissionMode
    enabledSourceSlugs: string[]
    executionIsolation?: SessionExecutionIsolation
    ordinaryRouteLock?: MissionOrdinaryRouteLock
    specializedRouteLockSha256?: string
    llmConnection?: string
    model?: string
    thinkingLevel?: ThinkingLevel
    workingDirectory?: string
    missionRole?: Session['missionRole']
    connectionRoutePinned?: boolean
    modelRoutePinned?: boolean
    thinkingLevelPinned?: boolean
  }
}

export type MissionPendingTurnRecoveryClaimDecision =
  | { allowed: true }
  | { allowed: false; reason: string }

export interface MissionPendingTurnRecoveryClaimRecord {
  token: symbol
  claim: MissionPendingTurnRecoveryClaim
  operation?: Promise<void>
}
