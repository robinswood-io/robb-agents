import { describe, expect, it, mock } from 'bun:test';
import { executeSourceProxyCall } from '../claude-agent.ts';

describe('Claude source proxy Gmail host lifecycle', () => {
  it('blocks a bound Gmail host call that has no exact runtime reservation', async () => {
    const callTool = mock(async () => ({ content: 'unexpected', isError: false }));

    const result = await executeSourceProxyCall(
      { callTool } as never,
      'mcp__google-contacts__gmail_reply_bound',
      { recipientBinding: 'untrusted', body: 'Bonjour', isHtml: false },
      { sessionId: 'claude-proxy-no-reservation', runtimeId: 'claude-runtime-1' },
    );

    expect(result.isError).toBeTrue();
    expect(result.content).toContain('no exact admitted reservation');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('leaves unrelated source tools on the ordinary proxy path', async () => {
    const callTool = mock(async () => ({
      content: '{"ok":true}',
      isError: false,
      structuredContent: { ok: true },
    }));

    const result = await executeSourceProxyCall(
      { callTool } as never,
      'mcp__google-contacts__gmail_get_message',
      { messageId: '1a0a917ea946a540' },
      { sessionId: 'claude-proxy-read', runtimeId: 'claude-runtime-2' },
    );

    expect(result).toEqual({
      content: '{"ok":true}',
      isError: false,
      structuredContent: { ok: true },
    });
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
