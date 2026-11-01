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

describe('push events', () => {
  test('client receives server-pushed events', async () => {
    const { server, client } = await createPair()

    const received: string[] = []
    client.on('test:event', (data: string) => {
      received.push(data)
    })

    // Small delay to ensure listener is registered
    await new Promise(r => setTimeout(r, 50))

    server.push('test:event', { to: 'all' }, 'hello')
    server.push('test:event', { to: 'all' }, 'world')

    await new Promise(r => setTimeout(r, 100))
    expect(received).toEqual(['hello', 'world'])
  })

  test('workspace-targeted push only reaches matching clients', async () => {
    const server = trackServer(new WsRpcServer({ host: '127.0.0.1', port: 0 }))
    await server.listen()

    const client1 = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      workspaceId: 'ws-a',
      autoReconnect: false,
    }))
    const client2 = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      workspaceId: 'ws-b',
      autoReconnect: false,
    }))

    client1.connect()
    client2.connect()
    await waitConnected(client1)
    await waitConnected(client2)

    const received1: string[] = []
    const received2: string[] = []
    client1.on('update', (v: string) => received1.push(v))
    client2.on('update', (v: string) => received2.push(v))

    await new Promise(r => setTimeout(r, 50))

    server.push('update', { to: 'workspace', workspaceId: 'ws-a' }, 'for-a')
    server.push('update', { to: 'workspace', workspaceId: 'ws-b' }, 'for-b')

    await new Promise(r => setTimeout(r, 100))
    expect(received1).toEqual(['for-a'])
    expect(received2).toEqual(['for-b'])
  })

  test('unsubscribe stops receiving events', async () => {
    const { server, client } = await createPair()

    const received: string[] = []
    const unsub = client.on('test:event', (data: string) => {
      received.push(data)
    })

    await new Promise(r => setTimeout(r, 50))

    server.push('test:event', { to: 'all' }, 'before')
    await new Promise(r => setTimeout(r, 50))

    unsub()
    server.push('test:event', { to: 'all' }, 'after')
    await new Promise(r => setTimeout(r, 50))

    expect(received).toEqual(['before'])
  })

  test('Uint8Array event args roundtrip intact', async () => {
    const { server, client } = await createPair()

    let received: Uint8Array | null = null

    client.on('binary:event', (data: Uint8Array) => {
      received = data
    })

    await new Promise(r => setTimeout(r, 50))

    server.push('binary:event', { to: 'all' }, new Uint8Array([9, 8, 7]))

    await new Promise(r => setTimeout(r, 50))
    expect(received).toBeInstanceOf(Uint8Array)
    expect(Array.from(received!)).toEqual([9, 8, 7])
  })
});
