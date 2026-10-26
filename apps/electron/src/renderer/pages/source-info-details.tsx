import { type PermissionRow, type ToolRow } from '@/components/info';
import type { LoadedSource, McpToolWithPermission } from "../../shared/types";
import type { PermissionsConfigFile } from '@craft-agent/shared/agent/modes';


export interface SourceInfoPageProps {
  sourceSlug: string
  workspaceId: string
  /** Optional callback when source is deleted */
  onDelete?: () => void
}


/**
 * Format timestamp to relative time
 */
export function formatRelativeTime(timestamp: number | undefined, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (!timestamp) return t('common.never')

  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return t('common.justNow')
  if (minutes < 60) return t('time.minutesAgo', { count: minutes })
  if (hours < 24) return t('time.hoursAgo', { count: hours })
  return t('time.daysAgo', { count: days })
}


/**
 * Get source URL for display
 */
export function getSourceUrl(source: LoadedSource): string | null {
  const { type, mcp, api, local } = source.config

  if (type === 'mcp' && mcp?.url) return mcp.url
  if (type === 'api' && api?.baseUrl) return api.baseUrl
  if (type === 'local' && local?.path) return local.path

  return null
}


/**
 * Convert permissions config to PermissionRow[] for API/local sources
 */
export function buildApiPermissionsData(config: PermissionsConfigFile): PermissionRow[] {
  const rows: PermissionRow[] = []

  // Blocked Tools
  config.blockedTools?.forEach((item) => {
    const pattern = typeof item === 'string' ? item : item.pattern
    const comment = typeof item === 'string' ? null : item.comment
    rows.push({ access: 'blocked', type: 'tool', pattern, comment })
  })

  // Allowed Bash Patterns
  config.allowedBashPatterns?.forEach((item) => {
    const pattern = typeof item === 'string' ? item : item.pattern
    const comment = typeof item === 'string' ? null : item.comment
    rows.push({ access: 'allowed', type: 'bash', pattern, comment })
  })

  // Allowed API Endpoints
  config.allowedApiEndpoints?.forEach((item) => {
    const pattern = `${item.method} ${item.path}`
    const comment = typeof item === 'object' && 'comment' in item ? item.comment : null
    rows.push({ access: 'allowed', type: 'api', pattern, comment })
  })

  return rows
}


/**
 * Convert permissions config to PermissionRow[] for MCP sources
 */
export function buildMcpPermissionsData(config: PermissionsConfigFile): PermissionRow[] {
  const rows: PermissionRow[] = []

  // Blocked Tools
  config.blockedTools?.forEach((item) => {
    const pattern = typeof item === 'string' ? item : item.pattern
    const comment = typeof item === 'string' ? null : item.comment
    rows.push({ access: 'blocked', type: 'mcp', pattern, comment })
  })

  // Allowed MCP Patterns
  config.allowedMcpPatterns?.forEach((item) => {
    const pattern = typeof item === 'string' ? item : item.pattern
    const comment = typeof item === 'string' ? null : item.comment
    rows.push({ access: 'allowed', type: 'mcp', pattern, comment })
  })

  return rows
}


/**
 * Convert MCP tools to ToolRow[]
 */
export function buildToolsData(tools: McpToolWithPermission[]): ToolRow[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    permission: tool.allowed ? 'allowed' : 'requires-permission',
  }))
}


/**
 * Get contextual description for Connection section based on source type
 */
export function getConnectionDescription(source: LoadedSource, t: (key: string) => string): string {
  const { type, mcp } = source.config

  if (type === 'mcp') {
    if (mcp?.transport === 'stdio') {
      return t('sourceInfo.localCommand')
    }
    return t('sourceInfo.serverUrl')
  }
  if (type === 'api') {
    return t('sourceInfo.baseUrl')
  }
  if (type === 'local') {
    return t('sourceInfo.filesystemPath')
  }
  return t('sourceInfo.connectionDetails')
}


/**
 * Get contextual description for Permissions section based on source type
 */
export function getPermissionsDescription(source: LoadedSource, t: (key: string) => string): string {
  const { type } = source.config

  if (type === 'mcp') {
    return t('sourceInfo.toolPatternsAllowed')
  }
  if (type === 'api') {
    return t('sourceInfo.apiEndpointsAllowed')
  }
  return t('sourceInfo.accessRules')
}
