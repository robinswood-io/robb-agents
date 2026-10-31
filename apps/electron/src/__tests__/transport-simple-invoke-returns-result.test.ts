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

describe('RPC', () => {
  test('simple invoke returns result', async () => {
    const { server, client } = await createPair()

    server.handle('greet', async (_ctx, name: string) => {
      return `Hello, ${name}!`
    })

    const result = await client.invoke('greet', 'World')
    expect(result).toBe('Hello, World!')
  })

  test('handler receives correct args', async () => {
    const { server, client } = await createPair()

    server.handle('add', async (_ctx, a: number, b: number) => a + b)

    const result = await client.invoke('add', 3, 4)
    expect(result).toBe(7)
  })

  test('handler has access to clientId and workspaceId', async () => {
    const { server, client } = await createPair()

    server.handle('whoami', async (ctx) => ({
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
    }))

    const result = await client.invoke('whoami')
    assert(result && typeof result === 'object' && 'clientId' in result && 'workspaceId' in result)
    expect(result.clientId).toBeTruthy()
    expect(result.workspaceId).toBe('test-workspace')
  })

  test('unknown channel returns CHANNEL_NOT_FOUND error', async () => {
    const { client } = await createPair()

    try {
      await client.invoke('nonexistent:channel')
      throw new Error('Should have thrown')
    } catch (err) {
      assertRpcError(err)
      expect(err.code).toBe('CHANNEL_NOT_FOUND')
    }
  })

  test('handler error returns HANDLER_ERROR', async () => {
    const { server, client } = await createPair()

    server.handle('fail', async () => {
      throw new Error('Something broke')
    })

    try {
      await client.invoke('fail')
      throw new Error('Should have thrown')
    } catch (err) {
      assertRpcError(err)
      expect(err.code).toBe('HANDLER_ERROR')
      expect(err.message).toBe('Something broke')
    }
  })

  test('handler with custom error code', async () => {
    const { server, client } = await createPair()

    server.handle('export', async () => {
      const err: Error & { code?: string } = new Error('Session is active')
      err.code = 'SESSION_NOT_IDLE'
      throw err
    })

    try {
      await client.invoke('export')
      throw new Error('Should have thrown')
    } catch (err) {
      assertRpcError(err)
      expect(err.code).toBe('SESSION_NOT_IDLE')
    }
  })

  test('multiple concurrent requests resolve independently', async () => {
    const { server, client } = await createPair()

    server.handle('delay', async (_ctx, ms: number, value: string) => {
      await new Promise(r => setTimeout(r, ms))
      return value
    })

    const [r1, r2, r3] = await Promise.all([
      client.invoke('delay', 50, 'first'),
      client.invoke('delay', 10, 'second'),
      client.invoke('delay', 30, 'third'),
    ])

    expect(r1).toBe('first')
    expect(r2).toBe('second')
    expect(r3).toBe('third')
  })

  test('Uint8Array response payload roundtrips intact', async () => {
    const { server, client } = await createPair()

    server.handle('binary:response', async () => {
      return new Uint8Array([37, 80, 68, 70, 45]) // "%PDF-"
    })

    const result = await client.invoke('binary:response')
    expect(result).toBeInstanceOf(Uint8Array)
    expect(Array.from(result as Uint8Array)).toEqual([37, 80, 68, 70, 45])
  })

  test('Uint8Array request args decode correctly in handler', async () => {
    const { server, client } = await createPair()

    let seen: Uint8Array | null = null

    server.handle('binary:arg', async (_ctx, bytes: Uint8Array) => {
      seen = bytes
      return Array.from(bytes).reduce((sum, value) => sum + value, 0)
    })

    const result = await client.invoke('binary:arg', new Uint8Array([1, 2, 3, 4]))
    expect(result).toBe(10)
    expect(seen).toBeInstanceOf(Uint8Array)
    expect(Array.from(seen!)).toEqual([1, 2, 3, 4])
  })
});
