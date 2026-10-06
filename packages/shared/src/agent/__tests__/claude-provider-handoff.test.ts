import { describe, expect, it } from 'bun:test';
import { ClaudeAgent } from '../claude-agent.ts';

function persistentTurnHarness(push: (prompt: unknown, onConsumed?: () => void) => void) {
  const runtime = Object.create(ClaudeAgent.prototype) as any;
  runtime.persistentInput = { push };
  runtime.currentQuery = {};
  runtime.persistentAbortController = null;
  runtime.currentQueryAbortController = null;
  runtime.activeTurnChannel = null;
  return runtime;
}

describe('Claude provider handoff boundary', () => {
  it('awaits the durable write-ahead before invoking a provider dispatch', async () => {
    const runtime = Object.create(ClaudeAgent.prototype) as any;
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    runtime.onBeforeProviderDispatch = async () => {
      order.push('write-ahead');
      await gate;
      order.push('write-ahead-durable');
    };

    const pending = runtime.performProviderDispatchWriteAhead(() => {
      order.push('provider-write');
      return 'written';
    });
    await Promise.resolve();
    expect(order).toEqual(['write-ahead']);
    release();
    expect(await pending).toBe('written');
    expect(order).toEqual(['write-ahead', 'write-ahead-durable', 'provider-write']);
  });

  it('signals a persistent turn only after the SDK consumes the pushed prompt', () => {
    const order: string[] = [];
    let acknowledgeConsumed: (() => void) | undefined;
    const runtime = persistentTurnHarness((_prompt, onConsumed) => {
      order.push('push');
      acknowledgeConsumed = onConsumed;
    });
    runtime.onProviderHandoff = () => { order.push('handoff'); };

    const stream = runtime.beginPersistentTurn(
      { type: 'user', message: { role: 'user', content: 'Continue.' } },
      {},
      { sessionId: 'session-handoff', runtimeId: 'runtime-handoff' },
    );

    expect(stream).toBeDefined();
    expect(order).toEqual(['push']);
    acknowledgeConsumed?.();
    expect(order).toEqual(['push', 'handoff']);
    runtime.activeTurnChannel.end();
  });

  it('keeps a failed persistent prompt push pre-provider', () => {
    const runtime = persistentTurnHarness(() => { throw new Error('ETIMEDOUT'); });
    let handoffs = 0;
    runtime.onProviderHandoff = () => { handoffs += 1; };

    expect(() => runtime.beginPersistentTurn(
      { type: 'user', message: { role: 'user', content: 'Continue.' } },
      {},
      { sessionId: 'session-handoff', runtimeId: 'runtime-handoff' },
    )).toThrow('ETIMEDOUT');
    expect(handoffs).toBe(0);
    runtime.activeTurnChannel.end();
  });

  it('correlates a synchronous persistent push rejection after the WAL', async () => {
    const runtime = persistentTurnHarness(() => { throw new Error('ETIMEDOUT'); });
    runtime.keepBackgroundTasksAlive = true;
    runtime.buildSDKUserMessage = () => ({
      type: 'user', message: { role: 'user', content: 'Continue.' },
    });
    let rejected = 0;
    runtime.onBeforeProviderDispatch = async () => {};
    runtime.onProviderDispatchRejected = () => { rejected += 1; };

    await expect(runtime.performProviderDispatchWriteAhead(
      () => runtime.createProviderTurnMessageSource(
        'Continue.', undefined, {},
        { sessionId: 'session-handoff', runtimeId: 'runtime-handoff' },
      ),
    )).rejects.toThrow('ETIMEDOUT');
    expect(rejected).toBe(1);
    expect(runtime.activeTurnChannel).toBeDefined();
    runtime.activeTurnChannel.end();
  });

  it('does not signal a one-shot attachment prompt when the first transport write rejects', async () => {
    const runtime = Object.create(ClaudeAgent.prototype) as any;
    let handoffs = 0;
    runtime.onProviderHandoff = () => { handoffs += 1; };
    const prompt = runtime.createOneShotProviderInput({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
        }],
      },
      parent_tool_use_id: null,
      session_id: '',
    });

    const consumeLikeSdk = async () => {
      for await (const _message of prompt) {
        await Promise.reject(new Error('transport.write rejected'));
      }
    };

    await expect(consumeLikeSdk()).rejects.toThrow('transport.write rejected');
    expect(handoffs).toBe(0);
  });

  it('signals a one-shot text prompt after its first transport write resolves', async () => {
    const order: string[] = [];
    const runtime = Object.create(ClaudeAgent.prototype) as any;
    runtime.onProviderHandoff = () => { order.push('handoff'); };
    const prompt = runtime.createOneShotProviderInput({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
      parent_tool_use_id: null,
      session_id: '',
    });

    for await (const _message of prompt) {
      order.push('transport.write');
      await Promise.resolve();
    }

    expect(order).toEqual(['transport.write', 'handoff']);
  });
});
