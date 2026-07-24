import { describe, expect, test } from 'bun:test'

import {
  runA2AConformance,
  runAgUiConformance,
  runMcpTasksConformance,
  type InteropConformanceHttpRequest,
  type InteropConformanceHttpResponse,
} from './protocol-conformance'

function response(
  body: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): InteropConformanceHttpResponse {
  return {
    status: 200,
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }
}

describe('external protocol conformance', () => {
  test('validates MCP Tasks 2025-11-25 against an external JSON-RPC transport', async () => {
    const requests: InteropConformanceHttpRequest[] = []
    const report = await runMcpTasksConformance({
      endpoint: 'https://external-mcp.test/mcp',
      authorization: 'Bearer test',
      toolName: 'safe_read',
      toolArguments: { query: 'status' },
      transport: async (request) => {
        requests.push(request)
        const payload = request.body ? JSON.parse(request.body) : {}
        const id = Reflect.get(payload, 'id')
        const method = Reflect.get(payload, 'method')
        if (method === 'initialize') {
          return response({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: {
                tasks: {
                  list: {},
                  cancel: {},
                  requests: { tools: { call: {} } },
                },
              },
            },
          }, {
            'content-type': 'application/json',
            'mcp-session-id': 'session-1',
          })
        }
        if (method === 'notifications/initialized') return { status: 202, headers: {}, body: '' }
        if (method === 'tools/list') {
          return response({
            jsonrpc: '2.0',
            id,
            result: {
              tools: [{
                name: 'safe_read',
                inputSchema: { type: 'object' },
                execution: { taskSupport: 'optional' },
              }],
            },
          })
        }
        if (method === 'tools/call') {
          return response({
            jsonrpc: '2.0',
            id,
            result: {
              task: {
                taskId: 'task-1',
                status: 'working',
                createdAt: '2026-07-23T12:00:00.000Z',
                lastUpdatedAt: '2026-07-23T12:00:00.000Z',
                ttl: 60_000,
              },
            },
          })
        }
        if (method === 'tasks/get') {
          return response({
            jsonrpc: '2.0',
            id,
            result: {
              taskId: 'task-1',
              status: 'working',
              createdAt: '2026-07-23T12:00:00.000Z',
              lastUpdatedAt: '2026-07-23T12:00:01.000Z',
              ttl: 60_000,
            },
          })
        }
        return response({
          jsonrpc: '2.0',
          id,
          result: {
            taskId: 'task-1',
            status: 'cancelled',
            createdAt: '2026-07-23T12:00:00.000Z',
            lastUpdatedAt: '2026-07-23T12:00:02.000Z',
            ttl: 60_000,
          },
        })
      },
    })

    expect(report.passed).toBe(true)
    expect(requests.some((request) => request.headers['Mcp-Session-Id'] === 'session-1')).toBe(true)
    expect(requests.map((request) => request.body).join('')).not.toContain('tasks/resume')
  })

  test('validates the A2A 1.0 Agent Card and REST task endpoint', async () => {
    const requests: InteropConformanceHttpRequest[] = []
    const report = await runA2AConformance({
      baseUrl: 'https://external-a2a.test',
      authorization: 'Bearer test',
      message: 'Return current status',
      transport: async (request) => {
        requests.push(request)
        if (request.url.endsWith('/.well-known/agent-card.json')) {
          return response({
            name: 'External Agent',
            supportedInterfaces: [{
              url: 'https://external-a2a.test/a2a',
              protocolBinding: 'HTTP+JSON',
              protocolVersion: '1.0',
            }],
            capabilities: { streaming: true },
            securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
            skills: [],
          })
        }
        if (request.url.endsWith('/message:send')) {
          return response({
            task: {
              id: 'task-1',
              status: { state: 'TASK_STATE_WORKING' },
            },
          })
        }
        return response({
          id: 'task-1',
          status: { state: 'TASK_STATE_COMPLETED' },
        })
      },
    })

    expect(report.passed).toBe(true)
    expect(requests.filter((request) => request.headers['A2A-Version'] === '1.0')).toHaveLength(3)
  })

  test('validates AG-UI event ordering, messages and RFC 6902 deltas', async () => {
    const eventBody = [
      { type: 'RUN_STARTED', threadId: 'thread-1', runId: 'run-1' },
      { type: 'TEXT_MESSAGE_START', messageId: 'message-1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'message-1', delta: 'OK' },
      { type: 'TEXT_MESSAGE_END', messageId: 'message-1' },
      { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/status', value: 'done' }] },
      { type: 'RUN_FINISHED', threadId: 'thread-1', runId: 'run-1' },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
    const report = await runAgUiConformance({
      endpoint: 'https://external-ag-ui.test/agent',
      transport: async () => response(eventBody, { 'content-type': 'text/event-stream' }),
    })

    expect(report.passed).toBe(true)
    expect(report.checks.map((check) => check.name)).toContain('text message lifecycle')
  })

  test('rejects malformed external streams instead of normalizing them', async () => {
    const report = await runAgUiConformance({
      endpoint: 'https://external-ag-ui.test/agent',
      transport: async () => response(
        [
          'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"missing-start","delta":""}',
          'data: {"type":"THINKING_START"}',
          'data: {"type":"RUN_FINISHED","threadId":"t","runId":"r"}',
          '',
        ].join('\n\n'),
        { 'content-type': 'text/event-stream' },
      ),
    })
    expect(report.passed).toBe(false)
    expect(report.checks.find((check) => check.name === 'deprecated events')?.passed).toBe(false)
    expect(report.checks.find((check) => check.name === 'text message lifecycle')?.passed).toBe(false)
  })
})
