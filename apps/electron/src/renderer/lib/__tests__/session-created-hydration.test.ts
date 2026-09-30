import { describe, expect, it } from 'bun:test'
import type { Session } from '../../../shared/types'
import { hydrateCreatedSession } from '../session-created-hydration'

function session(id: string): Session {
  return {
    id,
    workspaceId: 'workspace',
    workspaceName: 'Workspace',
    lastMessageAt: 1,
    messages: [],
    isProcessing: false,
  }
}

describe('hydrateCreatedSession', () => {
  it('deduplicates concurrent notifications and upserts the authoritative session once', async () => {
    const inFlight = new Map<string, Promise<void>>()
    let resolve!: (value: Session) => void
    let fetchCount = 0
    const upserts: Session[] = []
    const deps = {
      fetchSession: () => {
        fetchCount++
        return new Promise<Session>(done => { resolve = done })
      },
      upsertSession: (value: Session) => { upserts.push(value) },
      refreshSessionMetadata: async () => { throw new Error('unexpected fallback') },
    }

    const first = hydrateCreatedSession(inFlight, 'child', deps)
    const duplicate = hydrateCreatedSession(inFlight, 'child', deps)
    expect(duplicate).toBe(first)
    expect(fetchCount).toBe(1)

    resolve(session('child'))
    await Promise.all([first, duplicate])
    expect(upserts.map(value => value.id)).toEqual(['child'])
    expect(inFlight.has('child')).toBe(false)
  })

  it.each(['rejected', 'missing'] as const)('falls back to metadata hydration when the session fetch is %s', async (outcome) => {
    const phases: string[] = []
    const refreshed: string[] = []
    await hydrateCreatedSession(new Map(), 'child', {
      fetchSession: async () => {
        if (outcome === 'rejected') throw new Error('transient transport failure')
        return null
      },
      upsertSession: () => { throw new Error('unexpected upsert') },
      refreshSessionMetadata: async id => { refreshed.push(id) },
      onError: (_error, phase) => { phases.push(phase) },
    })

    expect(refreshed).toEqual(['child'])
    expect(phases).toEqual(outcome === 'rejected' ? ['session'] : [])
  })
})
