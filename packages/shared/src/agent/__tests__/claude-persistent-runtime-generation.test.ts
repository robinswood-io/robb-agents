import { describe, expect, it, mock } from 'bun:test';
import { ClaudeAgent } from '../claude-agent.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

async function flushConsumers(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('Claude persistent runtime generations', () => {
  it('uses globally unique Gmail runtime ids across agent instances', () => {
    const firstAgent = Object.create(ClaudeAgent.prototype) as any;
    const secondAgent = Object.create(ClaudeAgent.prototype) as any;

    const firstRuntimeId = firstAgent.createGmailRuntimeId('same-session');
    const secondRuntimeId = secondAgent.createGmailRuntimeId('same-session');

    expect(firstRuntimeId).not.toBe(secondRuntimeId);
    expect(firstRuntimeId).toMatch(
      /^same-session:claude:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(secondRuntimeId).toMatch(
      /^same-session:claude:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it('drops a retired consumer result instead of pushing to or closing its replacement channel', async () => {
    const agent = Object.create(ClaudeAgent.prototype) as any;
    const oldNext = deferred<IteratorResult<Record<string, unknown>>>();
    const oldReturn = deferred<IteratorResult<Record<string, unknown>>>();
    let oldNextCalls = 0;
    const oldIterator = {
      next: mock(() => {
        oldNextCalls += 1;
        return oldNextCalls === 1
          ? oldNext.promise
          : Promise.resolve({ done: true, value: undefined });
      }),
      return: mock(() => oldReturn.promise),
    };
    const oldChannel = {
      push: mock((_value: unknown) => {}),
      end: mock(() => {}),
    };

    agent.debug = mock((_message: string) => {});
    agent.config = { session: { id: 'same-session' } };
    agent.pendingPermissions = new Map();
    agent.persistentQueryGeneration = 1;
    agent.persistentConsumerGeneration = null;
    agent.persistentInput = { end: mock(() => {}) };
    agent.persistentIterator = oldIterator;
    agent.persistentAbortController = { abort: mock(() => {}) };
    agent.persistentGmailRuntimeId = 'old-runtime';
    agent.persistentGmailSessionId = 'same-session';
    agent.activeTurnChannel = oldChannel;

    agent.startPersistentConsumer();
    expect(oldIterator.next).toHaveBeenCalledTimes(1);

    // Retire the old generation while next() and iterator.return() are both
    // unresolved, exactly as an SDK process can behave during force-abort.
    agent.teardownPersistentQuery('test-replacement');
    expect(oldIterator.return).toHaveBeenCalledTimes(1);

    const newFirst = deferred<IteratorResult<Record<string, unknown>>>();
    const newDone = deferred<IteratorResult<Record<string, unknown>>>();
    let newNextCalls = 0;
    const newIterator = {
      next: mock(() => {
        newNextCalls += 1;
        return newNextCalls === 1 ? newFirst.promise : newDone.promise;
      }),
      return: mock(async () => ({ done: true, value: undefined })),
    };
    const newChannel = {
      push: mock((_value: unknown) => {}),
      end: mock(() => {}),
    };

    agent.persistentQueryGeneration += 1;
    agent.persistentIterator = newIterator;
    agent.persistentGmailRuntimeId = 'new-runtime';
    agent.persistentGmailSessionId = 'same-session';
    agent.activeTurnChannel = newChannel;
    agent.startPersistentConsumer();

    // The replacement consumer is allowed to start before the old SDK iterator
    // finishes, but only under its own correlated generation.
    expect(newIterator.next).toHaveBeenCalledTimes(1);
    newFirst.resolve({ done: false, value: { type: 'assistant', generation: 'new' } });
    await flushConsumers();
    expect(newChannel.push).toHaveBeenCalledTimes(1);
    expect(newChannel.end).not.toHaveBeenCalled();

    // A buffered result from the retired iterator must not end the replacement.
    oldNext.resolve({ done: false, value: { type: 'result', generation: 'old' } });
    await flushConsumers();
    expect(newChannel.push).toHaveBeenCalledTimes(1);
    expect(newChannel.end).not.toHaveBeenCalled();

    newDone.resolve({ done: true, value: undefined });
    oldReturn.resolve({ done: true, value: undefined });
    await flushConsumers();
  });

  it('confirms the exact runtime when a completed consumer has no iterator return method', async () => {
    const agent = Object.create(ClaudeAgent.prototype) as any;
    const runtime = { sessionId: 'same-session', runtimeId: 'runtime-without-return' };
    const confirmRuntimeTeardown = mock((_runtime: typeof runtime) => true);
    const abort = mock(() => {});

    agent.debug = mock((_message: string) => {});
    agent.config = { session: { id: runtime.sessionId } };
    agent.pendingPermissions = new Map();
    agent.persistentQueryGeneration = 1;
    agent.persistentConsumerGeneration = null;
    agent.persistentInput = { end: mock(() => {}) };
    agent.persistentIterator = {
      next: mock(async () => ({ done: true, value: undefined })),
    };
    agent.persistentAbortController = { abort };
    agent.persistentGmailRuntimeId = runtime.runtimeId;
    agent.persistentGmailSessionId = runtime.sessionId;
    agent.activeTurnChannel = { push: mock(() => {}), end: mock(() => {}) };
    agent.confirmContextualGmailRuntimeTeardown = confirmRuntimeTeardown;

    agent.startPersistentConsumer();
    await flushConsumers();

    expect(confirmRuntimeTeardown).toHaveBeenCalledTimes(1);
    expect(confirmRuntimeTeardown).toHaveBeenCalledWith(runtime);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(agent.persistentIterator).toBeNull();
  });

  it('confirms the exact runtime when iterator return throws after consumer completion', async () => {
    const agent = Object.create(ClaudeAgent.prototype) as any;
    const runtime = { sessionId: 'same-session', runtimeId: 'runtime-return-throws' };
    const confirmRuntimeTeardown = mock((_runtime: typeof runtime) => true);
    const abort = mock(() => {});
    const close = mock(() => {
      throw new Error('iterator close failed');
    });

    agent.debug = mock((_message: string) => {});
    agent.config = { session: { id: runtime.sessionId } };
    agent.pendingPermissions = new Map();
    agent.persistentQueryGeneration = 1;
    agent.persistentConsumerGeneration = null;
    agent.persistentInput = { end: mock(() => {}) };
    agent.persistentIterator = {
      next: mock(async () => ({ done: true, value: undefined })),
      return: close,
    };
    agent.persistentAbortController = { abort };
    agent.persistentGmailRuntimeId = runtime.runtimeId;
    agent.persistentGmailSessionId = runtime.sessionId;
    agent.activeTurnChannel = { push: mock(() => {}), end: mock(() => {}) };
    agent.confirmContextualGmailRuntimeTeardown = confirmRuntimeTeardown;

    agent.startPersistentConsumer();
    await flushConsumers();

    expect(close).toHaveBeenCalledTimes(1);
    expect(confirmRuntimeTeardown).toHaveBeenCalledTimes(1);
    expect(confirmRuntimeTeardown).toHaveBeenCalledWith(runtime);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(agent.persistentIterator).toBeNull();
  });
});
