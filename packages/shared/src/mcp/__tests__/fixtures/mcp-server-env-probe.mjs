#!/usr/bin/env node
// Minimal MCP server that exposes selected environment values to its test.

import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

rl.on('line', (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }

  if (request.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-server-env-probe', version: '1.0.0' },
      },
    })
    return
  }

  if (request.method === 'notifications/initialized') return

  if (request.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [{
          name: 'read_env',
          description: 'Read selected environment variables for a boundary test',
          inputSchema: {
            type: 'object',
            properties: {
              keys: { type: 'array', items: { type: 'string' } },
            },
            required: ['keys'],
          },
        }],
      },
    })
    return
  }

  if (request.method === 'tools/call' && request.params?.name === 'read_env') {
    const values = Object.fromEntries(
      (request.params.arguments?.keys || []).map((key) => [key, process.env[key] ?? null]),
    )
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(values) }],
      },
    })
    return
  }

  if (typeof request.id !== 'undefined') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: 'Method not found' },
    })
  }
})
