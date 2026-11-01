/**
 * Transport layer tests — WsRpcServer + WsRpcClient.
 *
 * Tests handshake, RPC request/response, push events, error handling,
 * auth, and protocol version checking.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { WsRpcServer } from "../transport/server";
import { WsRpcClient } from "../transport/client";
import { assertRpcError, waitConnected } from "./testing/transport-fixture.ts";

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

describe('invokeClient', () => {
  test('server invokes client capability and receives result', async () => {
    const { server, client, clientId } = await createPair(
      {},
      { clientCapabilities: ['client:openExternal'] },
    )

    client.handleCapability('client:openExternal', (url: string) => {
      return `opened: ${url}`
    })

    const result = await server.invokeClient(clientId, 'client:openExternal', 'https://example.com')
    expect(result).toBe('opened: https://example.com')
  })

  test('invokeClient on missing capability returns CAPABILITY_UNAVAILABLE immediately', async () => {
    const { server, clientId } = await createPair(
      {},
      { clientCapabilities: [] },
    )

    try {
      await server.invokeClient(clientId, 'client:openExternal', 'https://example.com')
      throw new Error('Should have thrown')
    } catch (err) {
      assertRpcError(err)
      expect(err.code).toBe('CAPABILITY_UNAVAILABLE')
    }
  })

  test('invokeClient on disconnected client returns CLIENT_DISCONNECTED immediately', async () => {
    const { server } = await createPair()

    try {
      await server.invokeClient('nonexistent-client-id', 'client:openExternal', 'url')
      throw new Error('Should have thrown')
    } catch (err) {
      assertRpcError(err)
      expect(err.code).toBe('CLIENT_DISCONNECTED')
    }
  })

  test('client handler error propagates to server', async () => {
    const { server, client, clientId } = await createPair(
      {},
      { clientCapabilities: ['client:failing'] },
    )

    client.handleCapability('client:failing', () => {
      throw new Error('Handler blew up')
    })

    try {
      await server.invokeClient(clientId, 'client:failing')
      throw new Error('Should have thrown')
    } catch (err) {
      assertRpcError(err)
      expect(err.code).toBe('HANDLER_ERROR')
      expect(err.message).toBe('Handler blew up')
    }
  })

  test('disconnect mid-flight rejects pending invoke with CLIENT_DISCONNECTED', async () => {
    const { server, client, clientId } = await createPair(
      {},
      { clientCapabilities: ['client:slow'] },
    )

    // Register a handler that never resolves — we'll disconnect before it returns
    client.handleCapability('client:slow', () => {
      return new Promise(() => {}) // Never resolves
    })

    const invokePromise = server.invokeClient(clientId, 'client:slow')

    // Disconnect client after a brief delay
    await new Promise(r => setTimeout(r, 50))
    client.destroy()

    try {
      await invokePromise
      throw new Error('Should have thrown')
    } catch (err) {
      assertRpcError(err)
      expect(err.code).toBe('CLIENT_DISCONNECTED')
    }
  })

  test('handshake with capabilities stores them on server', async () => {
    const { server, client, clientId } = await createPair(
      {},
      { clientCapabilities: ['client:openExternal', 'client:notify'] },
    )

    client.handleCapability('client:openExternal', () => 'ok1')
    client.handleCapability('client:notify', () => 'ok2')

    // Both capabilities should work
    const r1 = await server.invokeClient(clientId, 'client:openExternal')
    const r2 = await server.invokeClient(clientId, 'client:notify')
    expect(r1).toBe('ok1')
    expect(r2).toBe('ok2')

    // Unregistered capability should fail
    try {
      await server.invokeClient(clientId, 'client:unknown')
      throw new Error('Should have thrown')
    } catch (err) {
      assertRpcError(err)
      expect(err.code).toBe('CAPABILITY_UNAVAILABLE')
    }
  })

  test('async client handler works', async () => {
    const { server, client, clientId } = await createPair(
      {},
      { clientCapabilities: ['client:async'] },
    )

    client.handleCapability('client:async', async (ms: number) => {
      await new Promise(r => setTimeout(r, ms))
      return 'done'
    })

    const result = await server.invokeClient(clientId, 'client:async', 20)
    expect(result).toBe('done')
  })
});
