import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { assertRequestWorkspaceAccess, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.statuses.LIST,
  RPC_CHANNELS.statuses.REORDER,
] as const

export function registerStatusesHandlers(server: RpcServer, _deps: HandlerDeps): void {
  // List all statuses for a workspace
  server.handle(RPC_CHANNELS.statuses.LIST, async (ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    assertRequestWorkspaceAccess(ctx, workspaceId, workspace.id)

    const { listStatuses } = await import('@craft-agent/shared/statuses')
    return listStatuses(workspace.rootPath)
  })

  // Reorder statuses (drag-and-drop). Receives new ordered array of status IDs.
  // Config watcher will detect the file change and broadcast STATUSES_CHANGED.
  server.handle(RPC_CHANNELS.statuses.REORDER, async (ctx, workspaceId: string, orderedIds: string[]) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    assertRequestWorkspaceAccess(ctx, workspaceId, workspace.id)

    const { reorderStatuses } = await import('@craft-agent/shared/statuses')
    reorderStatuses(workspace.rootPath, orderedIds)
  })
}
