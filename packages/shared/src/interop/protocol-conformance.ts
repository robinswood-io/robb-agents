import { randomUUID } from 'node:crypto'

import {
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_TASKS_EXTENSION,
  type McpWireEra,
} from '../mcp/protocol-eras.ts'

export {
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_TASKS_EXTENSION,
} from '../mcp/protocol-eras.ts'
/** @deprecated Use MCP_LEGACY_PROTOCOL_VERSION or MCP_MODERN_PROTOCOL_VERSION explicitly. */
export const MCP_TASKS_PROTOCOL_VERSION = MCP_LEGACY_PROTOCOL_VERSION
export const A2A_PROTOCOL_VERSION = '1.0'

export type McpConformanceEra = 'auto' | McpWireEra

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
  /** Present for MCP reports so CI records the actually exercised wire era. */
  protocolEra?: Exclude<McpConformanceEra, 'auto'>
  protocolVersion?: string
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
  mcp?: {
    protocolEra: Exclude<McpConformanceEra, 'auto'>
    protocolVersion: string
  },
): InteropConformanceReport {
  return {
    protocol,
    implementation,
    passed: checks.every((check) => check.passed),
    checks,
    ...mcp,
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

const mcpTaskStatuses = new Set(['working', 'input_required', 'completed', 'failed', 'cancelled'])

function mcpTask(value: unknown): Record<string, unknown> | null {
  const candidate = recordValue(value)
  if (!candidate) return null
  const status = stringValue(candidate.status)
  return stringValue(candidate.taskId) && status && mcpTaskStatuses.has(status) ? candidate : null
}

function jsonRpcError(value: unknown): Record<string, unknown> | null {
  const envelope = recordValue(value)
  return envelope?.jsonrpc === '2.0' ? recordValue(envelope.error) : null
}

function isSuccessfulHttpStatus(status: number): boolean {
  return status >= 200 && status < 300
}

function hasModernCacheContract(value: Record<string, unknown> | null): boolean {
  return Boolean(
    value
    && Number.isSafeInteger(value.ttlMs)
    && Number(value.ttlMs) >= 0
    && (value.cacheScope === 'public' || value.cacheScope === 'private'),
  )
}

function hasTaskTtl(value: Record<string, unknown> | null, property: 'ttl' | 'ttlMs'): boolean {
  if (!value || !Reflect.has(value, property)) return false
  const ttl = value[property]
  return property === 'ttlMs'
    ? ttl === null || (Number.isSafeInteger(ttl) && Number(ttl) >= 0)
    : Number.isSafeInteger(ttl) && Number(ttl) >= 0
}

export interface McpTasksConformanceInput {
  endpoint: string
  authorization?: string
  transport: InteropConformanceTransport
  /** Auto probes 2026-07-28 and uses the legacy initialize flow only without modern evidence. */
  era?: McpConformanceEra
  toolName?: string
  toolArguments?: Record<string, unknown>
  /** Responses keyed by tasks/get inputRequests keys, used only by the 2026 Tasks extension. */
  taskInputResponses?: Record<string, unknown>
  timeoutMs?: number
}

async function runLegacyMcpTasksConformance(
  input: McpTasksConformanceInput,
  endpoint: string,
  timeoutMs: number,
): Promise<InteropConformanceReport> {
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
    sessionId = response.headers['mcp-session-id']
      ?? response.headers['Mcp-Session-Id']
      ?? sessionId
    return {
      response,
      value: response.body.trim() ? parseJsonOrSse(response.body) : null,
    }
  }

  try {
    const initialized = await send('initialize', {
      protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
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
      isSuccessfulHttpStatus(initialized.response.status)
        && initializeResult?.protocolVersion === MCP_LEGACY_PROTOCOL_VERSION,
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
            Boolean(fetchedTask && fetchedTask.taskId === taskId && hasTaskTtl(fetchedTask, 'ttl')),
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
  return report('mcp-tasks', endpoint, checks, {
    protocolEra: 'legacy',
    protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
  })
}

function modernRequestMeta(): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': MCP_MODERN_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': {
      name: 'Robb Agents external conformance',
      version: '1.0.0',
    },
    'io.modelcontextprotocol/clientCapabilities': {
      extensions: {
        [MCP_TASKS_EXTENSION]: {},
      },
    },
  }
}

function modernMcpHeaders(
  method: string,
  params: Record<string, unknown>,
  authorization?: string,
): Record<string, string> {
  const routingName = method === 'tools/call'
    ? stringValue(params.name)
    : method.startsWith('tasks/')
      ? stringValue(params.taskId)
      : null
  return {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': MCP_MODERN_PROTOCOL_VERSION,
    'Mcp-Method': method,
    ...(routingName ? { 'Mcp-Name': routingName } : {}),
    ...authorizationHeaders(authorization),
  }
}

async function sendModernProbe(
  input: McpTasksConformanceInput,
  endpoint: string,
  timeoutMs: number,
): Promise<InteropConformanceHttpResponse> {
  const params = { _meta: modernRequestMeta() }
  return input.transport({
    method: 'POST',
    url: endpoint,
    headers: modernMcpHeaders('server/discover', params, input.authorization),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params,
    }),
    timeoutMs,
  })
}

/**
 * Mirror the official v2 client's conservative auto negotiation: valid modern
 * discovery is positive evidence; an ordinary RPC/4xx response without that
 * evidence falls back to 2025, while authentication, 5xx and network failures
 * remain real failures rather than being hidden by a legacy retry.
 */
async function negotiateMcpEra(
  input: McpTasksConformanceInput,
  endpoint: string,
  timeoutMs: number,
): Promise<Exclude<McpConformanceEra, 'auto'>> {
  let correctiveUsed = false
  for (;;) {
    const response = await sendModernProbe(input, endpoint, timeoutMs)
    if (response.status === 401 || response.status === 403) {
      throw new Error(`MCP version negotiation requires authorization (HTTP ${response.status})`)
    }
    if (response.status >= 500) {
      throw new Error(`MCP version negotiation failed with HTTP ${response.status}`)
    }
    if (!response.body.trim()) return 'legacy'

    let value: unknown
    try {
      value = parseJsonOrSse(response.body)
    } catch {
      return 'legacy'
    }
    const result = jsonRpcResult(value)
    const supportedVersions = Array.isArray(result?.supportedVersions)
      ? result.supportedVersions.filter((version): version is string => typeof version === 'string')
      : []
    if (
      result?.resultType === 'complete'
      && supportedVersions.includes(MCP_MODERN_PROTOCOL_VERSION)
      && hasModernCacheContract(result)
    ) {
      return 'modern'
    }

    const rpcError = jsonRpcError(value)
    if (rpcError?.code !== -32022) return 'legacy'

    const data = recordValue(rpcError.data)
    const supported = Array.isArray(data?.supported)
      ? data.supported.filter((version): version is string => typeof version === 'string')
      : []
    if (supported.includes(MCP_MODERN_PROTOCOL_VERSION)) {
      // The 2026 negotiation contract permits one select-and-continue retry
      // after UnsupportedProtocolVersion advertises a mutual revision.
      if (correctiveUsed) {
        throw new Error('Server rejected the corrective MCP 2026-07-28 probe')
      }
      correctiveUsed = true
      continue
    }
    if (supported.some((version) => version >= MCP_MODERN_PROTOCOL_VERSION)) {
      throw new Error(
        `Server offers modern MCP revisions without a mutual version: ${supported.join(', ')}`,
      )
    }
    return 'legacy'
  }
}

async function runModernMcpTasksConformance(
  input: McpTasksConformanceInput,
  endpoint: string,
  timeoutMs: number,
): Promise<InteropConformanceReport> {
  const checks: InteropConformanceCheck[] = []
  let requestId = 0
  const send = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ response: InteropConformanceHttpResponse; value: unknown }> => {
    const existingMeta = recordValue(params._meta) ?? {}
    const modernParams = {
      ...params,
      _meta: {
        ...existingMeta,
        ...modernRequestMeta(),
      },
    }
    const response = await input.transport({
      method: 'POST',
      url: endpoint,
      headers: modernMcpHeaders(method, modernParams, input.authorization),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++requestId,
        method,
        params: modernParams,
      }),
      timeoutMs,
    })
    return {
      response,
      value: response.body.trim() ? parseJsonOrSse(response.body) : null,
    }
  }

  const cancelTask = async (taskId: string): Promise<void> => {
    const cancelled = await send('tasks/cancel', { taskId })
    const cancelResult = jsonRpcResult(cancelled.value)
    check(
      checks,
      'tasks/cancel',
      isSuccessfulHttpStatus(cancelled.response.status)
        && cancelResult?.resultType === 'complete',
      'cooperative cancellation is acknowledged with an empty complete result',
    )
  }

  try {
    const discovered = await send('server/discover', {})
    const discoverResult = jsonRpcResult(discovered.value)
    const supportedVersions = Array.isArray(discoverResult?.supportedVersions)
      ? discoverResult.supportedVersions
      : []
    check(
      checks,
      'server/discover',
      isSuccessfulHttpStatus(discovered.response.status)
        && discoverResult?.resultType === 'complete'
        && supportedVersions.includes(MCP_MODERN_PROTOCOL_VERSION),
      'server advertises MCP 2026-07-28 without an initialize session',
    )
    check(
      checks,
      'discover cache contract',
      hasModernCacheContract(discoverResult),
      'cacheable discovery result carries ttlMs and cacheScope',
    )
    const capabilities = recordValue(discoverResult?.capabilities)
    const extensions = recordValue(capabilities?.extensions)
    check(
      checks,
      'tasks extension capability',
      Boolean(recordValue(extensions?.[MCP_TASKS_EXTENSION])),
      `server advertises ${MCP_TASKS_EXTENSION}`,
    )

    const listedTools = await send('tools/list', {})
    const toolsResult = jsonRpcResult(listedTools.value)
    const toolList = Array.isArray(toolsResult?.tools) ? toolsResult.tools : []
    check(
      checks,
      'tools/list',
      isSuccessfulHttpStatus(listedTools.response.status)
        && toolsResult?.resultType === 'complete'
        && toolList.length > 0,
      'server returns at least one tool using a complete result',
    )
    check(
      checks,
      'tools/list cache contract',
      hasModernCacheContract(toolsResult),
      'cacheable tool list carries ttlMs and cacheScope',
    )

    if (input.toolName) {
      const configuredTool = toolList
        .map(recordValue)
        .find((tool) => tool?.name === input.toolName)
      check(
        checks,
        'configured task tool',
        Boolean(configuredTool),
        `configured safe tool ${input.toolName} is discoverable (2026 removes taskSupport)`,
      )
      if (configuredTool) {
        const created = await send('tools/call', {
          name: input.toolName,
          arguments: input.toolArguments ?? {},
        })
        const createResult = jsonRpcResult(created.value)
        const createdTask = createResult?.resultType === 'task'
          ? mcpTask(createResult)
          : null
        check(
          checks,
          'task creation',
          Boolean(createdTask && hasTaskTtl(createdTask, 'ttlMs')),
          'tools/call may return a flat io.modelcontextprotocol/tasks task result',
        )

        const taskId = stringValue(createdTask?.taskId)
        if (taskId) {
          const fetched = await send('tasks/get', { taskId })
          const fetchedResult = jsonRpcResult(fetched.value)
          const fetchedTask = fetchedResult?.resultType === 'complete'
            ? mcpTask(fetchedResult)
            : null
          check(
            checks,
            'tasks/get',
            Boolean(
              fetchedTask
              && fetchedTask.taskId === taskId
              && hasTaskTtl(fetchedTask, 'ttlMs'),
            ),
            'tasks/get returns the same detailed task with resultType complete and ttlMs',
          )

          if (fetchedTask?.status === 'completed') {
            check(
              checks,
              'completed task result',
              Reflect.has(fetchedTask, 'result'),
              'completed task embeds the original result (no tasks/result request)',
            )
          } else if (fetchedTask?.status === 'failed') {
            const taskError = recordValue(fetchedTask.error)
            check(
              checks,
              'failed task error',
              typeof taskError?.code === 'number' && Boolean(stringValue(taskError?.message)),
              'failed task embeds a JSON-RPC error',
            )
          } else if (fetchedTask?.status === 'input_required') {
            const inputRequests = recordValue(fetchedTask.inputRequests)
            check(
              checks,
              'task input requests',
              Boolean(inputRequests && Object.keys(inputRequests).length > 0),
              'input_required task exposes keyed inputRequests',
            )
            if (input.taskInputResponses) {
              const updated = await send('tasks/update', {
                taskId,
                inputResponses: input.taskInputResponses,
              })
              const updateResult = jsonRpcResult(updated.value)
              check(
                checks,
                'tasks/update',
                isSuccessfulHttpStatus(updated.response.status)
                  && updateResult?.resultType === 'complete',
                'input responses are acknowledged with an empty complete result',
              )
            } else {
              await cancelTask(taskId)
            }
          } else if (fetchedTask?.status === 'working') {
            await cancelTask(taskId)
          }
        }
      }
    }
  } catch (error) {
    check(checks, 'transport', false, error instanceof Error ? error.message : String(error))
  }

  return report('mcp-tasks', endpoint, checks, {
    protocolEra: 'modern',
    protocolVersion: MCP_MODERN_PROTOCOL_VERSION,
  })
}

export async function runMcpTasksConformance(
  input: McpTasksConformanceInput,
): Promise<InteropConformanceReport> {
  const endpoint = endpointUrl(input.endpoint).toString()
  const timeoutMs = input.timeoutMs ?? 15_000
  const requestedEra = input.era ?? 'auto'
  if (requestedEra === 'legacy') {
    return runLegacyMcpTasksConformance(input, endpoint, timeoutMs)
  }
  if (requestedEra === 'modern') {
    return runModernMcpTasksConformance(input, endpoint, timeoutMs)
  }
  try {
    const negotiatedEra = await negotiateMcpEra(input, endpoint, timeoutMs)
    return negotiatedEra === 'modern'
      ? runModernMcpTasksConformance(input, endpoint, timeoutMs)
      : runLegacyMcpTasksConformance(input, endpoint, timeoutMs)
  } catch (error) {
    const checks: InteropConformanceCheck[] = []
    check(
      checks,
      'version negotiation',
      false,
      error instanceof Error ? error.message : String(error),
    )
    return report('mcp-tasks', endpoint, checks)
  }
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
