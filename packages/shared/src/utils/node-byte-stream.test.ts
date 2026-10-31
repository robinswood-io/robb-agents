import { describe, expect, it } from 'bun:test';
import { Readable } from 'node:stream';
import { nodeByteStream } from './node-byte-stream.ts';

describe('Node binary to Web stream conversion', () => {
  it('delivers every byte through the standard Response reader', async () => {
    const source = Readable.from([Buffer.from([0, 255]), Buffer.from([42, 7])]);
    const result = await new Response(nodeByteStream(source)).arrayBuffer();
    expect([...new Uint8Array(result)]).toEqual([0, 255, 42, 7]);
  });

  it('propagates source failures to the reader', async () => {
    const source = new Readable({ read() { this.destroy(new Error('QA read failed')); } });
    await expect(nodeByteStream(source).getReader().read()).rejects.toThrow('QA read failed');
  });

  it('rejects non-binary chunks and closes their source', async () => {
    const source = Readable.from(['text']);
    await expect(nodeByteStream(source).getReader().read()).rejects.toThrow('binary Node stream');
    expect(source.destroyed).toBe(true);
  });

  it('cancellation closes a source while a read is pending', async () => {
    const source = new Readable({ read() {} });
    const reader = nodeByteStream(source).getReader();
    const pending = reader.read();
    await reader.cancel();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(source.destroyed).toBe(true);
  });
});
