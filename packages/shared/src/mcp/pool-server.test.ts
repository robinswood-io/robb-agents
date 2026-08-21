import { describe, expect, it } from 'bun:test'

import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as LegacyHttpTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { CraftMcpClient } from './client.ts'
import type { McpClientPool } from './mcp-pool.ts'
import { McpPoolServer } from './pool-server.ts'

describe('McpPoolServer dual-era HTTP compatibility', () => {
  it('serves modern auto-negotiation and a legacy initialize client from one endpoint', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const pool = {
      getProxyToolDefs: () => [{
        name: 'mcp__demo__echo',
        description: 'Echo a value',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
        },
      }],
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args })
        return { content: String(args.value ?? ''), isError: false }
      },
    } as unknown as McpClientPool

    const server = new McpPoolServer(pool)
    const legacy = new LegacyClient(
      { name: 'legacy-test', version: '1.0.0' },
      { capabilities: {} },
    )
    let modern: CraftMcpClient | undefined

    try {
      const url = await server.start()
      modern = new CraftMcpClient({ transport: 'http', url })
      await modern.connect()
      expect(modern.getProtocolEra()).toBe('modern')
      expect(modern.getNegotiatedProtocolVersion()).toBe('2026-07-28')
      expect((await modern.listTools()).map((tool) => tool.name)).toEqual(['demo__echo'])
      const modernResult = await modern.callTool('demo__echo', { value: 'modern' }) as {
        content: Array<{ type: string; text: string }>
      }
      expect(modernResult.content).toEqual([{ type: 'text', text: 'modern' }])

      await legacy.connect(new LegacyHttpTransport(new URL(url)))
      expect((await legacy.listTools()).tools.map((tool) => tool.name)).toEqual(['demo__echo'])
      const legacyResult = await legacy.callTool({
        name: 'demo__echo',
        arguments: { value: 'legacy' },
      })
      expect(legacyResult.content).toEqual([{ type: 'text', text: 'legacy' }])

      expect(calls).toEqual([
        { name: 'mcp__demo__echo', args: { value: 'modern' } },
        { name: 'mcp__demo__echo', args: { value: 'legacy' } },
      ])
    } finally {
      await Promise.allSettled([
        modern?.close() ?? Promise.resolve(),
        legacy.close(),
      ])
      await server.stop()
    }
  })
})
