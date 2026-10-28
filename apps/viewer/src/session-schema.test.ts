import { describe, expect, it } from 'bun:test'
import type { StoredSession } from '@craft-agent/core'
import { parseViewerSession } from './session-schema'

const fixture: StoredSession = {
  id: 'viewer-qa', workspaceId: 'qa', createdAt: 1, lastUsedAt: 2,
  messages: [{ id: 'm1', type: 'assistant', content: 'Report ready', timestamp: 2,
    toolDisplayMeta: { displayName: 'Read', category: 'native' },
    routingMeta: { model: 'qa-model', buildCommit: 'qa-commit', actualCostUsd: 0.01 },
    objectiveOutcome: { state: 'complete_verified', criteria: [{ id: 'report', satisfied: true, evidence: ['m1'] }], remainingWork: [], blocker: null },
    attachments: [{ id: 'a1', type: 'pdf', name: 'report.pdf', mimeType: 'application/pdf', size: 42, storedPath: '/qa/report.pdf' }],
  }],
  tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, contextTokens: 10, costUsd: 0.01 },
}

describe('viewer session input boundary', () => {
  it('preserves message evidence, attachments, routing metadata and future extensions', () => {
    const value = { ...fixture, futureSessionField: { version: 2 },
      messages: fixture.messages.map(message => ({ ...message, futureMessageField: ['retained'] })),
    }
    expect(parseViewerSession(JSON.parse(JSON.stringify(value)))).toEqual(value)
  })

  it('accepts legacy workspaceRootPath exports without inventing an authenticated workspace', () => {
    const legacy = { ...fixture, workspaceRootPath: '/qa/legacy' }
    const { workspaceId, ...withoutWorkspaceId } = legacy
    expect(workspaceId).toBe('qa')
    expect(parseViewerSession(withoutWorkspaceId)).toEqual({ ...withoutWorkspaceId, workspaceId: '' })
  })

  it.each(['user', 'assistant', 'tool', 'error', 'status', 'info', 'warning', 'plan', 'auth-request'])('keeps supported message role %s', role => {
    expect(parseViewerSession({ ...fixture, messages: [{ id: 'm', type: role, content: 'Retained' }] }).messages[0]?.type).toBe(role)
  })

  const invalidValues: unknown[] = [
    null, [], { id: 'partial', messages: [] },
    { ...fixture, tokenUsage: { ...fixture.tokenUsage, costUsd: 'unverified' } },
    ...[
      { toolInput: [] }, { toolResult: 42 }, { attachments: ['invalid'] },
      { routingMeta: { actualCostUsd: 'invalid' } },
      { objectiveOutcome: { state: 'complete_verified', criteria: [], remainingWork: 'unfinished' } },
      { annotations: [{ id: 'a', schemaVersion: 1, createdAt: 1, body: 'invalid', target: {} }] },
      { providerDispatch: { state: 'accepted' } }, { authLabels: { password: 42 } },
    ].map(fields => ({ ...fixture, messages: [{ id: 'm', type: 'assistant', content: 'Invalid nested metadata', ...fields }] })),
  ]
  for (const [index, value] of invalidValues.entries()) {
    it(`rejects malformed session or nested rendering data ${index}`, () => {
      expect(() => parseViewerSession(value)).toThrow()
    })
  }
})
