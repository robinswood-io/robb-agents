import { MCP_LEGACY_PROTOCOL_VERSION, type McpWireEra } from "../../mcp/protocol-eras.ts";

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

export function endpointUrl(value: string): URL {
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

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function parseJsonOrSse(body: string): unknown {
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

export function parseSseEvents(body: string): Record<string, unknown>[] {
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

export function report(
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

export function check(
  checks: InteropConformanceCheck[],
  name: string,
  passed: boolean,
  detail: string,
): void {
  checks.push({ name, passed, detail })
}

export function authorizationHeaders(authorization?: string): Record<string, string> {
  return authorization ? { Authorization: authorization } : {}
}

export function jsonRpcResult(value: unknown): Record<string, unknown> | null {
  const envelope = recordValue(value)
  if (!envelope || envelope.jsonrpc !== '2.0' || Reflect.has(envelope, 'error')) return null
  return recordValue(envelope.result)
}

const mcpTaskStatuses = new Set(['working', 'input_required', 'completed', 'failed', 'cancelled'])

export function mcpTask(value: unknown): Record<string, unknown> | null {
  const candidate = recordValue(value)
  if (!candidate) return null
  const status = stringValue(candidate.status)
  return stringValue(candidate.taskId) && status && mcpTaskStatuses.has(status) ? candidate : null
}

export function jsonRpcError(value: unknown): Record<string, unknown> | null {
  const envelope = recordValue(value)
  return envelope?.jsonrpc === '2.0' ? recordValue(envelope.error) : null
}

export function isSuccessfulHttpStatus(status: number): boolean {
  return status >= 200 && status < 300
}

export function hasModernCacheContract(value: Record<string, unknown> | null): boolean {
  return Boolean(
    value
    && Number.isSafeInteger(value.ttlMs)
    && Number(value.ttlMs) >= 0
    && (value.cacheScope === 'public' || value.cacheScope === 'private'),
  )
}

export function hasTaskTtl(value: Record<string, unknown> | null, property: 'ttl' | 'ttlMs'): boolean {
  if (!value || !Reflect.has(value, property)) return false
  const ttl = value[property]
  return property === 'ttlMs'
    ? ttl === null || (Number.isSafeInteger(ttl) && Number(ttl) >= 0)
    : Number.isSafeInteger(ttl) && Number(ttl) >= 0
}
