import { isDeepStrictEqual } from 'node:util'

import type { FolderSourceConfig } from './types.ts'

export const LEGACY_SSE_TRANSPORT_ERROR =
  'Legacy MCP SSE transport cannot be created or reconfigured; use Streamable HTTP or stdio'

export interface McpTransportWriteDecision {
  allowed: boolean
  reason: 'current-transport' | 'legacy-bookkeeping' | 'legacy-sse-blocked'
}

function isLegacySse(config: FolderSourceConfig | null | undefined): boolean {
  return config?.type === 'mcp' && config.mcp?.transport === 'sse'
}

/**
 * SSE remains parseable for persisted configurations so they can be inspected
 * and migrated, but it is no longer a creation target. Existing records may
 * only receive writes that leave their MCP connection block byte-semantically
 * unchanged (status, auth bookkeeping, etc.) or migrate away from SSE.
 */
export function evaluateMcpTransportWrite(
  next: FolderSourceConfig,
  previous?: FolderSourceConfig | null,
): McpTransportWriteDecision {
  if (!isLegacySse(next)) {
    return { allowed: true, reason: 'current-transport' }
  }
  if (isLegacySse(previous) && isDeepStrictEqual(previous?.mcp, next.mcp)) {
    return { allowed: true, reason: 'legacy-bookkeeping' }
  }
  return { allowed: false, reason: 'legacy-sse-blocked' }
}

export function assertMcpTransportWriteAllowed(
  next: FolderSourceConfig,
  previous?: FolderSourceConfig | null,
): void {
  if (!evaluateMcpTransportWrite(next, previous).allowed) {
    throw new Error(LEGACY_SSE_TRANSPORT_ERROR)
  }
}
