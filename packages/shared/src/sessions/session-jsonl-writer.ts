import { writeFile } from 'node:fs/promises'
import type { StoredMessage } from '@craft-agent/core/types'
import type { SessionHeader } from './types.ts'
import { makeSessionPathPortable } from './jsonl.ts'

// At most 192 KiB of UTF-8 per chunk. A surrogate pair must stay together:
// encoding either half separately would replace it and corrupt the transcript.
const CHUNK_CODE_UNITS = 64 * 1024

/** Serialize one record at a time, without retaining a second complete history. */
export function* sessionJsonlChunks(
  header: SessionHeader,
  messages: readonly StoredMessage[],
  sessionDir: string,
): Generator<string> {
  let pending = ''
  for (let index = -1; index < messages.length; index++) {
    const line = makeSessionPathPortable(JSON.stringify(index < 0 ? header : messages[index]), sessionDir) + '\n'
    for (let start = 0; start < line.length;) {
      let end = Math.min(start + CHUNK_CODE_UNITS - pending.length, line.length)
      const last = line.charCodeAt(end - 1)
      if (end < line.length && last >= 0xd800 && last <= 0xdbff) end--
      // A remaining single code unit cannot hold the next surrogate pair.
      if (end <= start) {
        yield pending
        pending = ''
        continue
      }
      pending += line.slice(start, end)
      start = end
      if (pending.length === CHUNK_CODE_UNITS) {
        yield pending
        pending = ''
      }
    }
  }
  if (pending) yield pending
}

/**
 * Only write the temporary file; its caller owns the atomic rename. Node's
 * iterable writeFile applies backpressure and closes its handle on success or
 * failure. The largest JSON record still needs serialization, but the complete
 * transcript no longer exists as an array of strings, a joined string and an
 * encoded buffer at the same time. Bytes and the on-disk format are unchanged.
 */
export async function writeSessionJsonlTemp(
  tmpFile: string,
  header: SessionHeader,
  messages: readonly StoredMessage[],
  sessionDir: string,
): Promise<void> {
  await writeFile(tmpFile, sessionJsonlChunks(header, messages, sessionDir), 'utf8')
}
