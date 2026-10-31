import { strict as assert } from "node:assert";
/**
 * Transport layer tests — WsRpcServer + WsRpcClient.
 *
 * Tests handshake, RPC request/response, push events, error handling,
 * auth, and protocol version checking.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { WsRpcServer } from "../transport/server";
import { WsRpcClient } from "../transport/client";
import { waitConnected } from "./testing/transport-fixture.ts";

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

describe('edge cases', () => {
  test('invoke queues until handshake completes', async () => {
    const server = trackServer(new WsRpcServer({ host: '127.0.0.1', port: 0 }))
    await server.listen()

    server.handle('ping', async () => 'pong')

    const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      autoReconnect: false,
    }))

    client.connect()
    const result = await client.invoke('ping')
    expect(result).toBe('pong')
  })

  test('invoke without explicit connect auto-starts connection', async () => {
    const server = trackServer(new WsRpcServer({ host: '127.0.0.1', port: 0 }))
    await server.listen()

    server.handle('ping', async () => 'pong')

    const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      autoReconnect: false,
    }))

    const result = await client.invoke('ping')
    expect(result).toBe('pong')
  })

  test('invoke on disconnected client throws', async () => {
    const client = trackClient(new WsRpcClient('ws://127.0.0.1:1', {
      autoReconnect: false,
      connectTimeout: 250,
    }))

    try {
      await client.invoke('anything')
      throw new Error('Should have thrown')
    } catch (err) {
      assert(err instanceof Error)
      // Accept either the connect-time WebSocket error (with or without ws-library
      // detail like "ECONNREFUSED") or the ensureConnected fallback.
      expect(err.message).toMatch(/WebSocket error|Not connected/i)
    }
  })

  test('handler returning void resolves to undefined', async () => {
    const { server, client } = await createPair()

    server.handle('noop', async () => {
      // returns void
    })

    const result = await client.invoke('noop')
    expect(result).toBeUndefined()
  })

  test('handler returning null resolves to null', async () => {
    const { server, client } = await createPair()

    server.handle('nullable', async () => null)

    const result = await client.invoke('nullable')
    expect(result).toBeNull()
  })

  test('duplicate handler registration throws', async () => {
    const { server } = await createPair()

    server.handle('once', async () => 'ok')
    expect(() => server.handle('once', async () => 'dup')).toThrow('already registered')
  })
});
