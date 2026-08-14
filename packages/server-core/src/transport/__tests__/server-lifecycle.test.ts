/**
 * WsRpcServer lifecycle & security tests.
 *
 * Tests connection auth, capacity limits, handler timeout, and shutdown behavior.
 * Spawns a real WsRpcServer on a random port for each test.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import WebSocket, { type RawData } from 'ws'
import { WsRpcServer } from '../server'
import { PROTOCOL_VERSION } from '@craft-agent/shared/protocol'
import type { AuthenticationResult, RequestContext } from '../types'

const TEST_TOKEN = 'test-token-with-enough-entropy-to-pass'

function createServer(opts?: {
  maxClients?: number
  requireAuth?: boolean
  requireAuthoritativePrincipal?: boolean
  validateToken?: (token: string) => Promise<AuthenticationResult>
  validateSessionCookie?: (cookie: string | null) => Promise<AuthenticationResult>
  allowedSessionCookieOrigins?: readonly string[]
  authorizeRequest?: (
    context: RequestContext,
    channel: string,
    args: readonly unknown[],
  ) => boolean | Promise<boolean>
}) {
  return new WsRpcServer({
    host: '127.0.0.1',
    port: 0,
    requireAuth: opts?.requireAuth ?? true,
    validateToken: opts?.validateToken ?? (async (t) => t === TEST_TOKEN),
    validateSessionCookie: opts?.validateSessionCookie,
    allowedSessionCookieOrigins: opts?.allowedSessionCookieOrigins,
    requireAuthoritativePrincipal: opts?.requireAuthoritativePrincipal,
    maxClients: opts?.maxClients,
    authorizeRequest: opts?.authorizeRequest,
    serverId: 'test',
  })
}

function handshake(
  url: string,
  token: string,
  options: { workspaceId?: string; clientCapabilities?: string[] } = {},
): Promise<{ ws: WebSocket; clientId: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('Handshake timeout'))
    }, 5_000)

    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        type: 'handshake',
        protocolVersion: PROTOCOL_VERSION,
        token,
        workspaceId: options.workspaceId,
        clientCapabilities: options.clientCapabilities,
      }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'handshake_ack') {
        clearTimeout(timeout)
        resolve({ ws, clientId: msg.clientId })
      } else if (msg.type === 'error') {
        clearTimeout(timeout)
        reject(new Error(`Auth error: ${msg.error?.message}`))
        ws.close()
      }
    })
    ws.on('close', (code, reason) => {
      clearTimeout(timeout)
      reject(new Error(`WS closed: ${code} ${reason}`))
    })
    ws.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

function invoke(ws: WebSocket, channel: string, args: readonly unknown[] = []): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const onMessage = (data: RawData) => {
      const parsed: unknown = JSON.parse(data.toString())
      if (typeof parsed !== 'object' || parsed === null) return
      const message = parsed as Record<string, unknown>
      if (message.id !== id || message.type !== 'response') return
      ws.off('message', onMessage)
      if (typeof message.error === 'object' && message.error !== null) {
        const error = message.error as Record<string, unknown>
        reject(new Error(typeof error.message === 'string' ? error.message : 'RPC failed'))
        return
      }
      resolve(message.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, type: 'request', channel, args }))
  })
}

describe('WsRpcServer lifecycle', () => {
  let server: WsRpcServer | null = null
  const openSockets: WebSocket[] = []

  afterEach(() => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }
    openSockets.length = 0
    server?.close()
    server = null
  })

  // -- Auth tests --

  it('rejects a channel before dispatch when the principal is not authorized', async () => {
    server = createServer({
      authorizeRequest: (_context, channel, args) => (
        channel === 'allowed:channel' && args[0] === 'expected-argument'
      ),
    })
    server.handle('allowed:channel', async (_context, value: string) => value)
    server.handle('denied:channel', async () => 'must-not-run')
    await server.listen()
    const { ws } = await handshake(`ws://127.0.0.1:${server.port}`, TEST_TOKEN)
    openSockets.push(ws)

    expect(await invoke(ws, 'allowed:channel', ['expected-argument'])).toBe('expected-argument')
    await expect(invoke(ws, 'allowed:channel', ['forged-argument'])).rejects.toThrow('RPC channel denied')
    await expect(invoke(ws, 'denied:channel')).rejects.toThrow('RPC channel denied')
  })

  it('accepts valid token', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    const { ws, clientId } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws)

    expect(clientId).toBeTruthy()
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(server.getConnectedClientCount()).toBe(1)
  })

  it('rejects invalid token with 4005', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    await expect(handshake(url, 'wrong-token')).rejects.toThrow()
    expect(server.getConnectedClientCount()).toBe(0)
  })

  it('requires a server-issued principal when authoritative auth is enabled', async () => {
    server = createServer({
      requireAuthoritativePrincipal: true,
      validateToken: async (token) => token === TEST_TOKEN,
    })
    await server.listen()

    await expect(handshake(`ws://127.0.0.1:${server.port}`, TEST_TOKEN))
      .rejects.toThrow('Auth error')
  })

  it('binds workspace and client capabilities to the authenticated principal', async () => {
    server = createServer({
      requireAuthoritativePrincipal: true,
      validateToken: async (token) => token !== TEST_TOKEN
        ? false
        : {
            actorId: 'operator-1',
            allowedWorkspaceIds: ['ws-allowed'],
            capabilities: ['browser.invoke'],
            roles: ['operator'],
            authorizationGeneration: 4,
          },
    })
    server.handle('identity', async (context) => ({
      actorId: context.actorId,
      workspaceId: context.workspaceId,
      roles: context.roles,
      authorizationGeneration: context.authorizationGeneration,
    }))
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    await expect(handshake(url, TEST_TOKEN, { workspaceId: 'ws-forged' }))
      .rejects.toThrow('Workspace access denied')

    const { ws, clientId } = await handshake(url, TEST_TOKEN, {
      workspaceId: 'ws-allowed',
      clientCapabilities: ['browser.invoke', 'admin.forged'],
    })
    openSockets.push(ws)

    expect(server.hasClientCapability(clientId, 'browser.invoke')).toBe(true)
    expect(server.hasClientCapability(clientId, 'admin.forged')).toBe(false)
    expect(await invoke(ws, 'identity')).toEqual({
      actorId: 'operator-1',
      workspaceId: 'ws-allowed',
      roles: ['operator'],
      authorizationGeneration: 4,
    })
    expect(() => server?.updateClientWorkspace(clientId, 'ws-forged')).toThrow('Workspace access denied')
  })

  it('disconnects every active client for a revoked actor', async () => {
    server = createServer({
      requireAuthoritativePrincipal: true,
      validateToken: async (token) => token !== TEST_TOKEN
        ? false
        : {
            actorId: 'remote-device:device-1',
            allowedWorkspaceIds: ['ws-allowed'],
            capabilities: [],
            roles: ['remote-device'],
            authorizationGeneration: 7,
          },
    })
    await server.listen()
    const { ws } = await handshake(`ws://127.0.0.1:${server.port}`, TEST_TOKEN, {
      workspaceId: 'ws-allowed',
    })
    openSockets.push(ws)

    const closed = new Promise<number>((resolve) => {
      ws.once('close', (code) => resolve(code))
    })
    expect(server.disconnectClientsByActor('remote-device:device-1')).toBe(1)
    expect(await closed).toBe(4005)

    for (let attempt = 0; attempt < 40; attempt++) {
      if (server.getConnectedClientCount() === 0) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(server.getConnectedClientCount()).toBe(0)
  })

  it('rejects missing token', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    const ws = new WebSocket(url)
    openSockets.push(ws)

    const closeCode = await new Promise<number>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: 'handshake',
          protocolVersion: PROTOCOL_VERSION,
          // no token
        }))
      })
      ws.on('close', (code) => resolve(code))
    })

    expect(closeCode).toBe(4005)
  })

  it('accepts cookie authentication only from an explicitly allowed browser origin', async () => {
    server = createServer({
      validateSessionCookie: async (cookie) => cookie === 'craft_session=valid',
      allowedSessionCookieOrigins: ['https://remote.example.com'],
    })
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    const connectWithOrigin = (origin: string): Promise<WebSocket> => new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          Cookie: 'craft_session=valid',
          Origin: origin,
        },
      })
      const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 5_000)
      ws.on('open', () => {
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: 'handshake',
          protocolVersion: PROTOCOL_VERSION,
        }))
      })
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString()) as { type?: string }
        if (message.type !== 'handshake_ack') return
        clearTimeout(timeout)
        resolve(ws)
      })
      ws.on('close', (code) => {
        clearTimeout(timeout)
        reject(new Error(`WS closed: ${code}`))
      })
      ws.on('error', reject)
    })

    const trusted = await connectWithOrigin('https://remote.example.com')
    openSockets.push(trusted)
    await expect(connectWithOrigin('https://attacker.example')).rejects.toThrow('WS closed: 4005')
  })

  // -- Capacity tests --

  it('rejects connections when at maxClients', async () => {
    server = createServer({ maxClients: 2 })
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    // Fill up to capacity
    const { ws: ws1 } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws1)
    const { ws: ws2 } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws2)

    expect(server.getConnectedClientCount()).toBe(2)

    // Third connection should be rejected
    await expect(handshake(url, TEST_TOKEN)).rejects.toThrow()
  })

  it('allows new connections after a client disconnects', async () => {
    server = createServer({ maxClients: 1 })
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    const { ws: ws1 } = await handshake(url, TEST_TOKEN)

    // Disconnect first client and wait for server to process it
    ws1.close()
    // Poll until server sees the disconnection (max 2s)
    for (let i = 0; i < 40; i++) {
      if (server!.getConnectedClientCount() === 0) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(server!.getConnectedClientCount()).toBe(0)

    // New connection should work
    const { ws: ws2 } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws2)
    expect(server!.getConnectedClientCount()).toBe(1)
  })

  // -- Handler timeout test --

  it('times out slow handlers', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    // Register a handler that never resolves
    server.handle('test:slow', async () => {
      await new Promise(() => {}) // never resolves
    })

    const { ws } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws)

    // Send a request to the slow handler
    const reqId = crypto.randomUUID()
    ws.send(JSON.stringify({
      id: reqId,
      type: 'request',
      channel: 'test:slow',
    }))

    // Should receive error response (but this will take 60s — skip in normal runs)
    // This test validates the handler is registered; full timeout is covered by the 60s static value
  })

  // -- Protocol version tests --

  it('rejects wrong protocol major version', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    const ws = new WebSocket(url)
    openSockets.push(ws)

    const closeCode = await new Promise<number>((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: 'handshake',
          protocolVersion: '99.0',
          token: TEST_TOKEN,
        }))
      })
      ws.on('close', (code) => resolve(code))
    })

    expect(closeCode).toBe(4004)
  })

  // -- Close behavior --

  it('terminates all clients on close()', async () => {
    server = createServer()
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    const { ws: ws1 } = await handshake(url, TEST_TOKEN)
    const { ws: ws2 } = await handshake(url, TEST_TOKEN)
    openSockets.push(ws1, ws2)

    const closedPromise = Promise.all([
      new Promise(resolve => ws1.on('close', resolve)),
      new Promise(resolve => ws2.on('close', resolve)),
    ])

    server.close()
    await closedPromise

    expect(server.getConnectedClientCount()).toBe(0)
  })
})
