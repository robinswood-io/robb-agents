import * as React from "react";

import { TopBar } from "./TopBar";

import type { Workspace } from "../../../shared/types";

import type { SettingsSubpage } from "../../../shared/types";

interface ShellTopBarProps {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  onSelectWorkspace: (id: string, openInNewWindow?: boolean) => void | Promise<void>
  workspaceUnreadMap: Record<string, boolean>
  onRefreshWorkspaces: (() => void) | undefined
  effectiveSessionId: string | null
  handleNewChat: (newPanel?: boolean) => void
  onOpenSettings: () => void
  handleSettingsClick: (subpage?: SettingsSubpage) => void
  onOpenKeyboardShortcuts: () => void
  onOpenStoredUserPreferences: () => void
  goBack: () => void
  goForward: () => void
  canGoBack: boolean
  canGoForward: boolean
  handleToggleSidebar: () => void
  setIsSidebarAndNavigatorHidden: React.Dispatch<React.SetStateAction<boolean>>
  handleNewBrowserWindow: () => Promise<void>
  isAutoCompact: boolean
}

export function ShellTopBar({
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  workspaceUnreadMap,
  onRefreshWorkspaces,
  effectiveSessionId,
  handleNewChat,
  onOpenSettings,
  handleSettingsClick,
  onOpenKeyboardShortcuts,
  onOpenStoredUserPreferences,
  goBack,
  goForward,
  canGoBack,
  canGoForward,
  handleToggleSidebar,
  setIsSidebarAndNavigatorHidden,
  handleNewBrowserWindow,
  isAutoCompact,
}: ShellTopBarProps) {
  return (
<TopBar
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSelectWorkspace={onSelectWorkspace}
          workspaceUnreadMap={workspaceUnreadMap}
          onWorkspaceCreated={() => onRefreshWorkspaces?.()}
          onWorkspaceRemoved={() => onRefreshWorkspaces?.()}
          activeSessionId={effectiveSessionId}
          onNewChat={() => handleNewChat()}
          onNewWindow={() => window.electronAPI.menuNewWindow()}
          onOpenSettings={onOpenSettings}
          onOpenSettingsSubpage={handleSettingsClick}
          onOpenKeyboardShortcuts={onOpenKeyboardShortcuts}
          onOpenStoredUserPreferences={onOpenStoredUserPreferences}
          onBack={goBack}
          onForward={goForward}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onToggleSidebar={handleToggleSidebar}
          onToggleFocusMode={() => setIsSidebarAndNavigatorHidden(prev => !prev)}
          onAddSessionPanel={() => handleNewChat(true)}
          onAddBrowserPanel={() => { void handleNewBrowserWindow() }}
          isCompact={isAutoCompact}
        />
  )
}
