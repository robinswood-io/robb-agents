import type { PermissionRequestType, ToolDisplayMeta, ToolExecutionCheckpoint, TypedError } from './message-types.ts';

/**
 * Usage data emitted by CraftAgent in 'complete' events
 * Note: This is a subset of TokenUsage. totalTokens is computed by consumers;
 * contextTokens is optional because older backends only report inputTokens.
 */
export interface AgentEventUsage {
  /** Billed input across the completed turn (may aggregate several model calls). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  /** Model-visible input on the latest call; unlike inputTokens this is never cumulative. */
  contextTokens?: number;
  /** Model's context window size in tokens (from SDK modelUsage) */
  contextWindow?: number;
}

/**
 * Native model identity attached to a completed assistant message.
 *
 * All fields are optional so older backends and stored events remain valid.
 * `model` is the effective provider-reported model, while `requestedModel`
 * preserves the model sent to the provider before aliases/dynamic routing.
 */
export interface AgentModelProvenance {
  model?: string;
  requestedModel?: string;
  provider?: string;
  api?: string;
  contextWindow?: number;
}

/**
 * Events emitted by CraftAgent during chat
 * turnId: Correlation ID from the API's message.id, groups all events in an assistant turn
 */
/** Fixed transient activity labels; never populated with model reasoning text. */
export const AGENT_RUNTIME_ACTIVITY = {
  preparingContext: 'Préparation du contexte',
  composingResponse: 'Le modèle élabore la réponse',
} as const;

export function isAgentRuntimeActivity(value: unknown): boolean {
  return value === AGENT_RUNTIME_ACTIVITY.preparingContext || value === AGENT_RUNTIME_ACTIVITY.composingResponse;
}

export type AgentEvent =
  | { type: 'status'; message: string }
  | { type: 'info'; message: string }
  | { type: 'text_delta'; text: string; turnId?: string; parentToolUseId?: string }
  | { type: 'text_discard'; turnId: string }
  | { type: 'text_complete'; text: string; isIntermediate?: boolean; turnId?: string; parentToolUseId?: string; sdkMessageId?: string; modelProvenance?: AgentModelProvenance }
  | { type: 'pi_turn_anchor'; sdkMessageId: string; sdkTurnAnchor: string }
  | { type: 'tool_start'; toolName: string; toolUseId: string; input: Record<string, unknown>; intent?: string; displayName?: string; turnId?: string; parentToolUseId?: string; toolDisplayMeta?: ToolDisplayMeta }
  | { type: 'tool_result'; toolUseId: string; toolName?: string; result: string; isError: boolean; input?: Record<string, unknown>; turnId?: string; parentToolUseId?: string; continuationRequired?: boolean; executed?: boolean; checkpoint?: ToolExecutionCheckpoint }
  | {
      type: 'permission_request';
      requestId: string;
      toolName: string;
      command?: string;
      description: string;
      permissionType?: PermissionRequestType;
      appName?: string;
      reason?: string;
      impact?: string;
      requiresSystemPrompt?: boolean;
      rememberForMinutes?: number;
      commandHash?: string;
      approvalTtlSeconds?: number;
    }
  | { type: 'error'; message: string }
  | {
      /**
       * The provider runtime disappeared before the turn reached a terminal
       * response. SessionManager treats this as a resumable interruption, not
       * as a user-visible provider error, and applies its durable bounded
       * recovery policy before surfacing a terminal failure.
       */
      type: 'runtime_interrupted';
      message: string;
      code: 'process_exit' | 'process_error' | 'startup_timeout';
      exitCode?: number | null;
      signal?: string | null;
    }
  | { type: 'typed_error'; error: TypedError }
  | { type: 'complete'; usage?: AgentEventUsage }
  | { type: 'working_directory_changed'; workingDirectory: string }
  | { type: 'task_backgrounded'; toolUseId: string; taskId: string; intent?: string; turnId?: string; kind?: 'workflow'; workflowId?: string }
  | { type: 'shell_backgrounded'; toolUseId: string; shellId: string; intent?: string; command?: string; turnId?: string }
  | { type: 'task_progress'; toolUseId: string; elapsedSeconds: number; turnId?: string }
  | { type: 'task_completed'; taskId: string; status: 'completed' | 'failed' | 'stopped'; outputFile?: string; summary?: string; turnId?: string }
  | { type: 'workflow_agent_completed'; workflowId: string; agentId: string; turnId?: string }
  | { type: 'shell_killed'; shellId: string; turnId?: string }
  | { type: 'source_activated'; sourceSlug: string; originalMessage: string }
  | { type: 'usage_update'; usage: Pick<AgentEventUsage, 'inputTokens' | 'contextWindow'> }
  | { type: 'steer_undelivered'; message: string };
