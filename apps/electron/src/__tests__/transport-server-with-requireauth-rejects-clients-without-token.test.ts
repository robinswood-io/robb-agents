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

afterEach(() => {
  for (const c of clients) c.destroy()
  for (const s of servers) s.close()
  clients = []
  servers = []
})

describe('auth', () => {
  test('server with requireAuth rejects clients without token', async () => {
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

    // Should NOT become connected
    await new Promise(r => setTimeout(r, 500))
    expect(client.isConnected).toBe(false)
  })

  test('server with requireAuth accepts valid token', async () => {
    const server = trackServer(new WsRpcServer({
      host: '127.0.0.1',
      port: 0,
      requireAuth: true,
      validateToken: async (t) => t === 'valid-token',
    }))
    await server.listen()

    const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      token: 'valid-token',
      autoReconnect: false,
    }))
    client.connect()
    await waitConnected(client)

    expect(client.isConnected).toBe(true)
  })

  test('server with requireAuth rejects invalid token', async () => {
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

    await new Promise(r => setTimeout(r, 500))
    expect(client.isConnected).toBe(false)
  })
});
