import { describe, expect, it, spyOn } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import { AbortReason, type BackendConfig } from '../backend/types.ts';
import { projectContextFileDiscovery } from '../../prompts/project-context-files.ts';

function harness() {
  const config: BackendConfig = {
    provider: 'pi', isHeadless: true,
    workspace: { id: 'ws-context-test', name: 'Test', rootPath: '/nonexistent/robb-context-test' } as never,
    session: { id: 'context-test', workingDirectory: '/nonexistent/robb-context-test' } as never,
  };
  const agent = new PiAgent(config);
  const runtime = agent as any;
  const sent: Array<{ type: string }> = [];
  runtime.ensureSubprocess = async () => {};
  runtime.emitAutomationEvent = () => {};
  runtime.resolveProjectContext = () => null;
  runtime.send = (message: { type: string }) => { sent.push(message); runtime.eventQueue.complete(); };
  return { agent, runtime, sent };
}

describe('Pi prompt preparation cancellation', () => {
  for (const stop of ['forceAbort', 'abort'] as const) {
    it(`does not dispatch a provider prompt after ${stop} during context discovery`, async () => {
      const h = harness();
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const discover = spyOn(projectContextFileDiscovery, 'discover').mockImplementation(async () => {
        entered();
        await gate;
        return { files: [], complete: false };
      });
      try {
        const generator = h.runtime.chatImpl('Inspect only.');
        const pending = generator.next();
        await started;
        if (stop === 'forceAbort') h.agent.forceAbort(AbortReason.UserStop);
        else await h.agent.abort();
        release();
        expect((await pending).done).toBe(true);
        expect(h.sent.some(message => message.type === 'prompt')).toBe(false);
        expect(h.agent.isProcessing()).toBe(false);
      } finally {
        release();
        discover.mockRestore();
        h.agent.destroy();
      }
    });
  }

  it('signals provider handoff only after the correlated child acknowledgement', async () => {
    const h = harness();
    let handoffs = 0;
    h.agent.onProviderHandoff = () => { handoffs += 1; };
    h.runtime.send = (message: { type: string; id?: string }) => {
      h.sent.push(message);
      if (message.type === 'prompt') {
        h.runtime.handleLine(JSON.stringify({ type: 'provider_handoff', id: message.id }));
        h.runtime.eventQueue.complete();
      }
    };

    const result = await h.runtime.chatImpl('Inspect only.').next();

    expect(result.done).toBe(true);
    expect(h.sent.map(message => message.type)).toContain('prompt');
    expect(handoffs).toBe(1);
    h.agent.destroy();
  });

  it('awaits the host write-ahead before writing the prompt to the child', async () => {
    const h = harness();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.agent.onBeforeProviderDispatch = async () => {
      order.push('write-ahead');
      await gate;
      order.push('write-ahead-durable');
    };
    h.runtime.send = (message: { type: string; id?: string }) => {
      order.push(`send:${message.type}`);
      h.sent.push(message);
      if (message.type === 'prompt') {
        h.runtime.handleLine(JSON.stringify({ type: 'provider_handoff', id: message.id }));
        h.runtime.eventQueue.complete();
      }
      return true;
    };

    const pending = h.runtime.chatImpl('Inspect only.').next();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order).toEqual(['write-ahead']);
    expect(h.sent.some(message => message.type === 'prompt')).toBe(false);
    release();
    await pending;
    expect(order).toEqual(['write-ahead', 'write-ahead-durable', 'send:prompt']);
    h.agent.destroy();
  });

  it('fences the host-to-child uncertainty window before the child handoff acknowledgement', async () => {
    const h = harness();
    let uncertainDispatches = 0;
    let handoffs = 0;
    let promptId: string | undefined;
    h.agent.onProviderDispatchUncertain = () => { uncertainDispatches += 1; };
    h.agent.onProviderHandoff = () => { handoffs += 1; };
    h.runtime.send = (message: { type: string; id?: string }) => {
      h.sent.push(message);
      if (message.type === 'prompt') promptId = message.id;
      return true;
    };

    const pending = h.runtime.chatImpl('Inspect only.').next();
    for (let index = 0; index < 20 && !promptId; index++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    expect(promptId).toBeDefined();
    expect(uncertainDispatches).toBe(1);
    expect(handoffs).toBe(0);
    h.runtime.handleLine(JSON.stringify({ type: 'provider_handoff', id: promptId }));
    h.runtime.eventQueue.complete();
    await pending;
    expect(handoffs).toBe(1);
    h.agent.destroy();
  });

  it('keeps a synchronous prompt-send failure pre-provider', async () => {
    const h = harness();
    let handoffs = 0;
    h.agent.onProviderHandoff = () => { handoffs += 1; };
    h.runtime.send = (message: { type: string }) => {
      if (message.type === 'prompt') throw new Error('ETIMEDOUT');
      h.sent.push(message);
    };

    const events = [];
    for await (const event of h.runtime.chatImpl('Inspect only.')) events.push(event);

    expect(events).toContainEqual({ type: 'error', message: 'ETIMEDOUT' });
    expect(handoffs).toBe(0);
    h.agent.destroy();
  });

  it('keeps a child setup or compaction failure pre-provider', async () => {
    const h = harness();
    let handoffs = 0;
    let correlatedRejections = 0;
    h.agent.onProviderHandoff = () => { handoffs += 1; };
    h.agent.onProviderDispatchRejected = () => { correlatedRejections += 1; };
    h.runtime.send = (message: { type: string; id?: string }) => {
      h.sent.push(message);
      if (message.type === 'prompt') {
        h.runtime.handleLine(JSON.stringify({
          type: 'error',
          id: message.id,
          code: 'prompt_error',
          message: 'Previous compaction did not settle before the prompt safety deadline',
        }));
        h.runtime.eventQueue.complete();
      }
    };

    const events = [];
    for await (const event of h.runtime.chatImpl('Inspect only.')) events.push(event);

    expect(events).toContainEqual({
      type: 'error',
      message: 'Pi subprocess error: Previous compaction did not settle before the prompt safety deadline',
    });
    expect(handoffs).toBe(0);
    expect(correlatedRejections).toBe(1);
    expect(h.runtime.pendingProviderHandoffs.size).toBe(0);
    h.agent.destroy();
  });

  it('does not treat an unmatched or generic post-write error as correlated rejection', async () => {
    const h = harness();
    let correlatedRejections = 0;
    h.agent.onProviderDispatchRejected = () => { correlatedRejections += 1; };
    h.runtime.send = (message: { type: string; id?: string }) => {
      h.sent.push(message);
      if (message.type === 'prompt') {
        h.runtime.handleLine(JSON.stringify({
          type: 'error', id: 'different-turn', code: 'prompt_error', message: 'stale rejection',
        }));
        h.runtime.handleLine(JSON.stringify({
          type: 'error', id: message.id, code: 'model_error', message: 'post-write failure',
        }));
        h.runtime.eventQueue.complete();
      }
      return true;
    };

    for await (const _event of h.runtime.chatImpl('Inspect only.')) { /* drain */ }
    expect(correlatedRejections).toBe(0);
    h.agent.destroy();
  });

  it('ignores mismatched and duplicate child handoff acknowledgements', async () => {
    const h = harness();
    let handoffs = 0;
    h.agent.onProviderHandoff = () => { handoffs += 1; };
    h.runtime.send = (message: { type: string; id?: string }) => {
      h.sent.push(message);
      if (message.type === 'prompt') {
        h.runtime.handleLine(JSON.stringify({ type: 'provider_handoff', id: 'wrong-turn' }));
        h.runtime.handleLine(JSON.stringify({ type: 'provider_handoff', id: message.id }));
        h.runtime.handleLine(JSON.stringify({ type: 'provider_handoff', id: message.id }));
        h.runtime.eventQueue.complete();
      }
    };

    await h.runtime.chatImpl('Inspect only.').next();

    expect(handoffs).toBe(1);
    h.agent.destroy();
  });

  it('keeps a prompt rejected by an unwritable subprocess pre-provider', async () => {
    const h = harness();
    let handoffs = 0;
    h.agent.onProviderHandoff = () => { handoffs += 1; };
    h.runtime.send = () => false;

    const events = [];
    for await (const event of h.runtime.chatImpl('Inspect only.')) events.push(event);

    expect(events).toContainEqual({ type: 'error', message: 'Pi subprocess stdin is not writable' });
    expect(handoffs).toBe(0);
    h.agent.destroy();
  });
});
