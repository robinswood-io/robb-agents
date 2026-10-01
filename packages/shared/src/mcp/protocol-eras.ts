/** Last MCP revision in the session-oriented legacy wire era. */
export const MCP_LEGACY_PROTOCOL_VERSION = '2025-11-25' as const

/** First MCP revision in the stateless, per-request metadata wire era. */
export const MCP_MODERN_PROTOCOL_VERSION = '2026-07-28' as const

/** Official Tasks extension identifier introduced with MCP 2026-07-28. */
export const MCP_TASKS_EXTENSION = 'io.modelcontextprotocol/tasks' as const

export type McpWireEra = 'legacy' | 'modern'

export function mcpWireEraForVersion(version: string): McpWireEra {
  return version >= MCP_MODERN_PROTOCOL_VERSION ? 'modern' : 'legacy'
}
