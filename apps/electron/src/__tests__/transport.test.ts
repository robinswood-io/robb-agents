/**
 * Transport layer tests — WsRpcServer + WsRpcClient.
 *
 * Tests handshake, RPC request/response, push events, error handling,
 * auth, and protocol version checking.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { WebSocket } from "ws";
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

describe('handshake', () => {
  test('client connects and receives clientId', async () => {
    const { client } = await createPair()
    expect(client.isConnected).toBe(true)
  })

  test('server assigns random port when port=0', async () => {
    const server = trackServer(new WsRpcServer({ host: '127.0.0.1', port: 0 }))
    await server.listen()
    expect(server.port).toBeGreaterThan(0)
  })

  test('uses an accepted workspace update on the next reconnect handshake', async () => {
    const { server, client } = await createPair()
    server.handle('workspace', async (ctx) => ctx.workspaceId)
    expect(await client.invoke('workspace')).toBe('test-workspace')

    client.setWorkspaceId('next-workspace')
    const reconnecting = waitForState(client, (state) => state.status !== 'connected')
    client.reconnectNow()
    await reconnecting
    await waitConnected(client)

    expect(await client.invoke('workspace')).toBe('next-workspace')
  })

  test('handshake without protocolVersion is rejected', async () => {
    const server = trackServer(new WsRpcServer({ host: '127.0.0.1', port: 0 }))
    await server.listen()

    const result = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)

      ws.on('open', () => {
        ws.send(JSON.stringify({ id: 'missing-version', type: 'handshake' }))
      })

      ws.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() })
      })

      ws.on('error', (error) => {
        reject(error)
      })
    })

    expect(result.code).toBe(4004)
  })
});
