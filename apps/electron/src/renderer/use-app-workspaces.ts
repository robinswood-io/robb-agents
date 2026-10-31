import React,{ useCallback } from 'react';

import type { Session,Workspace,PermissionRequest,SetupNeeds } from '../shared/types';
import type { SessionDraft } from '@craft-agent/shared/config';
import type { SessionOptions } from './hooks/useSessionOptions';

import { useOnboarding } from '@/hooks/useOnboarding';

import { navigate,routes } from './lib/navigate';

import { sessionMetaMapAtom,sessionIdsAtom } from '@/atoms/sessions';
import { sourcesAtom } from '@/atoms/sources';
import { skillsAtom } from '@/atoms/skills';

import { useLinkInterceptor } from '@/hooks/useLinkInterceptor';

import { toast } from 'sonner';
import { type AppState } from "./app-runtime-helpers";

interface useAppWorkspacesInput {
  linkInterceptor: ReturnType<typeof useLinkInterceptor>
  t: import("i18next").TFunction<"translation", undefined>
  setShowResetDialog: React.Dispatch<React.SetStateAction<boolean>>
  initializeSessions: (sessions: Session[]) => void
  setWorkspaces: React.Dispatch<React.SetStateAction<Workspace[]>>
  setWindowWorkspaceId: (args_0: string | ((prev: string | null) => string | null) | null) => void
  setSetupNeeds: React.Dispatch<React.SetStateAction<SetupNeeds | null>>
  onboarding: ReturnType<typeof useOnboarding>
  setAppState: React.Dispatch<React.SetStateAction<AppState>>
  windowWorkspaceId: string | null
  setSession: (config: { selected: string | null; }) => void
  setPendingPermissions: React.Dispatch<React.SetStateAction<Map<string, PermissionRequest[]>>>
  setPendingCredentials: React.Dispatch<React.SetStateAction<Map<string, import("@craft-agent/session-tools-core").CredentialAuthRequest[]>>>
  setSessionOptions: React.Dispatch<React.SetStateAction<Map<string, SessionOptions>>>
  sessionDraftsRef: React.RefObject<Map<string, SessionDraft>>
  store: import("jotai").Store
  workspaces: Workspace[]
}

export function useAppWorkspaces({
  linkInterceptor,
  t,
  setShowResetDialog,
  initializeSessions,
  setWorkspaces,
  setWindowWorkspaceId,
  setSetupNeeds,
  onboarding,
  setAppState,
  windowWorkspaceId,
  setSession,
  setPendingPermissions,
  setPendingCredentials,
  setSessionOptions,
  sessionDraftsRef,
  store,
  workspaces,
}: useAppWorkspacesInput) {
const handleOpenUrl = linkInterceptor.handleOpenUrl

const handleOpenSettings = useCallback(() => {
    navigate(routes.view.settings())
  }, [])

const handleOpenKeyboardShortcuts = useCallback(() => {
    navigate(routes.view.settings('shortcuts'))
  }, [])

const handleOpenStoredUserPreferences = useCallback(() => {
    navigate(routes.view.settings('preferences'))
  }, [])

const handleReset = useCallback(() => {
    if (document.documentElement.dataset["robbRuntime"] === 'web') {
      toast.error(t('webui.hostResetDesktopOnly'))
      return
    }
    setShowResetDialog(true)
  }, [t, setShowResetDialog])

const executeReset = useCallback(async () => {
    try {
      await window.electronAPI.logout()
      // Reset all state
      // Clear session atoms - initialize with empty array clears all per-session atoms
      initializeSessions([])
      setWorkspaces([])
      setWindowWorkspaceId(null)
      // Reset setupNeeds to force fresh onboarding start
      setSetupNeeds({
        needsBillingConfig: true,
        needsCredentials: true,
        isFullyConfigured: false,
      })
      // Reset onboarding hook state
      onboarding.reset()
      setAppState('onboarding')
    } catch (error) {
      console.error('Reset failed:', error)
    } finally {
      setShowResetDialog(false)
    }
  }, [onboarding, initializeSessions, setAppState, setSetupNeeds, setShowResetDialog, setWindowWorkspaceId, setWorkspaces])

const handleSelectWorkspace = useCallback(async (workspaceId: string, openInNewWindow = false) => {
    // If selecting current workspace, do nothing
    if (workspaceId === windowWorkspaceId) return

    if (openInNewWindow) {
      // Open (or focus) the window for the selected workspace
      window.electronAPI.openWorkspace(workspaceId)
    } else {
      // Switch workspace in current window
      // 1. Update the main process's window-workspace mapping
      await window.electronAPI.switchWorkspace(workspaceId)

      // 2. Update React state to trigger re-renders
      setWindowWorkspaceId(workspaceId)

      // 3. Clear selected session - the old session belongs to the previous workspace
      // and should not remain selected when switching to a new workspace.
      // This prevents showing stale session data from the wrong workspace.
      setSession({ selected: null })

      // 4. Clear pending permissions/credentials (not relevant to new workspace)
      setPendingPermissions(new Map())
      setPendingCredentials(new Map())

      // 5. Clear session options from previous workspace
      // (session IDs are unique UUIDs, but clearing prevents unbounded memory growth
      // and ensures no stale state from old workspace persists)
      setSessionOptions(new Map())

      // 6. Clear message drafts from previous workspace
      // (prevents memory growth on repeated workspace switches)
      sessionDraftsRef.current.clear()

      // 7. Reset sources and skills atoms to empty
      // (prevents stale data flash during workspace switch - AppShell will reload)
      store.set(sourcesAtom, [])
      store.set(skillsAtom, [])

      // 8. Clear session atoms BEFORE workspace switch
      // This prevents stale session data from the previous workspace being visible.
      store.set(sessionMetaMapAtom, new Map())
      store.set(sessionIdsAtom, [])

      // Note: NavigationContext detects the workspaceId change and handles
      // panel restoration from the stored workspace URL (or defaults to allSessions).
      // Sessions and theme will reload automatically due to windowWorkspaceId dependency
      // in useEffect hooks.
    }
  }, [windowWorkspaceId, setSession, store, sessionDraftsRef, setPendingCredentials, setPendingPermissions, setSessionOptions, setWindowWorkspaceId])

const handleSwitchWorkspaceBySlug = useCallback((slug: string) => {
    const target = workspaces.find(w => w.slug === slug)
    if (target) {
      handleSelectWorkspace(target.id)
    }
  }, [workspaces, handleSelectWorkspace])

const handleRefreshWorkspaces = useCallback(() => {
    window.electronAPI.getWorkspaces().then(setWorkspaces)
  }, [setWorkspaces])


return { handleOpenSettings, handleOpenUrl, handleSelectWorkspace, handleRefreshWorkspaces, handleOpenKeyboardShortcuts, handleOpenStoredUserPreferences, handleReset, executeReset, handleSwitchWorkspaceBySlug }
}
