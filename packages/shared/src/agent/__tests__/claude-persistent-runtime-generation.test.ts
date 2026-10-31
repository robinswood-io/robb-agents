import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createPushableInputStream } from '../backend/claude/persistent-input.ts';
import { describe, expect, it, mock, spyOn } from 'bun:test';
import { ClaudeAgent } from '../claude-agent.ts';

function observedStream<T>() {
  const stream = createPushableInputStream<T>();
  spyOn(stream, 'push');
  spyOn(stream, 'end');
  return stream;
}
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
    const firstAgent = Object.create(ClaudeAgent.prototype) as ClaudeAgent;
    const secondAgent = Object.create(ClaudeAgent.prototype) as ClaudeAgent;

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
    const agent = Object.create(ClaudeAgent.prototype) as ClaudeAgent;
    const oldNext = deferred<IteratorResult<Record<string, unknown>, void>>();
    const oldReturn = deferred<IteratorResult<Record<string, unknown>, void>>();
    let oldNextCalls = 0;
    const oldIterator = {
      next: mock(() => {
        oldNextCalls += 1;
        return oldNextCalls === 1
          ? oldNext.promise
          : Promise.resolve({ done: true as const, value: undefined });
      }),
      return: mock(() => oldReturn.promise),
    };
    const oldChannel = observedStream<SDKMessage>();

    agent["debug"] = mock((_message: string) => {});
    agent["config"] = ({ session: { id: 'same-session' } } satisfies { session: Pick<NonNullable<ClaudeAgent['config']['session']>, 'id'> }) as ClaudeAgent["config"];
    agent.pendingPermissions = (new Map() satisfies Map<string, Pick<NonNullable<ReturnType<ClaudeAgent['pendingPermissions']['get']>>, 'resolve'>>) as ClaudeAgent["pendingPermissions"];
    agent["persistentQueryGeneration"] = 1;
    agent["persistentConsumerGeneration"] = null;
    agent["persistentInput"] = observedStream<SDKUserMessage>();
    agent["persistentIterator"] = (oldIterator satisfies AsyncIterator<Record<string, unknown>, void>) as ClaudeAgent["persistentIterator"];
    agent["persistentAbortController"] = new AbortController();
    agent["persistentGmailRuntimeId"] = 'old-runtime';
    agent["persistentGmailSessionId"] = 'same-session';
    agent["activeTurnChannel"] = oldChannel;

    agent["startPersistentConsumer"]();
    expect(oldIterator.next).toHaveBeenCalledTimes(1);

    // Retire the old generation while next() and iterator.return() are both
    // unresolved, exactly as an SDK process can behave during force-abort.
    agent["teardownPersistentQuery"]('test-replacement');
    expect(oldIterator.return).toHaveBeenCalledTimes(1);

    const newFirst = deferred<IteratorResult<Record<string, unknown>, void>>();
    const newDone = deferred<IteratorResult<Record<string, unknown>, void>>();
    let newNextCalls = 0;
    const newIterator = {
      next: mock(() => {
        newNextCalls += 1;
        return newNextCalls === 1 ? newFirst.promise : newDone.promise;
      }),
      return: mock(async () => ({ done: true as const, value: undefined })),
    };
    const newChannel = observedStream<SDKMessage>();

    agent["persistentQueryGeneration"] += 1;
    agent["persistentIterator"] = (newIterator satisfies AsyncIterator<Record<string, unknown>, void>) as ClaudeAgent["persistentIterator"];
    agent["persistentGmailRuntimeId"] = 'new-runtime';
    agent["persistentGmailSessionId"] = 'same-session';
    agent["activeTurnChannel"] = newChannel;
    agent["startPersistentConsumer"]();

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

    newDone.resolve({ done: true as const, value: undefined });
    oldReturn.resolve({ done: true as const, value: undefined });
    await flushConsumers();
  });

  it('confirms the exact runtime when a completed consumer has no iterator return method', async () => {
    const agent = Object.create(ClaudeAgent.prototype) as ClaudeAgent;
    const runtime = { sessionId: 'same-session', runtimeId: 'runtime-without-return' };
    const confirmRuntimeTeardown = mock((_runtime: typeof runtime) => true);
    const abortController = new AbortController();
    const abort = spyOn(abortController, 'abort');

    agent["debug"] = mock((_message: string) => {});
    agent["config"] = ({ session: { id: runtime["sessionId"] } } satisfies { session: Pick<NonNullable<ClaudeAgent['config']['session']>, 'id'> }) as ClaudeAgent["config"];
    agent.pendingPermissions = (new Map() satisfies Map<string, Pick<NonNullable<ReturnType<ClaudeAgent['pendingPermissions']['get']>>, 'resolve'>>) as ClaudeAgent["pendingPermissions"];
    agent["persistentQueryGeneration"] = 1;
    agent["persistentConsumerGeneration"] = null;
    agent["persistentInput"] = observedStream<SDKUserMessage>();
    agent["persistentIterator"] = ({
      next: mock(async () => ({ done: true as const, value: undefined })),
    } satisfies AsyncIterator<Record<string, unknown>, void>) as ClaudeAgent["persistentIterator"];
    agent["persistentAbortController"] = abortController;
    agent["persistentGmailRuntimeId"] = runtime.runtimeId;
    agent["persistentGmailSessionId"] = runtime["sessionId"];
    agent["activeTurnChannel"] = observedStream<SDKMessage>();
    agent["confirmContextualGmailRuntimeTeardown"] = confirmRuntimeTeardown;

    agent["startPersistentConsumer"]();
    await flushConsumers();

    expect(confirmRuntimeTeardown).toHaveBeenCalledTimes(1);
    expect(confirmRuntimeTeardown).toHaveBeenCalledWith(runtime);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(agent["persistentIterator"]).toBeNull();
  });

  it('confirms the exact runtime when iterator return throws after consumer completion', async () => {
    const agent = Object.create(ClaudeAgent.prototype) as ClaudeAgent;
    const runtime = { sessionId: 'same-session', runtimeId: 'runtime-return-throws' };
    const confirmRuntimeTeardown = mock((_runtime: typeof runtime) => true);
    const abortController = new AbortController();
    const abort = spyOn(abortController, 'abort');
    const close = mock(() => {
      throw new Error('iterator close failed');
    });

    agent["debug"] = mock((_message: string) => {});
    agent["config"] = ({ session: { id: runtime["sessionId"] } } satisfies { session: Pick<NonNullable<ClaudeAgent['config']['session']>, 'id'> }) as ClaudeAgent["config"];
    agent.pendingPermissions = (new Map() satisfies Map<string, Pick<NonNullable<ReturnType<ClaudeAgent['pendingPermissions']['get']>>, 'resolve'>>) as ClaudeAgent["pendingPermissions"];
    agent["persistentQueryGeneration"] = 1;
    agent["persistentConsumerGeneration"] = null;
    agent["persistentInput"] = observedStream<SDKUserMessage>();
    agent["persistentIterator"] = ({
      next: mock(async () => ({ done: true as const, value: undefined })),
      return: close,
    } satisfies AsyncIterator<Record<string, unknown>, void>) as ClaudeAgent["persistentIterator"];
    agent["persistentAbortController"] = abortController;
    agent["persistentGmailRuntimeId"] = runtime.runtimeId;
    agent["persistentGmailSessionId"] = runtime["sessionId"];
    agent["activeTurnChannel"] = observedStream<SDKMessage>();
    agent["confirmContextualGmailRuntimeTeardown"] = confirmRuntimeTeardown;

    agent["startPersistentConsumer"]();
    await flushConsumers();

    expect(close).toHaveBeenCalledTimes(1);
    expect(confirmRuntimeTeardown).toHaveBeenCalledTimes(1);
    expect(confirmRuntimeTeardown).toHaveBeenCalledWith(runtime);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(agent["persistentIterator"]).toBeNull();
  });
});
