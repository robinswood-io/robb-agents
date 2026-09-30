import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { StoredMessage } from '@craft-agent/core/types'
import type { SessionHeader } from '../types.ts'
import { makeSessionPathPortable } from '../jsonl.ts'
import { sessionJsonlChunks, writeSessionJsonlTemp } from '../session-jsonl-writer.ts'

const header = { schemaVersion: 1, id: 'stream-test', messageCount: 2 } as SessionHeader
const message = (content: string): StoredMessage => ({ id: 'm1', type: 'assistant', content, timestamp: 1 })
const previousBytes = (h: SessionHeader, messages: StoredMessage[], dir: string) =>
  Buffer.from([h, ...messages].map(value => makeSessionPathPortable(JSON.stringify(value), dir)).join('\n') + '\n')

describe('bounded session JSONL serialization', () => {
  it('keeps exact portable JSONL bytes, UTF-8, newlines and message order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'robb-jsonl-writer-'))
    try {
      const messages = [message(`Dossier ${dir}/data/été.pdf\n漢字 😀 \\ \"`),
        { ...message('Question'), id: 'm2', isQueued: true, toolResult: '{"ok":true}' }]
      const before = structuredClone(messages)
      await writeSessionJsonlTemp(join(dir, 'session.jsonl.tmp'), header, messages, dir)
      expect(await readFile(join(dir, 'session.jsonl.tmp'))).toEqual(previousBytes(header, messages, dir))
      expect(messages).toEqual(before)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('never splits a Unicode surrogate pair across encoded chunks', () => {
    // Shift a supplementary code point through every position around a boundary.
    for (let offset = -3; offset <= 3; offset++) {
      const messages = [message('x'.repeat(64 * 1024 + offset) + '😀漢é'.repeat(80_000))]
      const chunks = [...sessionJsonlChunks(header, messages, '')]
      expect(chunks.length).toBeGreaterThan(2)
      expect(chunks.every(chunk => Buffer.byteLength(chunk) <= 192 * 1024)).toBe(true)
      expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))).toEqual(previousBytes(header, messages, ''))
    }
  })

  it('serializes lazily instead of materializing all messages before the first write', () => {
    let serialized = 0
    const messages = Array.from({ length: 100 }, () => ({
      ...message('x'.repeat(4096)), toJSON() { serialized++; return message('x'.repeat(4096)) },
    }))
    const chunks = sessionJsonlChunks(header, messages, '')
    chunks.next()
    expect(serialized).toBeGreaterThan(1)
    expect(serialized).toBeLessThan(20)
    const beforeClose = serialized
    chunks.return(undefined)
    expect(serialized).toBe(beforeClose)
  })

  it('batches small records instead of issuing one file write per message', () => {
    const messages = Array.from({ length: 2000 }, () => message('small'))
    const chunks = [...sessionJsonlChunks(header, messages, '')]
    expect(chunks.length).toBeLessThan(10)
    expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))).toEqual(previousBytes(header, messages, ''))
  })

  it('propagates serialization failure without touching the committed history and allows a later write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'robb-jsonl-writer-'))
    try {
      const target = join(dir, 'session.jsonl')
      const temporary = target + '.tmp'
      await writeFile(target, 'preserved history\n')
      const invalid = { ...message('bad'), toJSON() { throw new Error('serialization failed') } }
      await expect(writeSessionJsonlTemp(temporary, header, [message('ok'), invalid], dir)).rejects.toThrow('serialization failed')
      expect(await readFile(target, 'utf8')).toBe('preserved history\n')
      await writeSessionJsonlTemp(temporary, header, [message('recovered')], dir)
      expect(await readFile(temporary)).toEqual(previousBytes(header, [message('recovered')], dir))
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
