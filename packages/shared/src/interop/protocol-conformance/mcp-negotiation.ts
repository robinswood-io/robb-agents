import { MCP_MODERN_PROTOCOL_VERSION, MCP_TASKS_EXTENSION } from "../../mcp/protocol-eras.ts";
import type { McpTasksConformanceInput } from './legacy-mcp.ts';
import type { InteropConformanceHttpResponse, McpConformanceEra } from './probe-types.ts';
import { authorizationHeaders, hasModernCacheContract, jsonRpcError, jsonRpcResult, parseJsonOrSse, recordValue, stringValue } from './probe-types.ts';

export function modernRequestMeta(): Record<string, unknown> {
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

export function modernMcpHeaders(
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
export async function negotiateMcpEra(
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
