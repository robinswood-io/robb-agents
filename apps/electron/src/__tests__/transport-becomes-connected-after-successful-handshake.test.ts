/**
 * Transport layer tests — WsRpcServer + WsRpcClient.
 *
 * Tests handshake, RPC request/response, push events, error handling,
 * auth, and protocol version checking.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { WsRpcServer } from "../transport/server";
import { WsRpcClient } from "../transport/client";
import { waitConnected, waitForState } from "./testing/transport-fixture.ts";

// Helpers to manage cleanup
let servers: WsRpcServer[] = []
let clients: WsRpcClient[] = []
function trackServer(s: WsRpcServer) { servers.push(s); return s }
function trackClient(c: WsRpcClient) { clients.push(c); return c }
/** Create a server + connected client pair. */
async function createPair(
  serverOpts?: Partial<import('../transport/server').WsRpcServerOptions>,
  clientOpts?: Partial<import('../transport/client').WsRpcClientOptions>,
) {
  let connectedClientId: string | null = null
  const server = trackServer(new WsRpcServer({
    host: '127.0.0.1',
    port: 0,
    onClientConnected: (info) => { connectedClientId = info.clientId },
    ...serverOpts,
  }))
  await server.listen()

  const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
    workspaceId: 'test-workspace',
    autoReconnect: false,
    ...clientOpts,
  }))
  client.connect()
  await waitConnected(client)

  // Wait for onClientConnected callback
  const start = Date.now()
  while (!connectedClientId) {
    if (Date.now() - start > 2000) throw new Error('No clientId received')
    await new Promise(r => setTimeout(r, 10))
  }

  return { server, client, clientId: connectedClientId! }
}

afterEach(() => {
  for (const c of clients) c.destroy()
  for (const s of servers) s.close()
  clients = []
  servers = []
})

describe('connection state', () => {
  test('becomes connected after successful handshake', async () => {
    const { client } = await createPair()

    const state = client.getConnectionState()
    expect(state.status).toBe('connected')
    expect(state.mode).toBe('local')
    expect(state.url.startsWith('ws://127.0.0.1:')).toBe(true)
  })

  test('classifies invalid token as auth failure', async () => {
    const server = trackServer(new WsRpcServer({
      host: '127.0.0.1',
      port: 0,
      requireAuth: true,
      validateToken: async (t) => t === 'valid-token',
    }))
    await server.listen()

    const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      token: 'wrong-token',
      autoReconnect: false,
    }))

    client.connect()
    await waitForState(client, (state) => state.status === 'failed')

    const state = client.getConnectionState()
    expect(state.lastError?.kind).toBe('auth')
  })

  test('enters reconnecting after disconnect when autoReconnect is enabled', async () => {
    const { server, client } = await createPair({}, { autoReconnect: true, maxReconnectDelay: 200 })

    server.close()
    await waitForState(client, (state) => state.status === 'reconnecting' || state.status === 'failed')

    const state = client.getConnectionState()
    expect(['reconnecting', 'failed']).toContain(state.status)
    expect(state.attempt).toBeGreaterThanOrEqual(1)
  })

  test('captures websocket close code and reason for handshake failures', async () => {
    const server = trackServer(new WsRpcServer({
      host: '127.0.0.1',
      port: 0,
      requireAuth: true,
      validateToken: async (t) => t === 'valid-token',
    }))
    await server.listen()

    const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      autoReconnect: false,
    }))

    client.connect()
    await waitForState(client, (state) => state.status === 'failed' && state.lastClose !== undefined)

    const state = client.getConnectionState()
    expect(state.lastClose?.code).toBe(4005)
  })
});
