import { describe, expect, it } from 'bun:test'
import { SessionManager } from './SessionManager'

describe('authoritative processing state publication', () => {
  it('publishes both transitions so a resumed agent exposes Stop before any new message', () => {
    const events: Array<{ event: any; workspaceId: string }> = []
    const managed = { id: 'session', isProcessing: false, workspace: { id: 'workspace' } }
    const runtime = { sendEvent: (event: any, workspaceId: string) => events.push({ event, workspaceId }) }
    const setProcessing = (SessionManager.prototype as any).setProcessing
    setProcessing.call(runtime, managed, true)
    setProcessing.call(runtime, managed, true)
    setProcessing.call(runtime, managed, false)
    expect(events).toEqual([
      { event: { type: 'session_metadata_changed', sessionId: 'session', changes: { isProcessing: true } }, workspaceId: 'workspace' },
      { event: { type: 'session_metadata_changed', sessionId: 'session', changes: { isProcessing: false } }, workspaceId: 'workspace' },
    ])
    expect(managed.isProcessing).toBe(false)
  })
})
