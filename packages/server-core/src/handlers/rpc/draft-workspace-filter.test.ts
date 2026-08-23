import { describe, expect, it } from 'bun:test'
import { filterDraftsForWorkspace } from './draft-workspace-filter'

describe('Remote draft workspace filtering', () => {
  it('returns only drafts belonging to the active request workspace', async () => {
    const workspaceBySession: Record<string, string | undefined> = {
      'session-a': 'workspace-a',
      'session-b': 'workspace-b',
    }
    const result = await filterDraftsForWorkspace(
      {
        'session-a': { text: 'A private draft' },
        'session-b': { text: 'B private draft' },
        missing: { text: 'orphan draft' },
      },
      'workspace-a',
      async (sessionId) => workspaceBySession[sessionId] ?? null,
    )

    expect(result).toEqual({ 'session-a': { text: 'A private draft' } })
  })
})
