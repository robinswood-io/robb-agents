import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RequestContext } from '../transport/types'
import type { RemoteDeviceRegistry } from './remote-device-registry'

const REMOTE_DEVICE_RPC_CHANNELS = new Set<string>([
  RPC_CHANNELS.server.GET_WORKSPACES,
  RPC_CHANNELS.server.GET_STATUS,
  RPC_CHANNELS.server.GET_HEALTH,
  RPC_CHANNELS.server.GET_ACTIVE_SESSIONS,
  RPC_CHANNELS.sessions.GET,
  RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY,
  RPC_CHANNELS.sessions.MARK_ALL_READ,
  RPC_CHANNELS.sessions.CREATE,
  RPC_CHANNELS.sessions.GET_MESSAGES,
  RPC_CHANNELS.sessions.SEND_MESSAGE,
  RPC_CHANNELS.sessions.CANCEL,
  RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION,
  RPC_CHANNELS.sessions.COMMAND,
  RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION,
  RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE,
  RPC_CHANNELS.sessions.GET_MODEL,
  RPC_CHANNELS.sessions.GET_FILES,
  RPC_CHANNELS.sessions.GET_NOTES,
  RPC_CHANNELS.sessions.SET_NOTES,
  RPC_CHANNELS.sessions.SEARCH_CONTENT,
  RPC_CHANNELS.tasks.GET_OUTPUT,
  RPC_CHANNELS.tasks.PAUSE,
  RPC_CHANNELS.tasks.RESUME,
  RPC_CHANNELS.tasks.STOP,
  RPC_CHANNELS.tasks.LIST_APPROVALS,
  RPC_CHANNELS.tasks.RESOLVE_APPROVAL,
  RPC_CHANNELS.tasks.GET,
  RPC_CHANNELS.tasks.LIST,
  RPC_CHANNELS.tasks.GET_RESULTS,
  RPC_CHANNELS.workspaces.GET,
  RPC_CHANNELS.window.GET_WORKSPACE,
  RPC_CHANNELS.window.GET_MODE,
  RPC_CHANNELS.window.SWITCH_WORKSPACE,
  RPC_CHANNELS.theme.GET_SYSTEM_PREFERENCE,
  RPC_CHANNELS.theme.GET_APP,
  RPC_CHANNELS.theme.GET_PRESETS,
  RPC_CHANNELS.theme.GET_COLOR_THEME,
  RPC_CHANNELS.theme.GET_WORKSPACE_COLOR_THEME,
  RPC_CHANNELS.theme.GET_ALL_WORKSPACE_THEMES,
  RPC_CHANNELS.system.VERSIONS,
  RPC_CHANNELS.system.IS_DEBUG_MODE,
  RPC_CHANNELS.drafts.GET,
  RPC_CHANNELS.drafts.SET,
  RPC_CHANNELS.drafts.DELETE,
  RPC_CHANNELS.sources.GET,
  RPC_CHANNELS.sources.GET_PERMISSIONS,
  RPC_CHANNELS.sources.GET_MCP_TOOLS,
  RPC_CHANNELS.workspace.GET_PERMISSIONS,
  RPC_CHANNELS.workspace.SETTINGS_GET,
  RPC_CHANNELS.workspace.ROUTING_SIMULATE,
  RPC_CHANNELS.skills.GET,
  RPC_CHANNELS.skills.GET_FILES,
  RPC_CHANNELS.statuses.LIST,
  RPC_CHANNELS.labels.LIST,
  RPC_CHANNELS.views.LIST,
  RPC_CHANNELS.toolIcons.GET_MAPPINGS,
  RPC_CHANNELS.logo.GET_URL,
  RPC_CHANNELS.projects.GET,
  RPC_CHANNELS.projects.GET_ONE,
  RPC_CHANNELS.projects.LIST_ASSETS,
])

const REMOTE_DEVICE_WORKSPACE_ARGUMENTS = new Map<string, number>([
  [RPC_CHANNELS.sessions.MARK_ALL_READ, 0],
  [RPC_CHANNELS.sessions.CREATE, 0],
  [RPC_CHANNELS.sessions.SEARCH_CONTENT, 0],
  [RPC_CHANNELS.tasks.PAUSE, 0],
  [RPC_CHANNELS.tasks.RESUME, 0],
  [RPC_CHANNELS.tasks.STOP, 0],
  [RPC_CHANNELS.tasks.LIST_APPROVALS, 0],
  [RPC_CHANNELS.tasks.RESOLVE_APPROVAL, 0],
  [RPC_CHANNELS.tasks.GET, 0],
  [RPC_CHANNELS.tasks.LIST, 0],
  [RPC_CHANNELS.tasks.GET_RESULTS, 0],
  [RPC_CHANNELS.window.SWITCH_WORKSPACE, 0],
  [RPC_CHANNELS.theme.GET_WORKSPACE_COLOR_THEME, 0],
  [RPC_CHANNELS.sources.GET, 0],
  [RPC_CHANNELS.sources.GET_PERMISSIONS, 0],
  [RPC_CHANNELS.sources.GET_MCP_TOOLS, 0],
  [RPC_CHANNELS.workspace.GET_PERMISSIONS, 0],
  [RPC_CHANNELS.workspace.SETTINGS_GET, 0],
  [RPC_CHANNELS.workspace.ROUTING_SIMULATE, 0],
  [RPC_CHANNELS.skills.GET, 0],
  [RPC_CHANNELS.skills.GET_FILES, 0],
  [RPC_CHANNELS.statuses.LIST, 0],
  [RPC_CHANNELS.labels.LIST, 0],
  [RPC_CHANNELS.views.LIST, 0],
  [RPC_CHANNELS.projects.GET, 0],
  [RPC_CHANNELS.projects.GET_ONE, 0],
  [RPC_CHANNELS.projects.LIST_ASSETS, 0],
])

/** Server-side allowlist for browser sessions paired through the Remote flow. */
export function authorizeWebuiRpcRequest(
  context: RequestContext,
  channel: string,
  args: readonly unknown[] = [],
): boolean {
  if (context.roles.includes('owner')) return true
  if (!context.roles.includes('remote-device') || !REMOTE_DEVICE_RPC_CHANNELS.has(channel)) {
    return false
  }

  const workspaceArgumentIndex = REMOTE_DEVICE_WORKSPACE_ARGUMENTS.get(channel)
  if (workspaceArgumentIndex === undefined) return true

  const workspaceId = args[workspaceArgumentIndex]
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return false
  return context.allowedWorkspaceIds === '*' || context.allowedWorkspaceIds.includes(workspaceId)
}

/** Revalidates the durable device grant before applying the per-channel policy. */
export function createWebuiRpcAuthorizer(remoteDeviceRegistry: RemoteDeviceRegistry) {
  return (
    context: RequestContext,
    channel: string,
    args: readonly unknown[] = [],
  ): boolean => {
    if (context.roles.includes('owner')) {
      return authorizeWebuiRpcRequest(context, channel, args)
    }

    const devicePrefix = 'remote-device:'
    if (!context.actorId.startsWith(devicePrefix)) return false
    const deviceId = context.actorId.slice(devicePrefix.length)
    const device = remoteDeviceRegistry.authorize(deviceId, context.authorizationGeneration)
    if (!device) return false

    return authorizeWebuiRpcRequest(
      { ...context, allowedWorkspaceIds: device.allowedWorkspaceIds },
      channel,
      args,
    )
  }
}
