import { CliRpcClient } from './client.ts';
import { requireWorkspaceList } from './rpc-shapes.ts';

// ---------------------------------------------------------------------------
// Auto workspace resolution
// ---------------------------------------------------------------------------

export async function resolveWorkspace(
  client: CliRpcClient,
  explicit?: string,
): Promise<string | undefined> {
  if (explicit) {
    // Bind client to the workspace so push events reach us
    await client.invoke('window:switchWorkspace', explicit).catch(() => {})
    return explicit
  }
  try {
    const workspaces = requireWorkspaceList(await client.invoke('workspaces:get'))
    const first = workspaces[0]
    if (first) {
      const id = first.id
      await client.invoke('window:switchWorkspace', id).catch(() => {})
      return id
    }
  } catch {
    // Fall through — workspace may not be needed
  }
  return undefined
}
