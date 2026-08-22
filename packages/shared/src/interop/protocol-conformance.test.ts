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
      era: 'legacy',
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
    expect(report.protocolEra).toBe('legacy')
    expect(report.protocolVersion).toBe('2025-11-25')
    expect(requests.some((request) => request.headers['Mcp-Session-Id'] === 'session-1')).toBe(true)
    expect(requests.map((request) => request.body).join('')).not.toContain('tasks/resume')
  })

  test('validates MCP 2026-07-28 and the io.modelcontextprotocol/tasks polling flow', async () => {
    const requests: InteropConformanceHttpRequest[] = []
    const report = await runMcpTasksConformance({
      endpoint: 'https://modern-mcp.test/mcp',
      era: 'auto',
      authorization: 'Bearer modern-test',
      toolName: 'safe_read',
      toolArguments: { query: 'status' },
      transport: async (request) => {
        requests.push(request)
        const payload = request.body ? JSON.parse(request.body) : {}
        const id = Reflect.get(payload, 'id')
        const method = Reflect.get(payload, 'method')
        if (method === 'server/discover') {
          return response({
            jsonrpc: '2.0',
            id,
            result: {
              resultType: 'complete',
              ttlMs: 30_000,
              cacheScope: 'private',
              supportedVersions: ['2026-07-28', '2025-11-25'],
              capabilities: {
                tools: {},
                extensions: {
                  'io.modelcontextprotocol/tasks': {},
                },
              },
            },
          })
        }
        if (method === 'tools/list') {
          return response({
            jsonrpc: '2.0',
            id,
            result: {
              resultType: 'complete',
              ttlMs: 5_000,
              cacheScope: 'private',
              tools: [{
                name: 'safe_read',
                inputSchema: { type: 'object' },
              }],
            },
          })
        }
        if (method === 'tools/call') {
          return response({
            jsonrpc: '2.0',
            id,
            result: {
              resultType: 'task',
              taskId: 'task-modern-1',
              status: 'working',
              createdAt: '2026-08-20T12:00:00.000Z',
              lastUpdatedAt: '2026-08-20T12:00:00.000Z',
              ttlMs: 60_000,
              pollIntervalMs: 250,
            },
          })
        }
        if (method === 'tasks/get') {
          return response({
            jsonrpc: '2.0',
            id,
            result: {
              resultType: 'complete',
              taskId: 'task-modern-1',
              status: 'completed',
              createdAt: '2026-08-20T12:00:00.000Z',
              lastUpdatedAt: '2026-08-20T12:00:01.000Z',
              ttlMs: null,
              result: {
                resultType: 'complete',
                content: [{ type: 'text', text: 'done' }],
              },
            },
          })
        }
        throw new Error(`Unexpected method: ${String(method)}`)
      },
    })

    expect(report.passed).toBe(true)
    expect(report.protocolEra).toBe('modern')
    expect(report.protocolVersion).toBe('2026-07-28')
    expect(requests.map((request) => request.body).join('')).not.toContain('"method":"initialize"')
    expect(requests.map((request) => request.body).join('')).not.toContain('tasks/result')
    expect(requests.every((request) => request.headers['Mcp-Session-Id'] === undefined)).toBe(true)
    expect(requests.find((request) => request.headers['Mcp-Method'] === 'tasks/get')?.headers['Mcp-Name'])
      .toBe('task-modern-1')
    for (const request of requests) {
      const params = request.body ? JSON.parse(request.body).params : {}
      expect(params._meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28')
      expect(Object.hasOwn(
        params._meta['io.modelcontextprotocol/clientCapabilities'].extensions,
        'io.modelcontextprotocol/tasks',
      )).toBe(true)
    }
  })

  test('auto negotiation falls back to MCP 2025 only without valid modern evidence', async () => {
    const methods: string[] = []
    const report = await runMcpTasksConformance({
      endpoint: 'https://legacy-mcp.test/mcp',
      transport: async (request) => {
        const payload = request.body ? JSON.parse(request.body) : {}
        const id = Reflect.get(payload, 'id')
        const method = String(Reflect.get(payload, 'method'))
        methods.push(method)
        if (method === 'server/discover') {
          return response({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: 'Method not found' },
          })
        }
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
          })
        }
        if (method === 'notifications/initialized') {
          return { status: 202, headers: {}, body: '' }
        }
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
        throw new Error(`Unexpected method: ${method}`)
      },
    })

    expect(report.passed).toBe(true)
    expect(report.protocolEra).toBe('legacy')
    expect(methods).toEqual([
      'server/discover',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ])
  })

  test('auto negotiation follows one -32022 corrective modern probe', async () => {
    let discoverCount = 0
    const report = await runMcpTasksConformance({
      endpoint: 'https://corrective-modern-mcp.test/mcp',
      era: 'auto',
      transport: async (request) => {
        const payload = request.body ? JSON.parse(request.body) : {}
        const id = Reflect.get(payload, 'id')
        const method = String(Reflect.get(payload, 'method'))
        if (method === 'server/discover') {
          discoverCount++
          if (discoverCount === 1) {
            return response({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32022,
                message: 'Unsupported protocol version',
                data: { requested: '2026-07-28', supported: ['2026-07-28'] },
              },
            })
          }
          return response({ jsonrpc: '2.0', id, result: {
            resultType: 'complete', ttlMs: 0, cacheScope: 'private',
            supportedVersions: ['2026-07-28'],
            capabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } },
          } })
        }
        if (method === 'tools/list') {
          return response({ jsonrpc: '2.0', id, result: {
            resultType: 'complete', ttlMs: 0, cacheScope: 'private',
            tools: [{ name: 'safe_read', inputSchema: { type: 'object' } }],
          } })
        }
        throw new Error(`Unexpected method: ${method}`)
      },
    })

    expect(report.passed).toBe(true)
    expect(report.protocolEra).toBe('modern')
    // Corrective probe + the runner's explicit discovery contract check.
    expect(discoverCount).toBe(3)
  })

  test('submits 2026 task input through tasks/update and accepts an empty acknowledgement', async () => {
    const methods: string[] = []
    const report = await runMcpTasksConformance({
      endpoint: 'https://interactive-mcp.test/mcp',
      era: 'modern',
      toolName: 'approval_task',
      taskInputResponses: {
        approval: { action: 'accept', content: { approved: true } },
      },
      transport: async (request) => {
        const payload = request.body ? JSON.parse(request.body) : {}
        const id = Reflect.get(payload, 'id')
        const method = String(Reflect.get(payload, 'method'))
        methods.push(method)
        if (method === 'server/discover') {
          return response({ jsonrpc: '2.0', id, result: {
            resultType: 'complete', ttlMs: 0, cacheScope: 'private',
            supportedVersions: ['2026-07-28'],
            capabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } },
          } })
        }
        if (method === 'tools/list') {
          return response({ jsonrpc: '2.0', id, result: {
            resultType: 'complete', ttlMs: 0, cacheScope: 'private',
            tools: [{ name: 'approval_task', inputSchema: { type: 'object' } }],
          } })
        }
        if (method === 'tools/call') {
          return response({ jsonrpc: '2.0', id, result: {
            resultType: 'task', taskId: 'task-input', status: 'working',
            createdAt: '2026-08-20T12:00:00.000Z',
            lastUpdatedAt: '2026-08-20T12:00:00.000Z', ttlMs: 60_000,
          } })
        }
        if (method === 'tasks/get') {
          return response({ jsonrpc: '2.0', id, result: {
            resultType: 'complete', taskId: 'task-input', status: 'input_required',
            createdAt: '2026-08-20T12:00:00.000Z',
            lastUpdatedAt: '2026-08-20T12:00:01.000Z', ttlMs: 60_000,
            inputRequests: {
              approval: { method: 'elicitation/create', params: { message: 'Approve?' } },
            },
          } })
        }
        if (method === 'tasks/update') {
          expect(payload.params.inputResponses).toEqual({
            approval: { action: 'accept', content: { approved: true } },
          })
          return response({ jsonrpc: '2.0', id, result: { resultType: 'complete' } })
        }
        throw new Error(`Unexpected method: ${method}`)
      },
    })

    expect(report.passed).toBe(true)
    expect(methods).toContain('tasks/update')
    expect(methods).not.toContain('tasks/cancel')
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
