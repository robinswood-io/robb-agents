#!/usr/bin/env node
// Minimal spec-compliant MCP stdio server for tests.
// Newline-delimited JSON-RPC on stdout, as the MCP stdio spec requires.

import { parseRequest } from './fixture-json.ts'
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })

const PROTOCOL_VERSION = '2025-11-25'

const send = (msg: object) => {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

rl.on('line', (line) => {
  const req = parseRequest(line)
  if (!req) return
  if (req['method'] === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req['id'],
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-server-good', version: '1.0.0' },
      },
    })
    return
  }
  if (req['method'] === 'notifications/initialized') {
    // Notification — no response required.
    return
  }
  if (req['method'] === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: req['id'],
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo input back',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      },
    })
    return
  }
  // Unknown method — return method-not-found error.
  if (typeof req['id'] !== 'undefined') {
    send({
      jsonrpc: '2.0',
      id: req['id'],
      error: { code: -32601, message: 'Method not found' },
    })
  }
})
