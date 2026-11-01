export interface InitMessage {
  type: 'init';
  cwd: string;
  workingDirectory?: string;
  sdkSessionId?: string;
  model?: string;
  thinkingLevel?: string;
}


export type InboundMessage =
  | InitMessage
  | { type: 'prompt'; id: string; message: string; systemPrompt?: string }
  | { type: 'abort' }
  | { type: 'set_model'; model: string }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'ensure_session_ready'; id: string }
  | { type: 'set_auto_compaction'; id: string; enabled: boolean }
  | { type: 'compact'; id: string; customInstructions?: string }
  | { type: 'update_runtime_config'; id: string }
  | { type: 'register_tools'; tools: unknown[] }
  | { type: 'pre_tool_use_response'; requestId: string; action: 'allow' | 'block' | 'modify' }
  | { type: 'mini_completion'; id: string }
  | { type: 'llm_query'; id: string }
  | { type: 'steer'; message: string }
  | { type: 'token_update' }
  | { type: 'shutdown' };


export interface AntigravityUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}


export interface ActiveTurn {
  text: string;
  sdkMessageId?: string;
  toolStarts: Set<string>;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}


export const SETUP_GUIDANCE = 'Install the official Antigravity CLI, run `agy`, and sign in with your Google account.';


export class AntigravityPromptRejectedBeforeWriteError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'AntigravityPromptRejectedBeforeWriteError';
  }
}


export function emptyUsage(): Required<AntigravityUsage> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  };
}


export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}


export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}


export function numericValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}


export function normalizeUsage(value: unknown): Required<AntigravityUsage> {
  const usage = asRecord(value);
  return {
    input_tokens: numericValue(usage?.["input_tokens"]),
    output_tokens: numericValue(usage?.["output_tokens"]),
    thinking_tokens: numericValue(usage?.["thinking_tokens"]),
    cache_read_tokens: numericValue(usage?.["cache_read_tokens"]),
    total_tokens: numericValue(usage?.["total_tokens"]),
  };
}


export function toolOutput(toolInfo: Record<string, unknown> | undefined): unknown {
  return toolInfo?.["output"] ?? toolInfo?.["result"] ?? '';
}


export function classifyResultError(result: Record<string, unknown>): { code: string; message: string } {
  const detail = String(result["error"] ?? '').toLowerCase();
  if (detail.includes('authentication required') || detail.includes('sign in')) {
    return {
      code: 'GOOGLE_ANTIGRAVITY_AUTH_REQUIRED',
      message: `Google Antigravity is not signed in. ${SETUP_GUIDANCE}`,
    };
  }
  if (detail.includes('quota') || detail.includes('license') || detail.includes('subscription')) {
    return {
      code: 'GOOGLE_ANTIGRAVITY_ENTITLEMENT_REQUIRED',
      message: 'This Google account does not currently have usable Antigravity quota. Check the account plan or personal AI subscription in Antigravity.',
    };
  }
  if (detail.includes('capacity') || detail.includes('high traffic') || detail.includes('unavailable') || detail.includes('503')) {
    return {
      code: 'GOOGLE_ANTIGRAVITY_CAPACITY_LIMIT',
      message: 'Google Antigravity servers are experiencing high traffic for this model. Please try again in a moment or switch models.',
    };
  }
  return {
    code: 'GOOGLE_ANTIGRAVITY_PROMPT_FAILED',
    message: 'Google Antigravity could not complete this turn. Check the Antigravity CLI status, then try again.',
  };
}


export function mapEffort(level: string | undefined): string | undefined {
  if (!level || level === 'off') return undefined;
  if (level === 'minimal' || level === 'low') return 'low';
  if (level === 'medium') return 'medium';
  return 'high';
}
