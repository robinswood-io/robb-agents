import { mainState } from './main-state';

import { join } from 'path';

import { loadWindowState } from './window-state';
import { getWorkspaces, loadStoredConfig, addWorkspace, saveConfig } from '@craft-agent/shared/config';
import { getDefaultWorkspacesDir } from '@craft-agent/shared/workspaces';

import { mainLog } from './logger';

export async function createInitialWindows(): Promise<void> {
  if (!mainState.windowManager) return

  // Load saved window state
  const savedState = loadWindowState()
  let workspaces = getWorkspaces()

  // If no workspaces exist, create default "My Workspace" on first run
  if (workspaces.length === 0) {
    // Ensure config file exists (addWorkspace requires it)
    if (!loadStoredConfig()) {
      saveConfig({ workspaces: [], activeWorkspaceId: null, activeSessionId: null })
    }
    const defaultPath = join(getDefaultWorkspacesDir(), 'my-workspace')
    addWorkspace({ rootPath: defaultPath, name: 'My Workspace' })
    workspaces = getWorkspaces() // Refresh after creation
    mainLog.info('Created default workspace on first run')
  }

  const validWorkspaceIds = workspaces.map(ws => ws.id)

  if (savedState?.windows.length) {
    // Restore windows from saved state
    let restoredCount = 0

    for (const saved of savedState.windows) {
      // Skip invalid workspaces
      if (!validWorkspaceIds.includes(saved.workspaceId)) continue

      // Restore main window with focused mode if it was saved
      mainLog.info(`Restoring window: workspaceId=${saved.workspaceId}, focused=${saved.focused ?? false}, url=${saved.url ?? 'none'}`)
      const win = mainState.windowManager.createWindow({
        workspaceId: saved.workspaceId,
        focused: saved.focused,
        restoreUrl: saved.url,
      })
      win.setBounds(saved.bounds)

      restoredCount++
    }

    if (restoredCount > 0) {
      mainLog.info(`Restored ${restoredCount} window(s) from saved state`)
      return
    }
  }

  // Default: open window for first workspace
  mainState.windowManager.createWindow({ workspaceId: workspaces[0].id })
  mainLog.info(`Created window for first workspace: ${workspaces[0].name}`)
}
