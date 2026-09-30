import { describe, expect, it } from 'bun:test'
import { stopConversation } from './stop-conversation'

describe('stopping a conversation with hidden workers', () => {
  it('stops the parent before its active descendants, exactly once each', async () => {
    const calls: string[] = []
    await stopConversation('parent', ['child', 'grandchild', 'child', 'parent'], false,
      async id => { calls.push(id) })
    expect(calls).toEqual(['parent', 'child', 'grandchild'])
  })
  it('preserves workers when silently redirecting the parent', async () => {
    const calls: [string, boolean][] = []
    await stopConversation('parent', ['child'], true, async (id, silent) => { calls.push([id, silent]) })
    expect(calls).toEqual([['parent', true]])
  })
  it('attempts every worker even if cancellation of the parent or a sibling fails', async () => {
    const calls: string[] = []
    await expect(stopConversation('parent', ['child', 'grandchild'], false, async id => {
      calls.push(id)
      if (id !== 'grandchild') throw new Error('unavailable')
    })).rejects.toBeInstanceOf(AggregateError)
    expect(calls).toEqual(['parent', 'child', 'grandchild'])
  })
})
