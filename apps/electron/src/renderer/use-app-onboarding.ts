import React, { useCallback } from 'react';

import type { Workspace, SetupNeeds, LlmConnectionWithStatus } from '../shared/types';

import { useOnboarding } from '@/hooks/useOnboarding';

import { toast } from 'sonner';
import { type AppState } from "./app-runtime-helpers";

interface useAppOnboardingInput {
  setLlmConnections: React.Dispatch<React.SetStateAction<LlmConnectionWithStatus[]>>
  setDefaultLlmConnectionSlug: React.Dispatch<React.SetStateAction<string | undefined>>
  windowWorkspaceId: string | null
  setWorkspaceDefaultLlmConnection: React.Dispatch<React.SetStateAction<string | undefined>>
  setWindowWorkspaceId: (args_0: string | ((prev: string | null) => string | null) | null) => void
  setWorkspaces: React.Dispatch<React.SetStateAction<Workspace[]>>
  setAppState: React.Dispatch<React.SetStateAction<AppState>>
  setupNeeds: SetupNeeds | null
  setSetupNeeds: React.Dispatch<React.SetStateAction<SetupNeeds | null>>
  t: import("i18next").TFunction<"translation", undefined>
  setShowResetDialog: React.Dispatch<React.SetStateAction<boolean>>
}

export function useAppOnboarding({
  setLlmConnections,
  setDefaultLlmConnectionSlug,
  windowWorkspaceId,
  setWorkspaceDefaultLlmConnection,
  setWindowWorkspaceId,
  setWorkspaces,
  setAppState,
  setupNeeds,
  setSetupNeeds,
  t,
  setShowResetDialog,
}: useAppOnboardingInput) {
const resolveDefaultConnectionSlug = useCallback((connections: LlmConnectionWithStatus[]) => {
    return connections.find(c => c.isDefault)?.slug ?? connections[0]?.slug
  }, [])

const refreshLlmConnections = useCallback(async () => {
    const connections = await window.electronAPI.listLlmConnectionsWithStatus()
    setLlmConnections(connections)
    setDefaultLlmConnectionSlug(resolveDefaultConnectionSlug(connections))
    // Also refresh workspace default
    if (windowWorkspaceId) {
      const settings = await window.electronAPI.getWorkspaceSettings(windowWorkspaceId)
      setWorkspaceDefaultLlmConnection(settings?.defaultLlmConnection)
    }
  }, [resolveDefaultConnectionSlug, windowWorkspaceId, setDefaultLlmConnectionSlug, setLlmConnections, setWorkspaceDefaultLlmConnection])

const handleOnboardingComplete = useCallback(async () => {
    try {
      // Reload workspaces after onboarding
      const ws = await window.electronAPI.getWorkspaces()
      if (ws.length > 0) {
        // Switch to workspace in-place (no window close/reopen)
        await window.electronAPI.switchWorkspace(ws[0].id)
        setWindowWorkspaceId(ws[0].id)
        setWorkspaces(ws)
      } else {
        setWorkspaces(ws)
      }
    } catch (error) {
      console.error('[App] Failed to load workspaces after onboarding:', error)
      // Still transition to ready — the app can recover via reconnect
    }
    setAppState('ready')
  }, [setAppState, setWindowWorkspaceId, setWorkspaces])

const onboarding = useOnboarding({
    onComplete: handleOnboardingComplete,
    onConfigSaved: refreshLlmConnections,
    initialSetupNeeds: setupNeeds || undefined,
  })

const handleReauthLogin = useCallback(async () => {
    // Re-check setup needs
    const needs = await window.electronAPI.getSetupNeeds()
    if (needs.isFullyConfigured) {
      setAppState('ready')
    } else {
      setSetupNeeds(needs)
      setAppState('onboarding')
    }
  }, [setAppState, setSetupNeeds])

const handleReauthReset = useCallback(() => {
    if (document.documentElement.dataset.robbRuntime === 'web') {
      toast.error(t('webui.hostResetDesktopOnly'))
      return
    }
    setShowResetDialog(true)
  }, [t, setShowResetDialog])
return { resolveDefaultConnectionSlug, refreshLlmConnections, onboarding, handleReauthLogin, handleReauthReset }
}
