import {
  fetchInteropConformanceTransport,
  runA2AConformance,
  runAgUiConformance,
  runMcpTasksConformance,
  type ExternalInteropProtocol,
  type InteropConformanceReport,
  type McpConformanceEra,
} from '../packages/shared/src/interop/protocol-conformance'

function protocol(value: string | undefined): ExternalInteropProtocol {
  if (value === 'mcp-tasks' || value === 'a2a' || value === 'ag-ui') return value
  throw new Error('ROBB_INTEROP_PROTOCOL must be mcp-tasks, a2a, or ag-ui')
}

function mcpEra(value: string | undefined): McpConformanceEra {
  if (value === undefined || value === 'auto' || value === 'legacy' || value === 'modern') {
    return value ?? 'auto'
  }
  throw new Error('ROBB_INTEROP_MCP_ERA must be auto, legacy, or modern')
}

async function execute(): Promise<InteropConformanceReport> {
  const selected = protocol(process.env.ROBB_INTEROP_PROTOCOL)
  const endpoint = process.env.ROBB_INTEROP_ENDPOINT
  if (!endpoint) throw new Error('ROBB_INTEROP_ENDPOINT is required')
  const bearerToken = process.env.ROBB_INTEROP_BEARER_TOKEN
  const authorization = bearerToken ? `Bearer ${bearerToken}` : undefined
  if (selected === 'mcp-tasks') {
    const toolArguments = process.env.ROBB_INTEROP_TOOL_ARGUMENTS
      ? JSON.parse(process.env.ROBB_INTEROP_TOOL_ARGUMENTS)
      : undefined
    const taskInputResponses = process.env.ROBB_INTEROP_TASK_INPUT_RESPONSES
      ? JSON.parse(process.env.ROBB_INTEROP_TASK_INPUT_RESPONSES)
      : undefined
    return runMcpTasksConformance({
      endpoint,
      authorization,
      transport: fetchInteropConformanceTransport,
      era: mcpEra(process.env.ROBB_INTEROP_MCP_ERA),
      toolName: process.env.ROBB_INTEROP_TOOL_NAME,
      toolArguments,
      taskInputResponses,
    })
  }
  if (selected === 'a2a') {
    return runA2AConformance({
      baseUrl: endpoint,
      authorization,
      transport: fetchInteropConformanceTransport,
      message: process.env.ROBB_INTEROP_EXECUTE === '1'
        ? (process.env.ROBB_INTEROP_MESSAGE ?? 'Return the current service status.')
        : undefined,
    })
  }
  return runAgUiConformance({
    endpoint,
    authorization,
    transport: fetchInteropConformanceTransport,
    message: process.env.ROBB_INTEROP_MESSAGE,
  })
}

const result = await execute()
console.log(JSON.stringify(result, null, 2))
if (!result.passed) process.exitCode = 1
