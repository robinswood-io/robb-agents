import type { AgentEvent } from '@craft-agent/core/types';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import type { PiEventAdapter } from '../../backend/pi/event-adapter.ts';

type RecordedMessage = Partial<Omit<AssistantMessage, 'content'>> & {
  role: 'assistant';
  content?: (AssistantMessage['content'][number] | { type: 'tool_use'; id: string })[] | string;
  id?: string;
} | { role: 'user' | 'toolResult'; content?: unknown };
type RecordedAssistantUpdate = { type: 'text_delta'; delta: string }
  | { type: 'usage_delta'; delta: null };
type RecordedToolMetadata = { intent?: string; displayName?: string; source?: string };

/** The historical adapter fixtures intentionally omit SDK fields it never reads.
 * Keep that wire boundary explicit and checked here, including legacy string
 * content and bridge turn anchors, rather than disabling type checking per test. */
export type RecordedPiEvent =
  | { type: 'agent_start' | 'turn_start' | 'turn_end' | 'message_start' }
  | { type: 'agent_end'; willRetry?: boolean }
  | { type: 'agent_settled'; aborted: boolean }
  | { type: 'message_update'; assistantMessageEvent: RecordedAssistantUpdate }
  | { type: 'message_end'; message: RecordedMessage; sdkMessageId?: string }
  | { type: 'pi_turn_anchor'; sdkMessageId?: string; sdkTurnAnchor?: string }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string;
      args: Record<string, unknown>; toolMetadata?: RecordedToolMetadata }
  | { type: 'tool_execution_end'; toolCallId: string; toolName?: string;
      result: unknown; isError: boolean }
  | { type: 'tool_execution_update'; toolCallId: string; partialResult: unknown }
  | { type: 'compaction_start' }
  | { type: 'compaction_end'; result: object | null | undefined; aborted: boolean;
      errorMessage?: string; reason?: 'manual' | 'threshold' | 'overflow'; willRetry?: boolean }
  | { type: 'auto_retry_start'; attempt: number; maxAttempts: number;
      delayMs?: number; errorMessage?: string }
  | { type: 'auto_retry_end'; success: boolean; finalError?: string; attempt?: number }
  | { type: 'queue_update'; steering: string[]; followUp: string[] };

/** Exercise legacy wire inputs against the real adapter without claiming they are current SDK events. */
export function adaptRecordedPiEvent(adapter: PiEventAdapter, event: RecordedPiEvent): ReturnType<PiEventAdapter['adaptEvent']> {
  return Reflect.apply(adapter.adaptEvent, adapter, [event]) as ReturnType<PiEventAdapter['adaptEvent']>;
}

export function collect(events: Generator<AgentEvent, void, unknown>): AgentEvent[] {
  return [...events];
}

export function makeUsage(input: number, output: number, cacheRead: number,
  cacheWrite: number, costTotal: number): Usage {
  return { input, output, cacheRead, cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal } };
}

export function eventOfType<T extends AgentEvent['type']>(
  event: AgentEvent | undefined, type: T,
): Extract<AgentEvent, { type: T }> {
  if (!event || event.type !== type) throw new Error('Expected event ' + type);
  return event as Extract<AgentEvent, { type: T }>;
}

export function eventErrorText(event: AgentEvent): string {
  if (event.type === 'error') return event.message;
  if (event.type === 'typed_error') return event.error.message ?? event.error.originalError ?? '';
  return '';
}
