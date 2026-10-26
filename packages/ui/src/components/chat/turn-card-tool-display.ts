

import i18n from 'i18next';

import { normalizePath, pathStartsWith, stripPathPrefix } from '@craft-agent/core/utils';
import { isParentTaskTool } from '@craft-agent/shared/utils/toolNames';

import { type ActivityItem } from "./turn-card-contracts";

export function getToolDisplayName(name: string): string {
  const stripped = name.replace(/^mcp__[^_]+__/, '')

  // Friendly display names for specific tools
  const displayNames: Record<string, string> = {
    'TodoWrite': 'Todo List Updated',
    'set_session_labels': 'Set Session Labels',
    'set_session_status': 'Set Session Status',
    'get_session_info': 'Get Session Info',
    'list_sessions': 'List Sessions',
  }

  return displayNames[stripped] || stripped
}

export function stripSessionFolderPath(filePath: string, sessionFolderPath?: string): string {
  if (!sessionFolderPath) return filePath

  // Get workspace path (parent of sessions folder)
  // sessionFolderPath: /path/workspaces/{uuid}/sessions/{sessionId}
  const workspacePath = normalizePath(sessionFolderPath).replace(/\/sessions\/[^/]+$/, '')

  // Try session folder first (more specific)
  if (pathStartsWith(filePath, sessionFolderPath)) {
    return stripPathPrefix(filePath, sessionFolderPath)
  }

  // Then try workspace folder
  if (pathStartsWith(filePath, workspacePath)) {
    return stripPathPrefix(filePath, workspacePath)
  }

  return filePath
}

export function formatToolInput(
  input?: Record<string, unknown>,
  toolName?: string,
  sessionFolderPath?: string
): string {
  if (!input || Object.keys(input).length === 0) return ''

  // For call_llm: model shown as badge, prompt duplicates intent
  if (toolName === 'mcp__session__call_llm') return ''

  const parts: string[] = []

  // For Edit/Write tools, only show file_path (skip old_string, new_string, replace_all, content)
  const isEditOrWrite = toolName === 'Edit' || toolName === 'Write'

  // Handle Codex format: { changes: Array<{ path, kind, diff }> }
  // Extract path from first change if present
  if (isEditOrWrite && input.changes && Array.isArray(input.changes)) {
    const firstChange = input.changes[0] as { path?: string } | undefined
    if (firstChange?.path) {
      const pathStr = stripSessionFolderPath(firstChange.path, sessionFolderPath)
      parts.push(pathStr)
    }
    return parts.join(' ')
  }

  for (const [key, value] of Object.entries(input)) {
    // Skip meta fields and description (shown separately)
    if (key === '_intent' || key === 'description' || value === undefined || value === null) continue

    // For Edit/Write tools, only include file_path
    if (isEditOrWrite && key !== 'file_path') continue

    let valStr = typeof value === 'string'
      ? value.replace(/\s+/g, ' ').trim()
      : JSON.stringify(value)

    // Strip session/workspace paths from file_path for Edit/Write tools
    if (isEditOrWrite && key === 'file_path' && typeof value === 'string') {
      valStr = stripSessionFolderPath(valStr, sessionFolderPath)
    }

    parts.push(valStr)
    if (parts.length >= 2) break // Max 2 values
  }
  return parts.join(' ')
}

export function extractActionFromDisplayName(iconName: string, llmName: string): string {
  // If LLM name starts with the icon name, strip the prefix to get the action
  // "Git Status" with icon "Git" → "Status"
  if (llmName.toLowerCase().startsWith(iconName.toLowerCase() + ' ')) {
    return llmName.slice(iconName.length + 1).trim()
  }
  // Otherwise use the full LLM name as the action
  // "Install Dependencies" with icon "npm" → "Install Dependencies"
  return llmName
}

export function formatToolDisplay(
  activity: ActivityItem
): { name: string; icon?: string; description?: string } {
  const { toolName, displayName, toolInput, toolDisplayMeta } = activity

  // Primary: Use embedded toolDisplayMeta (works in both Electron and viewer)
  if (toolDisplayMeta) {
    // For MCP tools, append the tool slug to the source name
    if (toolName?.startsWith('mcp__') && toolDisplayMeta.category === 'source') {
      const parts = toolName.match(/^mcp__([^_]+)__(.+)$/)
      if (parts) {
        const toolSlug = parts[2]
        return {
          name: `${toolDisplayMeta.displayName}: ${toolSlug}`,
          icon: toolDisplayMeta.iconDataUrl,
          description: toolDisplayMeta.description,
        }
      }
    }

    // For Bash commands with LLM-provided displayName: merge icon name + action
    // e.g., icon "Git" + LLM "Git Status" → "Git: Status"
    // e.g., icon "npm" + LLM "Install Dependencies" → "npm: Install Dependencies"
    // Special case: for generic "Terminal", show only the action
    // e.g., icon "Terminal" + LLM "Install Dependencies" → "Install Dependencies"
    if (toolName === 'Bash' && displayName) {
      const iconName = toolDisplayMeta.displayName
      const action = extractActionFromDisplayName(iconName, displayName)
      return {
        name: iconName.toLowerCase() === 'terminal' ? action : `${iconName}: ${action}`,
        icon: toolDisplayMeta.iconDataUrl,
        description: toolDisplayMeta.description,
      }
    }

    // For native tools with LLM-provided displayName: use the LLM's name
    // This gives semantic names like "Read Config" instead of generic "Read"
    if (displayName && toolDisplayMeta.category === 'native') {
      return {
        name: displayName,
        icon: toolDisplayMeta.iconDataUrl,
        description: toolDisplayMeta.description,
      }
    }

    return {
      name: toolDisplayMeta.displayName,
      icon: toolDisplayMeta.iconDataUrl,
      description: toolDisplayMeta.description,
    }
  }

  // Fallback for Skill tool without toolDisplayMeta (legacy sessions)
  if (toolName === 'Skill' && toolInput?.skill) {
    const skillId = String(toolInput.skill)
    // Extract slug from qualified name (workspaceId:slug) for display
    const colonIdx = skillId.indexOf(':')
    const slug = colonIdx > 0 ? skillId.slice(colonIdx + 1) : skillId
    return { name: slug }
  }

  // Final fallback: Use LLM-generated displayName or tool name
  const name = displayName || (toolName ? getToolDisplayName(toolName) : i18n.t('turnCard.processing'))
  return { name }
}

export function getPreviewText(
  activities: ActivityItem[],
  intent?: string,
  isStreaming?: boolean,
  hasResponse?: boolean,
  isComplete?: boolean
): string {
  const hasCheckpoint = activities.some(activity => activity.status === 'checkpoint')
  const hasRunningActivity = activities.some(activity => activity.status === 'running' || activity.status === 'backgrounded')
  if (hasCheckpoint && !hasRunningActivity) {
    return i18n.t('turnCard.notExecutedAutoResume')
  }

  // If we have an explicit intent, use it
  if (intent) return intent

  // Find the most relevant activity intent
  const activityWithIntent = activities.find(a => a.intent)
  if (activityWithIntent?.intent) return activityWithIntent.intent

  // Check if we're in responding state
  if (isStreaming && hasResponse) return i18n.t('turnCard.responding')

  // Find running Task tools and show their description
  const runningTask = activities.find(a => isParentTaskTool(a.toolName ?? '') && a.status === 'running')
  if (runningTask?.toolInput?.description) {
    return runningTask.toolInput.description as string
  }

  // While still streaming, show the latest intermediate message content
  // This gives visibility into what the LLM is "thinking"
  if (isStreaming && !isComplete) {
    const latestIntermediate = [...activities]
      .reverse()
      .find(a => a.type === 'intermediate' && a.content)
    if (latestIntermediate?.content) {
      return latestIntermediate.content
    }
  }

  // Get running and completed tools (not intermediate messages)
  const runningTools = activities.filter(a => a.status === 'running' && a.toolName)
  const errorCount = activities.filter(a => a.status === 'error').length

  // Show running tool names
  if (runningTools.length > 0) {
    const toolNames = runningTools
      .map(a => getToolDisplayName(a.toolName!))
      .slice(0, 3) // Max 3 names
    return `${toolNames.join(', ')}...`
  }

  // When complete, show first Task's description if available
  const firstTask = activities.find(a => isParentTaskTool(a.toolName ?? ''))
  if (firstTask?.toolInput?.description) {
    const errorSuffix = errorCount > 0
      ? i18n.t('turnCard.errorCount', { count: errorCount })
      : ''
    return `${firstTask.toolInput.description as string}${errorSuffix}`
  }

  // When complete, show summary (badge already shows count)
  if (isComplete || (!isStreaming && activities.length > 0)) {
    const errorSuffix = errorCount > 0
      ? i18n.t('turnCard.errorCount', { count: errorCount })
      : ''
    return `${i18n.t('turnCard.stepsCompleted')}${errorSuffix}`
  }

  return i18n.t('turnCard.starting')
}
