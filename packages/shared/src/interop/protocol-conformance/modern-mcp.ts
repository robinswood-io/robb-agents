import { MCP_MODERN_PROTOCOL_VERSION, MCP_TASKS_EXTENSION } from "../../mcp/protocol-eras.ts";
import type { McpTasksConformanceInput } from './legacy-mcp.ts';
import { modernMcpHeaders, modernRequestMeta } from './mcp-negotiation.ts';
import type { InteropConformanceCheck, InteropConformanceHttpResponse, InteropConformanceReport } from './probe-types.ts';
import { check, hasModernCacheContract, hasTaskTtl, isSuccessfulHttpStatus, jsonRpcResult, mcpTask, parseJsonOrSse, recordValue, report, stringValue } from './probe-types.ts';

export async function runModernMcpTasksConformance(
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
