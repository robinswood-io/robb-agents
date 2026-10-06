import { describe, expect, it } from 'bun:test'
import { canSteerTextPayload } from './mid-stream-delivery.ts'

describe('mid-stream delivery contract', () => {
  it('steers plain text and an optimistic UI id only', () => {
    expect(canSteerTextPayload()).toBe(true)
    expect(canSteerTextPayload(undefined, undefined, { optimisticMessageId: 'ui-1' })).toBe(true)
  })

  it('queues attachments and model-input options so no payload is dropped', () => {
    const file = { type: 'text' as const, path: '/tmp/note.txt', name: 'note.txt', mimeType: 'text/plain', size: 4 }
    expect(canSteerTextPayload([file])).toBe(false)
    expect(canSteerTextPayload(undefined, [{ id: 'att-1', type: 'text', storedPath: file.path, name: file.name, mimeType: file.mimeType, size: file.size }])).toBe(false)
    expect(canSteerTextPayload(undefined, undefined, { skillSlugs: ['review'] })).toBe(false)
    expect(canSteerTextPayload(undefined, undefined, { hidden: true })).toBe(false)
    expect(canSteerTextPayload(undefined, undefined, { expectedSessionAnchor: { messageCount: 1, lastFinalMessageId: null, lastMessageAt: 1 } })).toBe(false)
  })
})
