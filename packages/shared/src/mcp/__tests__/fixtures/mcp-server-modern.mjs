#!/usr/bin/env node
// Minimal 2026-07-28-only MCP server. It deliberately rejects the legacy
// initialize opening so the validator test proves modern discovery was used.

import { Server } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

function createServer() {
  const server = new Server(
    { name: 'mcp-server-modern', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler('tools/list', async () => ({
    tools: [
      {
        name: 'modern_echo',
        description: 'Echo input on the modern MCP era',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ],
  }))

  return server
}

serveStdio(createServer, { legacy: 'reject' })
