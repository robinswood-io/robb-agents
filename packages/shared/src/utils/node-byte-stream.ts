import type { Readable } from 'node:stream';

/** Convert a binary Node stream using the Web Stream API shared by Node and Bun. */
export function nodeByteStream(source: Readable): ReadableStream<Uint8Array> {
  const iterator: AsyncIterator<unknown> = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await iterator.next();
        if (chunk.done) controller.close();
        else if (chunk.value instanceof Uint8Array) controller.enqueue(chunk.value);
        else throw new TypeError('Expected a binary Node stream chunk');
      } catch (error) {
        source.destroy();
        controller.error(error);
      }
    },
    async cancel() {
      source.destroy();
      await iterator.return?.();
    },
  });
}
