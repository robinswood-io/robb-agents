/**
 * Transport layer tests — WsRpcServer + WsRpcClient.
 *
 * Tests handshake, RPC request/response, push events, error handling,
 * auth, and protocol version checking.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { EVENT_BUFFER_MAX_SIZE, type MessageEnvelope } from "@craft-agent/shared/protocol";
import { WsRpcServer } from "../transport/server";
import { WsRpcClient } from "../transport/client";
import { serializeEnvelope } from "../transport/codec";
import { waitConnected, waitForState, waitUntil } from "./testing/transport-fixture.ts";

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

describe('reliable delivery', () => {
  test('manual reconnect preserves reconnect identity and replays missed events', async () => {
    let sawDisconnect = false
    const server = trackServer(new WsRpcServer({
      host: '127.0.0.1',
      port: 0,
      onClientDisconnected: () => {
        if (sawDisconnect) return
        sawDisconnect = true
        server.push('stream', { to: 'workspace', workspaceId: 'test-workspace' }, 'missed-during-manual-reconnect')
      },
    }))
    await server.listen()

    const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      workspaceId: 'test-workspace',
      autoReconnect: false,
    }))

    const received: string[] = []
    const reconnectStates: boolean[] = []
    client.on('stream', (value: string) => received.push(value))
    client.on('__transport:reconnected', (isStale: boolean) => reconnectStates.push(isStale))

    client.connect()
    await waitConnected(client)

    server.push('stream', { to: 'workspace', workspaceId: 'test-workspace' }, 'before-reconnect')
    await waitUntil(() => received.includes('before-reconnect'))

    client.reconnectNow()

    await waitConnected(client)
    await waitUntil(() => reconnectStates.length === 1)
    await waitUntil(() => received.includes('missed-during-manual-reconnect'))

    expect(reconnectStates).toEqual([false])
    expect(received).toEqual(['before-reconnect', 'missed-during-manual-reconnect'])
  })

  test('reconnect replay ignores events targeted at other clients', async () => {
    const server = trackServer(new WsRpcServer({ host: '127.0.0.1', port: 0 }))
    await server.listen()

    const clientA = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      workspaceId: 'ws-a',
      autoReconnect: false,
    }))
    const clientB = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      workspaceId: 'ws-b',
      autoReconnect: false,
    }))

    const receivedA: string[] = []
    const receivedB: string[] = []
    const reconnectStates: boolean[] = []

    clientA.on('stream', (value: string) => receivedA.push(value))
    clientB.on('stream', (value: string) => receivedB.push(value))
    clientA.on('__transport:reconnected', (isStale: boolean) => reconnectStates.push(isStale))

    clientA.connect()
    clientB.connect()
    await waitConnected(clientA)
    await waitConnected(clientB)

    server.push('stream', { to: 'workspace', workspaceId: 'ws-a' }, 'before-a')
    await waitUntil(() => receivedA.includes('before-a'))

    ;clientA['ws']!.close()
    await waitForState(clientA, (state) => state.status === 'disconnected')

    server.push('stream', { to: 'workspace', workspaceId: 'ws-b' }, 'only-b')
    server.push('stream', { to: 'workspace', workspaceId: 'ws-a' }, 'missed-a')

    await waitUntil(() => receivedB.includes('only-b'))

    clientA.reconnectNow()

    await waitConnected(clientA)
    await waitUntil(() => reconnectStates.length === 1)
    await waitUntil(() => receivedA.includes('missed-a'))

    expect(reconnectStates).toEqual([false])
    expect(receivedA).toEqual(['before-a', 'missed-a'])
    expect(receivedB).toEqual(['only-b'])
    expect(clientA['lastSeenSeq']).toBe(2)
    expect(clientB['lastSeenSeq']).toBe(1)
  })

  test('marks reconnect stale when the retained buffer evicts missed events', async () => {
    const server = trackServer(new WsRpcServer({ host: '127.0.0.1', port: 0 }))
    await server.listen()

    const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      workspaceId: 'test-workspace',
      autoReconnect: false,
    }))

    const received: string[] = []
    const reconnectStates: boolean[] = []
    client.on('stream', (value: string) => received.push(value))
    client.on('__transport:reconnected', (isStale: boolean) => reconnectStates.push(isStale))

    client.connect()
    await waitConnected(client)

    server.push('stream', { to: 'workspace', workspaceId: 'test-workspace' }, 'before-stale')
    await waitUntil(() => received.includes('before-stale'))

    ;client['ws']!.close()
    await waitForState(client, (state) => state.status === 'disconnected')

    for (let i = 0; i < EVENT_BUFFER_MAX_SIZE + 25; i++) {
      server.push('stream', { to: 'workspace', workspaceId: 'test-workspace' }, `missed-${i}`)
    }

    client.reconnectNow()

    await waitConnected(client)
    await waitUntil(() => reconnectStates.length === 1)

    expect(reconnectStates).toEqual([true])
    expect(received).toEqual(['before-stale'])
  })

  test('sequence_ack evicts acknowledged buffered events', async () => {
    const { server, client, clientId } = await createPair()

    server.push('stream', { to: 'workspace', workspaceId: 'test-workspace' }, 'one')
    server.push('stream', { to: 'workspace', workspaceId: 'test-workspace' }, 'two')

    await waitUntil(() => client['lastSeenSeq'] === 2)

    const ack: MessageEnvelope = {
      id: randomUUID(),
      type: 'sequence_ack',
      lastSeq: 2,
    }
    ;client['ws']!.send(serializeEnvelope(ack))

    await waitUntil(() => (server['clients'].get(clientId)?.eventBuffer.length ?? -1) === 0)

    expect(server['clients'].get(clientId)?.lastAckedSeq).toBe(2)
  })

  test('safe send skips non-open sockets', () => {
    const client = trackClient(new WsRpcClient('ws://127.0.0.1:1', {
      autoReconnect: false,
    }))

    let sendCalls = 0
    const fakeWs = {
      OPEN: 1,
      readyState: 2,
      send: () => { sendCalls += 1 },
    } satisfies NonNullable<Parameters<WsRpcClient['trySendEnvelope']>[0]>

    const sent = client['trySendEnvelope'](fakeWs, {
      id: randomUUID(),
      type: 'sequence_ack',
      lastSeq: 1,
    } satisfies MessageEnvelope)

    expect(sent).toBe(false)
    expect(sendCalls).toBe(0)
  })
});
