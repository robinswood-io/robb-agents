import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, getSessionPath } from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager'

const roots: string[] = []
const managers: SessionManager[] = []
const originalFetch = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = originalFetch
  await Promise.all(managers.splice(0).map(manager => manager.cleanup()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('session deletion external-operation fences', () => {
  it('cancels refresh-title publication after deletion detaches the exact session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-delete-refresh-title-fence-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Original title' })
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-refresh-title-fence', name: 'Titles', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    managed.messages = [{
      id: 'user-title-source',
      role: 'user',
      content: 'Please generate a durable title',
      timestamp: Date.now(),
    }]

    let releaseTitle!: () => void
    const titleGate = new Promise<void>(resolve => { releaseTitle = resolve })
    let notifyTitleStarted!: () => void
    const titleStarted = new Promise<void>(resolve => { notifyTitleStarted = resolve })
    managed.agent = {
      regenerateTitle: async () => {
        notifyTitleStarted()
        await titleGate
        return 'Late regenerated title'
      },
      isProcessing: () => false,
      forceAbort: () => {},
      dispose: () => {},
    } as never

    const events: Array<{ type: string }> = []
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      sendEvent: (event: { type: string }) => void
    }
    runtime.sessions.set(managed.id, managed)
    runtime.sendEvent = event => { events.push(event) }

    const refresh = manager.refreshTitle(managed.id)
    await titleStarted
    let deletionSettled = false
    const deletion = manager.deleteSession(managed.id).finally(() => { deletionSettled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(runtime.sessions.has(managed.id)).toBe(false)
    expect(deletionSettled).toBe(false)
    const eventsAtDetach = events.length

    releaseTitle()
    await expect(refresh).resolves.toEqual({ success: false, error: 'Session is being deleted' })
    await deletion

    expect(managed.name).toBe('Original title')
    expect(events.some(event => event.type === 'title_generated')).toBe(false)
    expect(events.slice(eventsAtDetach).map(event => event.type)).toEqual(['session_deleted'])
    expect(existsSync(getSessionPath(root, managed.id))).toBe(false)
  })

  it('tracks automatic title generation so deletion drains it without late persistence or events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-delete-auto-title-fence-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Immediate fallback title' })
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-auto-title-fence', name: 'Titles', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )

    let releaseTitle!: () => void
    const titleGate = new Promise<void>(resolve => { releaseTitle = resolve })
    let notifyTitleStarted!: () => void
    const titleStarted = new Promise<void>(resolve => { notifyTitleStarted = resolve })
    managed.agent = {
      generateTitle: async () => {
        notifyTitleStarted()
        await titleGate
        return 'Late automatic title'
      },
      isProcessing: () => false,
      forceAbort: () => {},
      dispose: () => {},
    } as never

    const events: Array<{ type: string }> = []
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      sendEvent: (event: { type: string }) => void
      scheduleTitleGeneration: (session: typeof managed, message: string) => void
    }
    runtime.sessions.set(managed.id, managed)
    runtime.sendEvent = event => { events.push(event) }

    runtime.scheduleTitleGeneration(managed, 'Please improve this title')
    await titleStarted
    let deletionSettled = false
    const deletion = manager.deleteSession(managed.id).finally(() => { deletionSettled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(runtime.sessions.has(managed.id)).toBe(false)
    expect(deletionSettled).toBe(false)
    const eventsAtDetach = events.length

    releaseTitle()
    await deletion

    expect(managed.name).toBe('Immediate fallback title')
    expect(events.some(event => event.type === 'title_generated')).toBe(false)
    expect(events.slice(eventsAtDetach).map(event => event.type)).toEqual(['session_deleted'])
    expect(existsSync(getSessionPath(root, managed.id))).toBe(false)
  })

  it('drains a model-route refresh and suppresses its detached-session event before deletion commits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-delete-model-route-fence-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Route race', model: 'model-before' })
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-model-route-fence', name: 'Routes', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    managed.agent = {
      isProcessing: () => false,
      forceAbort: () => {},
      dispose: () => {},
    } as never

    let releaseRefresh!: () => void
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve })
    let notifyRefreshStarted!: () => void
    const refreshStarted = new Promise<void>(resolve => { notifyRefreshStarted = resolve })
    const events: Array<{ type: string }> = []
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      sendEvent: (event: { type: string }) => void
      tryRefreshAgentRuntime: (session: typeof managed, reason: string) => Promise<void>
    }
    runtime.sessions.set(managed.id, managed)
    runtime.sendEvent = event => { events.push(event) }
    runtime.tryRefreshAgentRuntime = async () => {
      notifyRefreshStarted()
      await refreshGate
    }

    const routeUpdate = manager.updateSessionModel(managed.id, managed.workspace.id, 'model-after')
    await refreshStarted
    let deletionSettled = false
    const deletion = manager.deleteSession(managed.id).finally(() => { deletionSettled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(runtime.sessions.has(managed.id)).toBe(false)
    expect(deletionSettled).toBe(false)
    const eventsAtDetach = events.length

    releaseRefresh()
    await expect(routeUpdate).rejects.toThrow(`Session ${managed.id} is being deleted`)
    await deletion

    expect(events.some(event => event.type === 'session_model_changed')).toBe(false)
    expect(events.slice(eventsAtDetach).map(event => event.type)).toEqual(['session_deleted'])
    expect(existsSync(getSessionPath(root, managed.id))).toBe(false)
  })

  it('drains recipient attachment validation and rejects it before a deleted session can be recreated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-delete-delivery-fence-'))
    roots.push(root)
    const senderStored = await createSession(root, { name: 'Sender' })
    const targetStored = await createSession(root, { name: 'Target' })
    const attachmentPath = join(root, 'delivery-proof.txt')
    writeFileSync(attachmentPath, 'proof')

    const manager = new SessionManager()
    managers.push(manager)
    const workspace = { id: 'workspace-delivery-fence', name: 'Delivery', rootPath: root, createdAt: 1 } as never
    const sender = createManagedSession(senderStored, workspace, { messagesLoaded: true })
    const target = createManagedSession(targetStored, workspace, { messagesLoaded: true })
    const runtime = manager as unknown as {
      sessions: Map<string, typeof target>
      sendAgentMessageToSession: (
        source: typeof sender,
        recipient: typeof target,
        message: string,
        attachments: Array<{ path: string; name?: string }>,
        messageType: 'progress',
        validateAttachmentPath: (path: string, allowed?: string[]) => Promise<string>,
      ) => Promise<unknown>
    }
    runtime.sessions.set(sender.id, sender)
    runtime.sessions.set(target.id, target)

    let releaseValidation!: () => void
    const validationGate = new Promise<void>(resolve => { releaseValidation = resolve })
    let notifyValidationStarted!: () => void
    const validationStarted = new Promise<void>(resolve => { notifyValidationStarted = resolve })
    const delivery = runtime.sendAgentMessageToSession(
      sender,
      target,
      'deliver proof',
      [{ path: attachmentPath }],
      'progress',
      async path => {
        notifyValidationStarted()
        await validationGate
        return path
      },
    )
    await validationStarted

    let deletionSettled = false
    const deletion = manager.deleteSession(target.id).finally(() => { deletionSettled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(runtime.sessions.has(target.id)).toBe(false)
    expect(deletionSettled).toBe(false)
    expect(existsSync(getSessionPath(root, target.id))).toBe(true)

    releaseValidation()
    await expect(delivery).rejects.toThrow(`Target session ${target.id} is being deleted`)
    await deletion

    expect(existsSync(getSessionPath(root, target.id))).toBe(false)
  })

  it('waits for an in-flight share and revokes a share created at the deletion boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-delete-share-fence-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Share race' })
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-share-fence', name: 'Share', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const runtime = manager as unknown as { sessions: Map<string, typeof managed> }
    runtime.sessions.set(managed.id, managed)

    let releaseUpload!: () => void
    const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve })
    let notifyUploadStarted!: () => void
    const uploadStarted = new Promise<void>(resolve => { notifyUploadStarted = resolve })
    const requests: Array<{ url: string; method: string }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      requests.push({ url: String(input), method })
      if (method === 'POST') {
        notifyUploadStarted()
        await uploadGate
        return new Response(JSON.stringify({ id: 'share-at-delete', url: 'https://viewer.invalid/share-at-delete' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (method === 'DELETE') return new Response(null, { status: 204 })
      throw new Error(`Unexpected fixture request: ${method}`)
    }) as typeof fetch

    const share = manager.shareToViewer(managed.id)
    await uploadStarted
    let deletionSettled = false
    const deletion = manager.deleteSession(managed.id).finally(() => { deletionSettled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(runtime.sessions.has(managed.id)).toBe(false)
    expect(deletionSettled).toBe(false)
    expect(existsSync(getSessionPath(root, managed.id))).toBe(true)

    releaseUpload()
    const shareResult = await share
    await deletion

    expect(shareResult.success).toBe(false)
    expect(requests.map(request => request.method)).toEqual(['POST', 'DELETE'])
    expect(requests[1]!.url).toContain('/s/api/share-at-delete')
    expect(existsSync(getSessionPath(root, managed.id))).toBe(false)
  })
})
