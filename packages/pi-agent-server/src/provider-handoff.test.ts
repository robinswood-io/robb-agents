import { describe, expect, it } from 'bun:test';
import {
  createCorrelatedProviderPromptStream,
  createProviderHandoffPreflight,
  writeProviderPromptWithHandoff,
} from './provider-handoff.ts';

describe('Pi provider handoff boundary', () => {
  it('acknowledges Pi only after a successful preflight and only once', () => {
    let acknowledgements = 0;
    const preflight = createProviderHandoffPreflight(() => { acknowledgements += 1; });

    preflight(false);
    expect(acknowledgements).toBe(0);
    preflight(true);
    preflight(true);

    expect(acknowledgements).toBe(1);
  });

  it('acknowledges a correlated ACP prompt only after its structured write succeeds', async () => {
    const writes: unknown[] = [];
    const acknowledgements: string[] = [];
    const source = new TransformStream<unknown, unknown>({
      transform(message, controller) {
        writes.push(message);
        controller.enqueue(message);
      },
    });
    // Drain the readable side so TransformStream backpressure cannot hold writes.
    void source.readable.pipeTo(new WritableStream({ write() {} }));
    const observed = createCorrelatedProviderPromptStream(
      { readable: new ReadableStream(), writable: source.writable },
      turnId => acknowledgements.push(turnId),
    );
    const writer = observed.stream.writable.getWriter();
    observed.reserve('turn-a');

    await writer.write({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: {} });

    expect(writes).toHaveLength(1);
    expect(acknowledgements).toEqual(['turn-a']);
    writer.releaseLock();
  });

  it('does not acknowledge an ACP prompt whose exact structured write rejects', async () => {
    const acknowledgements: string[] = [];
    const observed = createCorrelatedProviderPromptStream(
      {
        readable: new ReadableStream(),
        writable: new WritableStream({
          write() { throw new Error('synthetic ACP write failure'); },
        }),
      },
      turnId => acknowledgements.push(turnId),
    );
    const boundBeforeFailure = observed.reserve('turn-failed');
    const writer = observed.stream.writable.getWriter();

    await expect(writer.write({
      jsonrpc: '2.0', id: 2, method: 'session/prompt', params: {},
    })).rejects.toThrow('synthetic ACP write failure');
    expect(acknowledgements).toEqual([]);
    expect(boundBeforeFailure.cancel()).toBe(false);
    writer.releaseLock();
  });

  it('does not let duplicate or stale ACP request ids consume a later turn', async () => {
    const acknowledgements: string[] = [];
    const sink = new WritableStream<unknown>({ write() {} });
    const observed = createCorrelatedProviderPromptStream(
      { readable: new ReadableStream(), writable: sink },
      turnId => acknowledgements.push(turnId),
    );
    const writer = observed.stream.writable.getWriter();
    observed.reserve('turn-a');
    await writer.write({ jsonrpc: '2.0', id: 10, method: 'session/prompt', params: {} });
    observed.reserve('turn-b');
    await writer.write({ jsonrpc: '2.0', id: 10, method: 'session/prompt', params: {} });
    await writer.write({ jsonrpc: '2.0', id: 11, method: 'session/prompt', params: {} });

    expect(acknowledgements).toEqual(['turn-a', 'turn-b']);
    writer.releaseLock();
  });

  it('does not let a fresh-id stale ACP prompt consume a differently correlated turn', async () => {
    const acknowledgements: string[] = [];
    const observed = createCorrelatedProviderPromptStream(
      {
        readable: new ReadableStream(),
        writable: new WritableStream({ write() {} }),
      },
      turnId => acknowledgements.push(turnId),
    );
    const matchesCurrent = (request: Record<string, unknown>) => {
      const params = request.params as Record<string, unknown> | undefined;
      return params?.marker === 'current';
    };
    observed.reserve('current-turn', matchesCurrent);
    const writer = observed.stream.writable.getWriter();

    await writer.write({
      jsonrpc: '2.0', id: 20, method: 'session/prompt', params: { marker: 'stale' },
    });
    await writer.write({
      jsonrpc: '2.0', id: 21, method: 'session/prompt', params: { marker: 'current' },
    });

    expect(acknowledgements).toEqual(['current-turn']);
    writer.releaseLock();
  });

  it('removes unbound ACP reservations on per-turn rejection and runtime clear', async () => {
    const acknowledgements: string[] = [];
    const observed = createCorrelatedProviderPromptStream(
      {
        readable: new ReadableStream(),
        writable: new WritableStream({ write() {} }),
      },
      turnId => acknowledgements.push(turnId),
    );
    expect(observed.reserve('rejected-before-write').cancel()).toBe(true);
    observed.reserve('cleared-before-write');
    observed.cancelPending();
    observed.reserve('current-turn');
    const writer = observed.stream.writable.getWriter();

    await writer.write({ jsonrpc: '2.0', id: 12, method: 'session/prompt', params: {} });

    expect(acknowledgements).toEqual(['current-turn']);
    writer.releaseLock();
  });

  it('proves cancellation only while the exact ACP prompt is still unbound', async () => {
    const observed = createCorrelatedProviderPromptStream(
      {
        readable: new ReadableStream(),
        writable: new WritableStream({ write() {} }),
      },
      () => undefined,
    );
    const cancelledBeforeWrite = observed.reserve('pre-write');
    expect(cancelledBeforeWrite.cancel()).toBe(true);
    expect(cancelledBeforeWrite.cancel()).toBe(false);

    const bound = observed.reserve('bound');
    const writer = observed.stream.writable.getWriter();
    await writer.write({ jsonrpc: '2.0', id: 13, method: 'session/prompt', params: {} });

    expect(bound.cancel()).toBe(false);
    writer.releaseLock();
  });

  it('acknowledges a callback write once and rejects callback errors', async () => {
    let acknowledgements = 0;
    const accepted = await writeProviderPromptWithHandoff(
      done => { done(); done(); },
      () => { acknowledgements += 1; },
    );
    expect(accepted).toBe(true);
    expect(acknowledgements).toBe(1);

    await expect(writeProviderPromptWithHandoff(
      done => done(new Error('synthetic callback write failure')),
      () => { acknowledgements += 1; },
    )).rejects.toThrow('synthetic callback write failure');
    expect(acknowledgements).toBe(1);
  });

  it('does not acknowledge a successful callback from a stale runtime', async () => {
    let acknowledgements = 0;
    const accepted = await writeProviderPromptWithHandoff(
      done => done(),
      () => { acknowledgements += 1; },
      () => false,
    );

    expect(accepted).toBe(false);
    expect(acknowledgements).toBe(0);
  });
});
