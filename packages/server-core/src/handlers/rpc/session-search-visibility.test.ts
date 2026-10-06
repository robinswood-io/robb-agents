import { describe, expect, it } from 'bun:test'
import { getSearchableSessionIds } from './sessions'

describe('session content search visibility', () => {
  it('allows only user-facing roots before applying the search result budget', () => {
    const ids = getSearchableSessionIds([
      { id: 'root' },
      { id: 'archived-root' },
      { id: 'hidden', hidden: true },
      { id: 'child', parentSessionId: 'root' },
      { id: 'hidden-child', hidden: true, parentSessionId: 'root' },
      { id: 'delegated-before-lineage', delegation: { rootSessionId: 'root' } },
      { id: 'conductor-before-lineage', taskNodeId: 'audit' },
      { id: 'mission-worker-before-lineage', missionWorkItemId: 'work-1', missionRole: 'worker' },
    ])

    expect([...ids]).toEqual(['root', 'archived-root'])
  })
})
