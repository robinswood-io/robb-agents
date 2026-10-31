import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiCredential } from "../token-update.ts";
import type { LLMQueryRequest, LLMQueryResult } from "../../../shared/src/agent/llm-tool.ts";

// ============================================================
// Types — JSONL Protocol
// ============================================================

/** Custom endpoint protocol — determines which streaming adapter Pi SDK uses */
// Shared wrappers preserve native schemas and treat custom details and rendering state as opaque.
export type RuntimeToolDefinition = ToolDefinition<ToolDefinition['parameters'], unknown, unknown>;

export type CustomEndpointApi = 'openai-completions' | 'anthropic-messages';

/** Init message from main process — configures the Pi agent server */
interface InitMessage {
  type: 'init';
  apiKey: string;
  model: string;
  modelRoutePinned?: boolean;
  cwd: string;
  thinkingLevel: string;
  workspaceRootPath: string;
  sessionId: string;
  sessionPath: string;
  workingDirectory: string;
  plansFolderPath: string;
  miniModel?: string;
  agentDir?: string;
  providerType?: string;
  authType?: string;
  workspaceId?: string;
  baseUrl?: string;
  branchFromSdkSessionId?: string;
  branchFromSessionPath?: string;
  branchFromSdkTurnId?: string;
  customEndpoint?: { api: CustomEndpointApi; supportsImages?: boolean };
  customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean; supportsThinking?: boolean; maxTokens?: number }>;
  piAuth?: { provider: string; credential: PiCredential };
}

export interface RuntimeConfigUpdateMessage {
  type: 'update_runtime_config';
  id: string;
  model: string;
  providerType?: string;
  authType?: string;
  baseUrl?: string;
  customEndpoint?: { api: CustomEndpointApi; supportsImages?: boolean };
  customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean; supportsThinking?: boolean; maxTokens?: number }>;
}

/** Read the workspace-owned kill switch at the last responsible moment. The
 * subprocess can outlive a settings toggle, so the init snapshot is not an
 * authoritative live value. Missing/malformed configuration fails closed. */


/** Automatic workspace routing is only model-authoritative while the session
 * has no manual model pin. The prompt/init protocol refreshes that host-owned
 * pin for direct subprocess call_llm callbacks. */


/** Messages from main process (stdin) */
export type InboundMessage =
  | InitMessage
  | { type: 'prompt'; id: string; message: string; systemPrompt: string; images?: Array<{ type: 'image'; data: string; mimeType: string }>; modelRoutePinned?: boolean }
  | { type: 'register_tools'; tools: ProxyToolDef[] }
  | { type: 'tool_execute_response'; requestId: string; result: { content: string; isError: boolean; structuredContent?: Record<string, unknown> } }
  | { type: 'pre_tool_use_response'; requestId: string; action: 'allow' | 'block' | 'modify'; input?: Record<string, unknown>; reason?: string }
  | { type: 'abort' }
  | { type: 'mini_completion'; id: string; prompt: string; allowModelSubstitution?: boolean }
  | { type: 'llm_query'; id: string; request: LLMQueryRequest; allowModelSubstitution?: boolean }
  | { type: 'ensure_session_ready'; id: string }
  | { type: 'set_model'; model: string }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'compact'; id: string; customInstructions?: string }
  | { type: 'abort_compaction'; id: string }
  | { type: 'set_auto_compaction'; id: string; enabled: boolean }
  | RuntimeConfigUpdateMessage
  | { type: 'steer'; message: string }
  | { type: 'token_update'; piAuth: { provider: string; credential: PiCredential } }
  | { type: 'shutdown' };

/** Proxy tool definition from main process */
export interface ProxyToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  readOnly?: boolean;
  idempotent?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
  parallelSafe?: boolean;
}

/** Canonical tool metadata propagated on Pi tool start events */
export interface ToolExecutionMetadata {
  intent?: string;
  displayName?: string;
  source: 'interceptor';
}

type EnrichedToolExecutionStartEvent = Extract<AgentSessionEvent, { type: 'tool_execution_start' }> & {
  toolMetadata?: ToolExecutionMetadata;
};

export type OutboundAgentEvent = AgentSessionEvent | EnrichedToolExecutionStartEvent
  | (Extract<AgentSessionEvent, { type: 'message_end' }> & { sdkMessageId: string })
  | { type: 'pi_turn_anchor'; sdkTurnAnchor: string; sdkMessageId: string };

/** Messages to main process (stdout) */
interface OutboundReady { type: 'ready'; sessionId: string | null; callbackPort: number }

interface OutboundEvent { type: 'event'; event: OutboundAgentEvent }

interface OutboundPreToolUseReq {
  type: 'pre_tool_use_request';
  requestId: string;
  toolName: string;
  toolCallId?: string;
  input: Record<string, unknown>;
}

interface OutboundToolExecReq {
  type: 'tool_execute_request';
  requestId: string;
  toolName: string;
  toolCallId?: string;
  args: Record<string, unknown>;
}

interface OutboundSessionToolCompleted { type: 'session_tool_completed'; toolName: string; args: Record<string, unknown>; isError: boolean }

interface OutboundMiniResult { type: 'mini_completion_result'; id: string; text: string | null }

interface OutboundLlmQueryResult {
  type: 'llm_query_result';
  id: string;
  result: LLMQueryResult | null;
  errorMessage?: string;
  /**
   * When set, signals the main process that a generic `error` with the same code
   * was also emitted on the error channel (for centralized auth-refresh detection).
   */
  errorCode?: string;
}

interface OutboundEnsureSessionReadyResult { type: 'ensure_session_ready_result'; id: string; sessionId: string | null }

interface OutboundCompactResult {
  type: 'compact_result';
  id: string;
  success: boolean;
  result?: { summary: string; firstKeptEntryId: string; tokensBefore: number; estimatedTokensAfter?: number; compactionModel?: string };
  errorMessage?: string;
}

interface OutboundSetAutoCompactionResult {
  type: 'set_auto_compaction_result';
  id: string;
  success: boolean;
  enabled: boolean;
  errorMessage?: string;
}

interface OutboundRuntimeConfigUpdateResult {
  type: 'update_runtime_config_result';
  id: string;
  success: boolean;
  updated: boolean;
  errorMessage?: string;
}

interface OutboundSessionIdUpdate { type: 'session_id_update'; sessionId: string }

interface OutboundProviderHandoff { type: 'provider_handoff'; id: string }

interface OutboundError { type: 'error'; id?: string; message: string; code?: string }

export type OutboundMessage =
  | OutboundReady
  | OutboundEvent
  | OutboundPreToolUseReq
  | OutboundToolExecReq
  | OutboundSessionToolCompleted
  | OutboundMiniResult
  | OutboundLlmQueryResult
  | OutboundEnsureSessionReadyResult
  | OutboundCompactResult
  | OutboundSetAutoCompactionResult
  | OutboundRuntimeConfigUpdateResult
  | OutboundSessionIdUpdate
  | OutboundProviderHandoff
  | OutboundError;
