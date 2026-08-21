import { describe, expect, test } from 'bun:test'

import {
  Server,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'
const MODERN_PROTOCOL_VERSION = '2026-07-28'
const LEGACY_PROTOCOL_VERSION = '2025-11-25'

class MemoryWireTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: Transport['onmessage']

  readonly sent: JSONRPCMessage[] = []

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message)
  }

  async close(): Promise<void> {
    this.onclose?.()
  }
}

async function responseFor(
  transport: MemoryWireTransport,
  id: number,
): Promise<JSONRPCMessage> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = transport.sent.find((message) => 'id' in message && message.id === id)
    if (response) return response
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`Timed out waiting for JSON-RPC response ${id}`)
}

function modernMeta(): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': {
      name: 'robb-agents-sdk-gap-test',
      version: '1.0.0',
    },
    'io.modelcontextprotocol/clientCapabilities': {
      extensions: {
        [TASKS_EXTENSION]: {},
      },
    },
  }
}

function registerModernProbeHandler(
  server: Server,
  method: string,
  invoked: string[],
): void {
  server.setRequestHandler(
    method,
    {
      // The SDK lifts the reserved 2026 envelope fields before custom-schema
      // validation, so only extension metadata can remain in `_meta` here.
      params: z.object({
        taskId: z.string(),
        _meta: z.record(z.string(), z.unknown()).optional(),
      }).loose(),
      result: z.object({ resultType: z.literal('complete') }).loose(),
    },
    async () => {
      invoked.push(method)
      return { resultType: 'complete' as const }
    },
  )
}

async function probeModernMethod(method: string): Promise<{
  invoked: string[]
  response: JSONRPCMessage
}> {
  const transport = new MemoryWireTransport()
  const invoked: string[] = []
  const handle = serveStdio(() => {
    const server = new Server(
      { name: 'modern-tasks-gap-probe', version: '1.0.0' },
      { capabilities: { extensions: { [TASKS_EXTENSION]: {} } } },
    )
    registerModernProbeHandler(server, method, invoked)
    return server
  }, { transport, legacy: 'serve' })

  try {
    await Promise.resolve()
    transport.onmessage?.({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        taskId: 'task-1',
        _meta: modernMeta(),
      },
    })
    return { invoked, response: await responseFor(transport, 1) }
  } finally {
    await handle.close()
  }
}

function registerLegacyProbeHandler(
  server: Server,
  method: 'tasks/get' | 'tasks/cancel',
  invoked: string[],
): void {
  server.setRequestHandler(
    method,
    {
      params: z.object({ taskId: z.string() }).loose(),
      result: z.object({
        taskId: z.string(),
        status: z.enum(['working', 'cancelled']),
        createdAt: z.string(),
        lastUpdatedAt: z.string(),
        ttl: z.number(),
      }).loose(),
    },
    async () => {
      invoked.push(method)
      return {
        taskId: 'task-1',
        status: method === 'tasks/cancel' ? 'cancelled' as const : 'working' as const,
        createdAt: '2026-08-21T00:00:00.000Z',
        lastUpdatedAt: '2026-08-21T00:00:01.000Z',
        ttl: 60_000,
      }
    },
  )
}

async function probeLegacyMethod(method: 'tasks/get' | 'tasks/cancel'): Promise<{
  invoked: string[]
  response: JSONRPCMessage
}> {
  const transport = new MemoryWireTransport()
  const invoked: string[] = []
  const handle = serveStdio(() => {
    const server = new Server(
      { name: 'legacy-tasks-probe', version: '1.0.0' },
      { capabilities: { tasks: { list: {}, cancel: {} } } },
    )
    registerLegacyProbeHandler(server, method, invoked)
    return server
  }, { transport, legacy: 'serve' })

  try {
    await Promise.resolve()
    transport.onmessage?.({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: { tasks: { list: {}, cancel: {} } },
        clientInfo: { name: 'legacy-sdk-gap-test', version: '1.0.0' },
      },
    })
    await responseFor(transport, 1)
    transport.onmessage?.({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    })
    transport.onmessage?.({
      jsonrpc: '2.0',
      id: 2,
      method,
      params: { taskId: 'task-1' },
    })
    return { invoked, response: await responseFor(transport, 2) }
  } finally {
    await handle.close()
  }
}

describe('MCP SDK v2 Tasks server gap (#2598)', () => {
  test('reaches the new 2026 tasks/update extension method', async () => {
    const result = await probeModernMethod('tasks/update')

    expect(result.invoked).toEqual(['tasks/update'])
    expect(result.response).toMatchObject({
      id: 1,
      result: { resultType: 'complete' },
    })
  })

  test.each(['tasks/get', 'tasks/cancel'])(
    'rejects the legacy-name collision %s before its 2026 custom handler',
    async (method) => {
      const result = await probeModernMethod(method)

      expect(result.invoked).toEqual([])
      expect(result.response).toMatchObject({
        id: 1,
        error: { code: -32601, message: 'Method not found' },
      })
    },
  )

  test.each(['tasks/get', 'tasks/cancel'] as const)(
    'keeps the 2025 core method %s reachable',
    async (method) => {
      const result = await probeLegacyMethod(method)

      expect(result.invoked).toEqual([method])
      expect(result.response).toMatchObject({
        id: 2,
        result: {
          taskId: 'task-1',
          status: method === 'tasks/cancel' ? 'cancelled' : 'working',
          ttl: 60_000,
        },
      })
    },
  )
})
