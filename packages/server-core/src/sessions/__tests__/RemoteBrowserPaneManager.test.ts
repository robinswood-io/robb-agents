/**
 * RemoteBrowserPaneManager unit tests.
 *
 * Verifies wire packaging, host-client gating, and screenshot byte round-trip.
 * Uses a fake RpcServer instead of a real WS pair — we only care about the
 * BrowserCapabilityRequest shape that the bridge produces.
 */

import { describe, it, expect } from 'bun:test'
import { RemoteBrowserPaneManager } from '../RemoteBrowserPaneManager'
import { CLIENT_BROWSER_INVOKE, type BrowserCapabilityRequest } from '../../transport'
import type { RpcServer } from '../../transport/types'

interface FakeServerCall {
  clientId: string
  channel: string
  args: unknown[]
}

function createFakeServer(opts?: {
  invokeImpl?: (call: FakeServerCall) => unknown
  capabilityClients?: Set<string>
}): { server: RpcServer; calls: FakeServerCall[] } {
  const calls: FakeServerCall[] = []
  const server: RpcServer = {
    handle() {},
    push() {},
    async invokeClient(clientId, channel, ...args) {
      const call = { clientId, channel, args }
      calls.push(call)
      return opts?.invokeImpl?.(call) ?? undefined
    },
    hasClientCapability(clientId) {
      return opts?.capabilityClients?.has(clientId) ?? true
    },
    findClientsWithCapability() {
      return opts?.capabilityClients ? [...opts.capabilityClients] : []
    },
  }
  return { server, calls }
}

describe('RemoteBrowserPaneManager — wire packaging', () => {
  it('packages async methods into a BrowserCapabilityRequest with sessionId + workspaceId', async () => {
    const { server, calls } = createFakeServer({ invokeImpl: () => ({ url: 'https://x', title: 't' }) })
    const bridge = new RemoteBrowserPaneManager({
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      rpcServer: server,
      getHostClient: () => 'client-A',
    })
    await bridge.navigate('inst-1', 'https://example.com')

    expect(calls).toHaveLength(1)
    const c = calls[0]!
    expect(c.clientId).toBe('client-A')
    expect(c.channel).toBe(CLIENT_BROWSER_INVOKE)
    const req = c.args[0] as BrowserCapabilityRequest
    expect(req.v).toBe(1)
    expect(req.method).toBe('navigate')
    expect(req.sessionId).toBe('sess-1')
    expect(req.workspaceId).toBe('ws-1')
    expect(req.args).toEqual(['inst-1', 'https://example.com'])
  })

  it('createForSessionAsync awaits the WS round-trip and returns the resolved id', async () => {
    const { server } = createFakeServer({ invokeImpl: () => 'browser-7' })
    const bridge = new RemoteBrowserPaneManager({
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      rpcServer: server,
      getHostClient: () => 'client-A',
    })
    const id = await bridge.createForSessionAsync('sess-1', { show: true })
    expect(id).toBe('browser-7')
  })

  it('carries the mutation URL policy to the desktop point of effect', async () => {
    const { server, calls } = createFakeServer()
    const bridge = new RemoteBrowserPaneManager({
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      rpcServer: server,
      getHostClient: () => 'client-A',
    })
    const policy = {
      reason: 'contextual-gmail-reply' as const,
      blockedHosts: ['mail.google.com'],
      matchSubdomains: true,
    }

    await bridge.clickElement('inst-1', '@send', undefined, policy)

    const req = calls[0]!.args[0] as BrowserCapabilityRequest
    expect(req.v).toBe(2)
    expect(req.method).toBe('clickElement')
    expect(req.args).toEqual(['inst-1', '@send', undefined])
    expect(req).toMatchObject({ mutationUrlPolicy: policy })
  })

  it('keeps an unguarded mutation on v1 for existing desktop compatibility', async () => {
    const { server, calls } = createFakeServer()
    const bridge = new RemoteBrowserPaneManager({
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      rpcServer: server,
      getHostClient: () => 'client-A',
    })

    await bridge.clickElement('inst-1', '@ordinary-button')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.args[0]).toEqual({
      v: 1,
      method: 'clickElement',
      args: ['inst-1', '@ordinary-button', undefined],
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
    })
  })

  it('fails closed when an old v1-only desktop receives a guarded mutation', async () => {
    const { server, calls } = createFakeServer({
      invokeImpl: (call) => {
        const req = call.args[0] as BrowserCapabilityRequest
        if (req.v !== 1) throw new Error(`Unsupported browser capability request shape (v=${req.v}).`)
      },
    })
    const bridge = new RemoteBrowserPaneManager({
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      rpcServer: server,
      getHostClient: () => 'old-client',
    })
    const policy = {
      reason: 'contextual-gmail-reply' as const,
      blockedHosts: ['mail.google.com'],
      matchSubdomains: true,
    }

    await expect(bridge.clickElement('inst-1', '@send', undefined, policy))
      .rejects.toThrow('Unsupported browser capability request shape (v=2)')
    expect(calls).toHaveLength(1)
    expect((calls[0]!.args[0] as BrowserCapabilityRequest).v).toBe(2)
  })

  it('throws BROWSER_NO_CAPABLE_CLIENT when no host client is connected', async () => {
    const { server } = createFakeServer()
    const bridge = new RemoteBrowserPaneManager({
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      rpcServer: server,
      getHostClient: () => null,
    })

    let caught: unknown
    try {
      await bridge.navigate('inst-1', 'https://example.com')
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string }).code).toBe('BROWSER_NO_CAPABLE_CLIENT')
  })

  it('throws BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED for uploadFile', async () => {
    const { server, calls } = createFakeServer()
    const bridge = new RemoteBrowserPaneManager({
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      rpcServer: server,
      getHostClient: () => 'client-A',
    })

    let caught: unknown
    try {
      await bridge.uploadFile('inst-1', 'ref', ['/some/file'])
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string }).code).toBe('BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED')
    expect(calls).toHaveLength(0)  // never hits the wire
  })

  it('throws CAPABILITY_UNAVAILABLE when host client does not advertise the capability', async () => {
    const { server } = createFakeServer({ capabilityClients: new Set([]) })
    const bridge = new RemoteBrowserPaneManager({
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      rpcServer: server,
      getHostClient: () => 'client-A',  // returns id, but server says they lack the cap
    })

    let caught: unknown
    try {
      await bridge.navigate('inst-1', 'https://example.com')
    } catch (err) {
      caught = err
    }
    expect((caught as { code?: string }).code).toBe('CAPABILITY_UNAVAILABLE')
  })
})

describe('RemoteBrowserPaneManager — screenshot wire conversion', () => {
  it('converts Uint8Array imageBytes → Buffer', async () => {
    const sample = new Uint8Array([1, 2, 3, 4, 5])
    const { server } = createFakeServer({
      invokeImpl: () => ({ imageBytes: sample, imageFormat: 'png', metadata: { ok: true } }),
    })
    const bridge = new RemoteBrowserPaneManager({
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      rpcServer: server,
      getHostClient: () => 'client-A',
    })

    const result = await bridge.screenshot('inst-1')
    expect(Buffer.isBuffer(result.imageBuffer)).toBe(true)
    expect(Array.from(result.imageBuffer)).toEqual([1, 2, 3, 4, 5])
    expect(result.imageFormat).toBe('png')
    expect(result.metadata).toEqual({ ok: true })
  })

  it('handles wire arrival as serialized {data} object (structured-clone variant)', async () => {
    const { server } = createFakeServer({
      invokeImpl: () => ({ imageBytes: { data: [9, 8, 7] }, imageFormat: 'jpeg' }),
    })
    const bridge = new RemoteBrowserPaneManager({
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      rpcServer: server,
      getHostClient: () => 'client-A',
    })

    const result = await bridge.screenshot('inst-1')
    expect(Array.from(result.imageBuffer)).toEqual([9, 8, 7])
    expect(result.imageFormat).toBe('jpeg')
  })
})

describe('RemoteBrowserPaneManager — sync stubs', () => {
  it('listInstances (sync) returns []; listInstancesAsync hits the wire', async () => {
    const { server, calls } = createFakeServer({ invokeImpl: () => [] })
    const bridge = new RemoteBrowserPaneManager({
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      rpcServer: server,
      getHostClient: () => 'client-A',
    })
    expect(bridge.listInstances()).toEqual([])
    expect(calls).toHaveLength(0)

    await bridge.listInstancesAsync()
    expect(calls).toHaveLength(1)
    expect((calls[0]!.args[0] as BrowserCapabilityRequest).method).toBe('listInstances')
  })
})
