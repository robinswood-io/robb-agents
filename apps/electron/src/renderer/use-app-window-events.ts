import React, { useEffect, useCallback } from 'react';

import { type ThemeOverrides } from '@config/theme';
import { useAtomValue } from 'jotai';
import type { Workspace, PermissionRequest, SetupNeeds, LlmConnectionWithStatus } from '../shared/types';
import type { SessionDraft } from '@craft-agent/shared/config';

import { useNotifications } from '@/hooks/useNotifications';
import { useSession } from '@/hooks/useSession';

import { navigate, routes } from './lib/navigate';

import { sessionMetaMapAtom } from '@/atoms/sessions';

import { visibleSessionIdsAtom } from '@/atoms/panel-stack';

import { getInternalRequestNavigationTarget } from '@/utils/session-visibility';

import { pendingSessionAuthRequestsAtom } from '@/atoms/session-auth-requests';

import { toast } from 'sonner';
import { type AppState } from "./app-runtime-helpers";

interface useAppWindowEventsInput {
  setWindowWorkspaceId: (args_0: string | ((prev: string | null) => string | null) | null) => void
  setSetupNeeds: React.Dispatch<React.SetStateAction<SetupNeeds | null>>
  setAppState: React.Dispatch<React.SetStateAction<AppState>>
  store: import("jotai").Store
  pendingPermissions: Map<string, PermissionRequest[]>
  pendingCredentials: Map<string, import("@craft-agent/session-tools-core").CredentialAuthRequest[]>
  t: import("i18next").TFunction<"translation", undefined>
  windowWorkspaceId: string | null
  notificationsEnabled: boolean
  appState: AppState
  setWorkspaces: React.Dispatch<React.SetStateAction<Workspace[]>>
  setNotificationsEnabled: React.Dispatch<React.SetStateAction<boolean>>
  loadSessionsFromServer: () => Promise<void>
  setLlmConnections: React.Dispatch<React.SetStateAction<LlmConnectionWithStatus[]>>
  setDefaultLlmConnectionSlug: React.Dispatch<React.SetStateAction<string | undefined>>
  resolveDefaultConnectionSlug: (connections: LlmConnectionWithStatus[]) => string
  sessionDraftsRef: React.RefObject<Map<string, SessionDraft>>
  setAppTheme: React.Dispatch<React.SetStateAction<ThemeOverrides | null>>
  refreshLlmConnections: () => Promise<void>
}

export function useAppWindowEvents({
  setWindowWorkspaceId,
  setSetupNeeds,
  setAppState,
  store,
  pendingPermissions,
  pendingCredentials,
  t,
  windowWorkspaceId,
  notificationsEnabled,
  appState,
  setWorkspaces,
  setNotificationsEnabled,
  loadSessionsFromServer,
  setLlmConnections,
  setDefaultLlmConnectionSlug,
  resolveDefaultConnectionSlug,
  sessionDraftsRef,
  setAppTheme,
  refreshLlmConnections,
}: useAppWindowEventsInput) {
useEffect(() => {
    const initialize = async () => {
      try {
        // Get this window's workspace ID (passed via URL query param from main process)
        const wsId = await window.electronAPI.getWindowWorkspace()
        setWindowWorkspaceId(wsId)

        const needs = await window.electronAPI.getSetupNeeds()
        setSetupNeeds(needs)

        if (needs.isFullyConfigured) {
          // If no workspace is selected (thin client without CRAFT_WORKSPACE_ID),
          // show workspace picker before entering the main app
          if (!wsId) {
            setAppState('workspace-picker')
          } else {
            setAppState('ready')
          }
        } else {
          // New user or needs setup - show onboarding
          setAppState('onboarding')
        }
      } catch (error) {
        console.error('Failed to check auth state:', error)
        // If check fails, show onboarding to be safe
        setAppState('onboarding')
      }
    }

    initialize()
  }, [setAppState, setSetupNeeds, setWindowWorkspaceId])

const [sessionSelection, setSession] = useSession()

const pendingSessionAuthRequests = useAtomValue(pendingSessionAuthRequestsAtom)

useEffect(() => {
    const sessions = store.get(sessionMetaMapAtom)
    const requestSessionIds = new Set([...pendingPermissions.keys(), ...pendingCredentials.keys(), ...pendingSessionAuthRequests.map(request => request.sessionId)])
    const toastIds: string[] = []
    for (const sessionId of requestSessionIds) {
      const targetId = getInternalRequestNavigationTarget(sessionId, sessions)
      if (!targetId) continue
      if (targetId === sessionSelection.selected || store.get(visibleSessionIdsAtom).has(targetId)) continue
      const toastId = `session-input-${sessionId}`
      toastIds.push(toastId)
      toast.message(t('chat.journey.outcome.blocked'), {
        id: toastId,
        duration: Infinity,
        action: { label: t('common.open'), onClick: () => { navigate(routes.view.allSessions(targetId)) } },
      })
    }
    return () => { toastIds.forEach(id => toast.dismiss(id)) }
  }, [pendingPermissions, pendingCredentials, pendingSessionAuthRequests, sessionSelection.selected, store, t])

const handleNavigateToSession = useCallback((sessionId: string) => {
    // Navigate to the session via central routing (uses allSessions filter)
    navigate(routes.view.allSessions(sessionId))
  }, [])

const { isWindowFocused, showSessionNotification } = useNotifications({
    workspaceId: windowWorkspaceId,
    // NOTE: sessions removed - hook now uses sessionMetaMapAtom internally
    // to prevent closures from retaining full message arrays
    onNavigateToSession: handleNavigateToSession,
    enabled: notificationsEnabled,
  })

useEffect(() => {
    if (appState !== 'ready') return

    window.electronAPI.getWorkspaces().then(setWorkspaces)
    window.electronAPI.getNotificationsEnabled().then(setNotificationsEnabled).catch(() => {})

    // Show actionable toast for missing system dependencies (Windows only)
    window.electronAPI.getSystemWarnings().then((warnings) => {
      if (warnings.vcredistMissing) {
        toast.warning(t('toast.vcRedistNotFound'), {
          description: t('toast.vcRedistNotFoundDesc'),
          duration: Infinity,
          action: {
            label: 'Install',
            onClick: () => window.electronAPI.openUrl(warnings.downloadUrl ?? 'https://aka.ms/vs/17/release/vc_redist.x64.exe'),
          },
        })
      }
    }).catch(() => { /* non-fatal startup check */ })
    void loadSessionsFromServer()
    // Load LLM connections with authentication status
    window.electronAPI.listLlmConnectionsWithStatus().then((connections) => {
      setLlmConnections(connections)
      setDefaultLlmConnectionSlug(resolveDefaultConnectionSlug(connections))
    })
    // Load persisted input drafts into ref (no re-render needed).
    // Attachment files are not read here — hydration happens lazily when the session
    // is opened so app startup isn't delayed by reading potentially large files.
    window.electronAPI.getAllDrafts().then((drafts) => {
      if (Object.keys(drafts).length > 0) {
        sessionDraftsRef.current = new Map(Object.entries(drafts))
      }
    })
    // Load app-level theme
    window.electronAPI.getAppTheme().then(setAppTheme)
  // Startup loading must not repeat solely because the translation function
  // changes language; it is used here only for the one-time warning toast.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appState, loadSessionsFromServer, resolveDefaultConnectionSlug, sessionDraftsRef, setAppTheme, setDefaultLlmConnectionSlug, setLlmConnections, setNotificationsEnabled, setWorkspaces])

useEffect(() => {
    const cleanupApp = window.electronAPI.onAppThemeChange((theme) => {
      setAppTheme(theme)
    })
    return () => {
      cleanupApp()
    }
  }, [setAppTheme])

useEffect(() => {
    const cleanup = window.electronAPI.onLlmConnectionsChanged(() => {
      refreshLlmConnections()
    })
    return () => { cleanup() }
  }, [refreshLlmConnections])

useEffect(() => {
    if (windowWorkspaceId) {
      refreshLlmConnections()
    }
  }, [windowWorkspaceId, refreshLlmConnections])
return { showSessionNotification, sessionSelection, setSession }
}
