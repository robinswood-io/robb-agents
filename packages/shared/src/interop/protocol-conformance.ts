import { randomUUID } from 'node:crypto'

export const MCP_TASKS_PROTOCOL_VERSION = '2025-11-25'
export const A2A_PROTOCOL_VERSION = '1.0'

export type ExternalInteropProtocol = 'mcp-tasks' | 'a2a' | 'ag-ui'

export interface InteropConformanceHttpRequest {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
}

export interface InteropConformanceHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export type InteropConformanceTransport = (
  request: InteropConformanceHttpRequest,
) => Promise<InteropConformanceHttpResponse>

export interface InteropConformanceCheck {
  name: string
  passed: boolean
  detail: string
}

export interface InteropConformanceReport {
  protocol: ExternalInteropProtocol
  implementation: string
  passed: boolean
  checks: InteropConformanceCheck[]
}

function endpointUrl(value: string): URL {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    throw new Error('Interop endpoint must be an absolute URL')
  }
  if (
    endpoint.protocol !== 'https:'
    && endpoint.hostname !== '127.0.0.1'
    && endpoint.hostname !== 'localhost'
  ) {
    throw new Error('Interop endpoint must use HTTPS or an explicit loopback host')
  }
  return endpoint
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function parseJsonOrSse(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    const dataLines = body
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .filter((line) => line && line !== '[DONE]')
    if (dataLines.length === 0) throw new Error('Response is neither JSON nor an SSE data event')
    return JSON.parse(dataLines.at(-1) ?? '')
  }
}

function parseSseEvents(body: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  for (const line of body.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (!payload || payload === '[DONE]') continue
    const parsed: unknown = JSON.parse(payload)
    const event = recordValue(parsed)
    if (!event) throw new Error('SSE data event must contain a JSON object')
    events.push(event)
  }
  return events
}

function report(
  protocol: ExternalInteropProtocol,
  implementation: string,
  checks: InteropConformanceCheck[],
): InteropConformanceReport {
  return {
    protocol,
    implementation,
    passed: checks.every((check) => check.passed),
    checks,
  }
}

function check(
  checks: InteropConformanceCheck[],
  name: string,
  passed: boolean,
  detail: string,
): void {
  checks.push({ name, passed, detail })
}

function authorizationHeaders(authorization?: string): Record<string, string> {
  return authorization ? { Authorization: authorization } : {}
}

function jsonRpcResult(value: unknown): Record<string, unknown> | null {
  const envelope = recordValue(value)
  if (!envelope || envelope.jsonrpc !== '2.0' || Reflect.has(envelope, 'error')) return null
  return recordValue(envelope.result)
}

function mcpTask(value: unknown): Record<string, unknown> | null {
  const candidate = recordValue(value)
  if (!candidate) return null
  const status = stringValue(candidate.status)
  const statuses = new Set(['working', 'input_required', 'completed', 'failed', 'cancelled'])
  return stringValue(candidate.taskId) && status && statuses.has(status) ? candidate : null
}

export async function runMcpTasksConformance(input: {
  endpoint: string
  authorization?: string
  transport: InteropConformanceTransport
  toolName?: string
  toolArguments?: Record<string, unknown>
  timeoutMs?: number
}): Promise<InteropConformanceReport> {
  const endpoint = endpointUrl(input.endpoint).toString()
  const timeoutMs = input.timeoutMs ?? 15_000
  const checks: InteropConformanceCheck[] = []
  let requestId = 0
  let sessionId: string | undefined
  const send = async (
    method: string,
    params: Record<string, unknown>,
    notification = false,
  ): Promise<{ response: InteropConformanceHttpResponse; value: unknown }> => {
    const payload: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
      params,
    }
    if (!notification) payload.id = ++requestId
    const response = await input.transport({
      method: 'POST',
      url: endpoint,
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...authorizationHeaders(input.authorization),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify(payload),
      timeoutMs,
    })
    sessionId = response.headers['mcp-session-id'] ?? sessionId
    return {
      response,
      value: response.body.trim() ? parseJsonOrSse(response.body) : null,
    }
  }

  try {
    const initialized = await send('initialize', {
      protocolVersion: MCP_TASKS_PROTOCOL_VERSION,
      capabilities: {
        tasks: {
          list: {},
          cancel: {},
        },
      },
      clientInfo: {
        name: 'Robb Agents external conformance',
        version: '1.0.0',
      },
    })
    const initializeResult = jsonRpcResult(initialized.value)
    check(
      checks,
      'initialize',
      initialized.response.status >= 200
        && initialized.response.status < 300
        && initializeResult?.protocolVersion === MCP_TASKS_PROTOCOL_VERSION,
      'server negotiates MCP 2025-11-25',
    )
    const capabilities = recordValue(initializeResult?.capabilities)
    const tasks = recordValue(capabilities?.tasks)
    const requests = recordValue(tasks?.requests)
    const tools = recordValue(requests?.tools)
    check(
      checks,
      'tasks capability',
      Boolean(tasks && recordValue(tasks.list) && recordValue(tasks.cancel)),
      'server declares tasks.list and tasks.cancel',
    )
    check(
      checks,
      'task-augmented tools',
      Boolean(recordValue(tools?.call)),
      'server declares tasks.requests.tools.call',
    )
    await send('notifications/initialized', {}, true)

    const listedTools = await send('tools/list', {})
    const toolsResult = jsonRpcResult(listedTools.value)
    const toolList = Array.isArray(toolsResult?.tools) ? toolsResult.tools : []
    check(checks, 'tools/list', toolList.length > 0, 'server returns at least one tool')
    const taskTools = toolList
      .map(recordValue)
      .filter((tool): tool is Record<string, unknown> => Boolean(tool))
      .filter((tool) => {
        const execution = recordValue(tool.execution)
        return execution?.taskSupport === 'required' || execution?.taskSupport === 'optional'
      })
    check(
      checks,
      'tool taskSupport',
      taskTools.length > 0,
      'at least one tool explicitly allows or requires task execution',
    )

    if (input.toolName) {
      const tool = taskTools.find((candidate) => candidate.name === input.toolName)
      check(
        checks,
        'configured task tool',
        Boolean(tool),
        `configured safe tool ${input.toolName} advertises taskSupport`,
      )
      if (tool) {
        const created = await send('tools/call', {
          name: input.toolName,
          arguments: input.toolArguments ?? {},
          task: { ttl: 60_000 },
        })
        const createResult = jsonRpcResult(created.value)
        const createdTask = mcpTask(createResult?.task)
        check(
          checks,
          'task creation',
          createdTask?.status === 'working',
          'task-augmented tools/call returns a receiver-generated working task',
        )
        const taskId = stringValue(createdTask?.taskId)
        if (taskId) {
          const fetched = await send('tasks/get', { taskId })
          const fetchedTask = mcpTask(jsonRpcResult(fetched.value))
          check(
            checks,
            'tasks/get',
            Boolean(fetchedTask && fetchedTask.taskId === taskId && Reflect.has(fetchedTask, 'ttl')),
            'tasks/get returns the same task with an explicit TTL',
          )
          if (fetchedTask?.status === 'completed') {
            const taskResult = await send('tasks/result', { taskId })
            const resultValue = jsonRpcResult(taskResult.value)
            const metadata = recordValue(resultValue?._meta)
            const related = recordValue(metadata?.['io.modelcontextprotocol/related-task'])
            check(
              checks,
              'tasks/result relation',
              related?.taskId === taskId,
              'terminal result carries io.modelcontextprotocol/related-task metadata',
            )
          } else if (fetchedTask?.status === 'working' || fetchedTask?.status === 'input_required') {
            const cancelled = await send('tasks/cancel', { taskId })
            const cancelledTask = mcpTask(jsonRpcResult(cancelled.value))
            check(
              checks,
              'tasks/cancel',
              cancelledTask?.status === 'cancelled',
              'non-terminal task transitions to cancelled',
            )
          }
        }
      }
    }
  } catch (error) {
    check(checks, 'transport', false, error instanceof Error ? error.message : String(error))
  }
  return report('mcp-tasks', endpoint, checks)
}

const a2aTaskStates = new Set([
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
])

function a2aTask(value: unknown): Record<string, unknown> | null {
  const candidate = recordValue(value)
  const status = recordValue(candidate?.status)
  return candidate
    && stringValue(candidate.id)
    && stringValue(status?.state)
    && a2aTaskStates.has(String(status?.state))
    ? candidate
    : null
}

export async function runA2AConformance(input: {
  baseUrl: string
  authorization?: string
  transport: InteropConformanceTransport
  message?: string
  timeoutMs?: number
}): Promise<InteropConformanceReport> {
  const base = endpointUrl(input.baseUrl)
  const timeoutMs = input.timeoutMs ?? 15_000
  const checks: InteropConformanceCheck[] = []
  const headers = {
    Accept: 'application/a2a+json, application/json',
    'A2A-Version': A2A_PROTOCOL_VERSION,
    ...authorizationHeaders(input.authorization),
  }
  try {
    const cardUrl = new URL('/.well-known/agent-card.json', base).toString()
    const cardResponse = await input.transport({
      method: 'GET',
      url: cardUrl,
      headers,
      timeoutMs,
    })
    const card = recordValue(parseJsonOrSse(cardResponse.body))
    check(
      checks,
      'agent card',
      cardResponse.status >= 200 && cardResponse.status < 300 && Boolean(stringValue(card?.name)),
      'well-known endpoint returns a named Agent Card',
    )
    const interfaces = Array.isArray(card?.supportedInterfaces) ? card.supportedInterfaces : []
    const preferred = recordValue(interfaces[0])
    check(
      checks,
      'supported interface',
      preferred?.protocolBinding === 'HTTP+JSON'
        && preferred?.protocolVersion === A2A_PROTOCOL_VERSION
        && Boolean(stringValue(preferred?.url)),
      'preferred interface declares HTTP+JSON version 1.0 and its URL',
    )
    check(
      checks,
      'security declaration',
      Boolean(recordValue(card?.securitySchemes)),
      'Agent Card declares its security schemes without credentials',
    )

    if (input.message) {
      const preferredUrl = stringValue(preferred?.url)
      const serviceBase = endpointUrl(preferredUrl ?? base.toString())
      const sendUrl = new URL(`${serviceBase.pathname.replace(/\/+$/u, '')}/message:send`, serviceBase)
      const response = await input.transport({
        method: 'POST',
        url: sendUrl.toString(),
        headers: {
          ...headers,
          'Content-Type': 'application/a2a+json',
        },
        body: JSON.stringify({
          message: {
            messageId: randomUUID(),
            role: 'ROLE_USER',
            parts: [{ text: input.message }],
          },
          configuration: {
            acceptedOutputModes: ['text/plain', 'application/json'],
          },
        }),
        timeoutMs,
      })
      const sendResult = recordValue(parseJsonOrSse(response.body))
      const task = a2aTask(sendResult?.task ?? sendResult)
      const message = recordValue(sendResult?.message ?? sendResult)
      check(
        checks,
        'message:send',
        response.status >= 200
          && response.status < 300
          && Boolean(task || stringValue(message?.messageId)),
        'message:send returns a valid task or message',
      )
      if (task) {
        const taskId = stringValue(task.id)
        if (taskId) {
          const taskUrl = new URL(`${serviceBase.pathname.replace(/\/+$/u, '')}/tasks/${encodeURIComponent(taskId)}`, serviceBase)
          const taskResponse = await input.transport({
            method: 'GET',
            url: taskUrl.toString(),
            headers,
            timeoutMs,
          })
          check(
            checks,
            'tasks/{id}',
            taskResponse.status >= 200
              && taskResponse.status < 300
              && Boolean(a2aTask(parseJsonOrSse(taskResponse.body))),
            'task status is retrievable using the versioned REST binding',
          )
        }
      }
    }
  } catch (error) {
    check(checks, 'transport', false, error instanceof Error ? error.message : String(error))
  }
  return report('a2a', base.toString(), checks)
}

function validateAgUiSequence(events: Record<string, unknown>[], checks: InteropConformanceCheck[]): void {
  const types = events.map((event) => stringValue(event.type)).filter((type): type is string => Boolean(type))
  check(checks, 'event stream', events.length > 0, 'SSE stream contains JSON events')
  check(checks, 'run start', types[0] === 'RUN_STARTED', 'first event is RUN_STARTED')
  check(
    checks,
    'run terminal',
    types.at(-1) === 'RUN_FINISHED' || types.at(-1) === 'RUN_ERROR',
    'last event is RUN_FINISHED or RUN_ERROR',
  )
  check(
    checks,
    'deprecated events',
    !types.some((type) => type.startsWith('THINKING_')),
    'stream does not use deprecated THINKING_* events',
  )

  const openMessages = new Set<string>()
  let validMessages = true
  let validStateDeltas = true
  for (const event of events) {
    const type = stringValue(event.type)
    const messageId = stringValue(event.messageId)
    if (type === 'TEXT_MESSAGE_START') {
      validMessages = validMessages && Boolean(messageId) && event.role === 'assistant'
      if (messageId) openMessages.add(messageId)
    }
    if (type === 'TEXT_MESSAGE_CONTENT') {
      validMessages = validMessages
        && Boolean(messageId && openMessages.has(messageId))
        && Boolean(stringValue(event.delta))
    }
    if (type === 'TEXT_MESSAGE_END') {
      validMessages = validMessages && Boolean(messageId && openMessages.delete(messageId))
    }
    if (type === 'STATE_DELTA') {
      const delta = event.delta
      validStateDeltas = validStateDeltas
        && Array.isArray(delta)
        && delta.every((operation) => {
          const patch = recordValue(operation)
          return Boolean(
            patch
            && ['add', 'remove', 'replace', 'move', 'copy', 'test'].includes(String(patch.op))
            && typeof patch.path === 'string',
          )
        })
    }
  }
  check(
    checks,
    'text message lifecycle',
    validMessages && openMessages.size === 0,
    'TEXT_MESSAGE_START/CONTENT/END events are balanced with non-empty deltas',
  )
  check(
    checks,
    'state delta',
    validStateDeltas,
    'STATE_DELTA events use RFC 6902 operation arrays',
  )
}

export async function runAgUiConformance(input: {
  endpoint: string
  authorization?: string
  transport: InteropConformanceTransport
  message?: string
  timeoutMs?: number
}): Promise<InteropConformanceReport> {
  const endpoint = endpointUrl(input.endpoint).toString()
  const timeoutMs = input.timeoutMs ?? 30_000
  const checks: InteropConformanceCheck[] = []
  try {
    const response = await input.transport({
      method: 'POST',
      url: endpoint,
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        ...authorizationHeaders(input.authorization),
      },
      body: JSON.stringify({
        threadId: randomUUID(),
        runId: randomUUID(),
        state: {},
        messages: [{
          id: randomUUID(),
          role: 'user',
          content: input.message ?? 'Reply with the single word OK.',
        }],
        tools: [],
        context: [],
        forwardedProps: {
          conformanceProbe: true,
        },
      }),
      timeoutMs,
    })
    const contentType = response.headers['content-type'] ?? ''
    check(
      checks,
      'SSE response',
      response.status >= 200
        && response.status < 300
        && contentType.includes('text/event-stream'),
      'endpoint returns a successful text/event-stream response',
    )
    validateAgUiSequence(parseSseEvents(response.body), checks)
  } catch (error) {
    check(checks, 'transport', false, error instanceof Error ? error.message : String(error))
  }
  return report('ag-ui', endpoint, checks)
}

export const fetchInteropConformanceTransport: InteropConformanceTransport = async (request) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    })
    return {
      status: response.status,
      headers: Object.fromEntries(
        [...response.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]),
      ),
      body: await response.text(),
    }
  } finally {
    clearTimeout(timeout)
  }
}
