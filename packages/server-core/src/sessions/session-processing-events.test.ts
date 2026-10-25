import { describe, expect, it } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager'

describe('authoritative processing state publication', () => {
  it('publishes both transitions so a resumed agent exposes Stop before any new message', () => {
    const events: Array<{ event: Parameters<SessionManager['sendEvent']>[0]; workspaceId?: string }> = []
    const managed = createManagedSession({ id: 'session' }, {
      id: 'workspace', slug: 'workspace', name: 'Fixture', rootPath: '/tmp/processing-events', createdAt: 1,
    })
    const runtime = new SessionManager()
    runtime['sendEvent'] = (event, workspaceId) => { events.push({ event, workspaceId }) }
    runtime['setProcessing'](managed, true)
    runtime['setProcessing'](managed, true)
    runtime['setProcessing'](managed, false)
    expect(events).toEqual([
      { event: { type: 'session_metadata_changed', sessionId: 'session', changes: { isProcessing: true } }, workspaceId: 'workspace' },
      { event: { type: 'session_metadata_changed', sessionId: 'session', changes: { isProcessing: false } }, workspaceId: 'workspace' },
    ])
    expect(managed.isProcessing).toBe(false)
  })
})
