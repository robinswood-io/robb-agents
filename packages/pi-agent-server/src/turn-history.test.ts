import { describe, expect, it } from 'bun:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { findSdkTurnAnchor } from './turn-history.ts';

function assistant(timestamp: number, responseId?: string): AssistantMessage {
  return {
    role: 'assistant', api: 'openai-responses', provider: 'openai', model: 'offline-model',
    timestamp, responseId, content: [{ type: 'text', text: 'Verified result' }], stopReason: 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

describe('SDK turn anchors', () => {
  it('finds the persisted assistant behind tool receipts instead of using the leaf', () => {
    const journal = SessionManager.inMemory();
    journal.appendMessage({ role: 'user', content: 'Finish the task', timestamp: 1 });
    const message = assistant(2, 'provider-response');
    const anchor = journal.appendMessage(message);
    const receipt = journal.appendMessage({ role: 'toolResult', toolCallId: 'already-run',
      toolName: 'read', content: [{ type: 'text', text: 'existing evidence' }],
      isError: false, timestamp: 3 });
    expect(journal.getLeafId()).toBe(receipt);
    expect(findSdkTurnAnchor(journal, message)).toBe(anchor);
  });

  it('rejects a stale event even when an earlier matching assistant exists', () => {
    const journal = SessionManager.inMemory();
    const earlier = assistant(2, 'earlier');
    journal.appendMessage(earlier);
    journal.appendMessage(assistant(3, 'latest'));
    expect(findSdkTurnAnchor(journal, earlier)).toBeUndefined();
    expect(findSdkTurnAnchor(journal, assistant(3, 'other-response'))).toBeUndefined();
  });

  it('supports providers without response IDs and an empty journal', () => {
    const journal = SessionManager.inMemory();
    const message = assistant(1);
    expect(findSdkTurnAnchor(journal, message)).toBeUndefined();
    const anchor = journal.appendMessage(message);
    expect(findSdkTurnAnchor(journal, message)).toBe(anchor);
  });
});
