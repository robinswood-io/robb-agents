import { MCP_LEGACY_PROTOCOL_VERSION } from "../../mcp/protocol-eras.ts";
import type { InteropConformanceCheck, InteropConformanceHttpResponse, InteropConformanceReport, InteropConformanceTransport, McpConformanceEra } from './probe-types.ts';
import { authorizationHeaders, check, hasTaskTtl, isSuccessfulHttpStatus, jsonRpcResult, mcpTask, parseJsonOrSse, recordValue, report, stringValue } from './probe-types.ts';

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

export async function runLegacyMcpTasksConformance(
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
