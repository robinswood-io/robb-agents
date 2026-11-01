import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import "@/components/app-shell/PanelHeader";
import "@/components/ui/scroll-area";
import "@/components/ui/button";
import "@/components/ui/HeaderMenu";
import "@/lib/navigate";
import "lucide-react";
import "@craft-agent/ui";
import { useSetAtom } from 'jotai';
import { fullscreenOverlayOpenAtom } from '@/atoms/overlay';
import "motion/react";
import { DEFAULT_THINKING_LEVEL } from '@craft-agent/shared/agent/thinking-levels';
import "@craft-agent/shared/robinswood-branding";
import "@/components/ui/dropdown-menu";
import "@/components/ui/styled-dropdown";
import "@/lib/utils";
import "@/components/icons/ConnectionIcon";
import "@/components/settings";
import { useOnboarding } from '@/hooks/useOnboarding';
import "@/hooks/useWorkspaceIcon";
import "@/components/onboarding";
import "@/components/ui/rename-dialog";
import { useAppShellContext } from '@/context/AppShellContext';
import "@config/models";
import "@config/llm-connections";
import "@/components/app-shell/input/model-picker-helpers";
import "sonner";

import { useAiConnectionActions } from "./use-ai-connection-actions";

























import { type CustomEndpointApi } from '@config/llm-connections';


import { AiSettingsContent } from "./ai-settings-content";
import { type ValidationState } from "./ai-connection-settings";

/**
 * AiSettingsPage
 *
 * Unified AI settings page that consolidates all LLM-related configuration:
 * - Default connection, model, and thinking level
 * - Per-workspace overrides
 * - Connection management (add/edit/delete)
 *
 * Follows the Appearance settings pattern: app-level defaults + workspace overrides.
 */

/**
 * AiSettingsPage
 *
 * Unified AI settings page that consolidates all LLM-related configuration:
 * - Default connection, model, and thinking level
 * - Per-workspace overrides
 * - Connection management (add/edit/delete)
 *
 * Follows the Appearance settings pattern: app-level defaults + workspace overrides.
 */

/**
 * AiSettingsPage
 *
 * Unified AI settings page that consolidates all LLM-related configuration:
 * - Default connection, model, and thinking level
 * - Per-workspace overrides
 * - Connection management (add/edit/delete)
 *
 * Follows the Appearance settings pattern: app-level defaults + workspace overrides.
 */
/**
 * AiSettingsPage
 *
 * Unified AI settings page that consolidates all LLM-related configuration:
 * - Default connection, model, and thinking level
 * - Per-workspace overrides
 * - Connection management (add/edit/delete)
 *
 * Follows the Appearance settings pattern: app-level defaults + workspace overrides.
 */
import type { CredentialHealthIssue } from '../../../shared/types';

import type { LlmConnectionWithStatus, ThinkingLevel, Workspace } from '../../../shared/types';

import type { DetailsPageMeta } from '@/lib/navigation-registry';

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'ai',
}

// ============================================
// Main Component
// ============================================

export default function AiSettingsPage() {
  const { t } = useTranslation()
  const { llmConnections, refreshLlmConnections, activeWorkspaceId } = useAppShellContext()

  // API Setup overlay state
  const [showApiSetup, setShowApiSetup] = useState(false)
  const [editingConnectionSlug, setEditingConnectionSlug] = useState<string | null>(null)
  const [isDirectEdit, setIsDirectEdit] = useState(false)
  const [editInitialValues, setEditInitialValues] = useState<{
    apiKey?: string
    baseUrl?: string
    connectionDefaultModel?: string
    activePreset?: string
    models?: string[]
    customApi?: CustomEndpointApi
    googleCloudProject?: string
  } | undefined>(undefined)
  const setFullscreenOverlayOpen = useSetAtom(fullscreenOverlayOpenAtom)

  // Workspaces for override cards
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])

  // Default settings state (app-level)
  const [defaultThinking, setDefaultThinking] = useState<ThinkingLevel>(DEFAULT_THINKING_LEVEL)
  const [extendedPromptCache, setExtendedPromptCache] = useState(false)
  const [enable1MContext, setEnable1MContext] = useState(false)
  const [rtkEnabled, setRtkEnabled] = useState(false)
  const [rtkStatus, setRtkStatus] = useState<{ installed: boolean; path: string | null; version: string | null } | null>(null)
  const [rtkRechecking, setRtkRechecking] = useState(false)
  const [rtkGain, setRtkGain] = useState<{ totalCommands: number; totalInput: number; totalOutput: number; totalSaved: number; avgSavingsPct: number; totalTimeMs: number; avgTimeMs: number } | null>(null)

  // Validation state per connection
  const [validationStates, setValidationStates] = useState<Record<string, {
    state: ValidationState
    error?: string
  }>>({})

  // Credential health state (for startup warning banner)
  const [credentialHealthIssues, setCredentialHealthIssues] = useState<CredentialHealthIssue[]>([])

  // Rename dialog state
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renamingConnection, setRenamingConnection] = useState<{ slug: string; name: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // Load workspaces, default settings, and credential health
  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      try {
        const ws = await window.electronAPI.getWorkspaces()
        setWorkspaces(ws)

        const defaultThinkingLevel = await window.electronAPI.getDefaultThinkingLevel()
        setDefaultThinking(defaultThinkingLevel)

        const extendedCache = await window.electronAPI.getExtendedPromptCache()
        setExtendedPromptCache(extendedCache)

        const enable1M = await window.electronAPI.getEnable1MContext()
        setEnable1MContext(enable1M)

        const rtkOn = await window.electronAPI.getRtkEnabled()
        setRtkEnabled(rtkOn)

        const status = await window.electronAPI.getRtkStatus()
        setRtkStatus(status)

        // Check credential health for potential issues (corruption, machine migration)
        const health = await window.electronAPI.getCredentialHealth()
        if (!health.healthy) {
          setCredentialHealthIssues(health.issues)
        }
      } catch (error) {
        console.error('Failed to load settings:', error)
      }
    }
    load()
  }, [activeWorkspaceId])

  // Helpers to open/close the fullscreen API setup overlay
  const openApiSetup = useCallback((connectionSlug?: string) => {
    setEditingConnectionSlug(connectionSlug || null)
    setShowApiSetup(true)
    setFullscreenOverlayOpen(true)
  }, [setFullscreenOverlayOpen])

  const closeApiSetup = useCallback(() => {
    setShowApiSetup(false)
    setFullscreenOverlayOpen(false)
    setEditingConnectionSlug(null)
  }, [setFullscreenOverlayOpen])

  // Derive existing slugs for unique slug generation
  const existingSlugs = useMemo(
    () => new Set(llmConnections.map(c => c.slug)),
    [llmConnections],
  )

  // OnboardingWizard hook for editing API connection
  const apiSetupOnboarding = useOnboarding({
    initialStep: 'provider-select',
    onConfigSaved: refreshLlmConnections,
    onComplete: () => {
      closeApiSetup()
      refreshLlmConnections?.()
      apiSetupOnboarding.reset()
    },
    onDismiss: () => {
      closeApiSetup()
      apiSetupOnboarding.reset()
    },
    editingSlug: editingConnectionSlug,
    existingSlugs,
  })

  const handleApiSetupFinish = useCallback(() => {
    closeApiSetup()
    refreshLlmConnections?.()
    apiSetupOnboarding.reset()
    // Clear any credential health issues after successful re-authentication
    setCredentialHealthIssues([])
    setIsDirectEdit(false)
    setEditInitialValues(undefined)
  }, [closeApiSetup, refreshLlmConnections, apiSetupOnboarding])

  // Handler for closing the modal via X button or Escape - resets state and cancels OAuth
  const handleCloseApiSetup = useCallback(() => {
    closeApiSetup()
    apiSetupOnboarding.reset()
    setIsDirectEdit(false)
    setEditInitialValues(undefined)
  }, [closeApiSetup, apiSetupOnboarding])

  // Handler for re-authenticate button in credential health banner
  const handleReauthenticate = useCallback(() => {
    // Open API setup for the default connection (or first connection if available)
    const defaultConn = llmConnections.find(c => c.isDefault) || llmConnections[0]
    if (defaultConn) {
      openApiSetup(defaultConn.slug)
    } else {
      openApiSetup()
    }
  }, [llmConnections, openApiSetup])

  // Connection action handlers
  const handleRenameClick = useCallback((connection: LlmConnectionWithStatus) => {
    setRenamingConnection({ slug: connection.slug, name: connection.name })
    setRenameValue(connection.name)
    // Defer dialog open to next frame to let dropdown fully unmount first
    requestAnimationFrame(() => {
      setRenameDialogOpen(true)
    })
  }, [])

  const {
    handleRenameSubmit,
    handleReauthenticateConnection,
    handleEditConnection,
    handleDeleteConnection,
    handleValidateConnection,
    handleSetDefaultConnection,
    handleSetMidStreamBehavior,
  } = useAiConnectionActions({
    renamingConnection,
    renameValue,
    setRenameDialogOpen,
    refreshLlmConnections,
    setRenamingConnection,
    setRenameValue,
    openApiSetup,
    apiSetupOnboarding,
    setEditInitialValues,
    setIsDirectEdit,
    setValidationStates,
    t,
  })

  // Get the default connection for display
  const defaultConnection = useMemo(() => {
    return llmConnections.find(c => c.isDefault)
  }, [llmConnections])

  // Anthropic account UUIDs that resolve from 2+ connections (issue #838).
  // Surfaces a warning when several Claude connections share one account/quota.
  const duplicateAccountUuids = useMemo(() => {
    const counts = new Map<string, number>()
    for (const conn of llmConnections) {
      const uuid = conn.oauthAccountUuid
      if (uuid) counts.set(uuid, (counts.get(uuid) ?? 0) + 1)
    }
    return new Set([...counts].filter(([, n]) => n > 1).map(([uuid]) => uuid))
  }, [llmConnections])

  const defaultModel = defaultConnection?.defaultModel ?? ''

  // App-level default handlers
  const handleDefaultModelChange = useCallback(async (model: string) => {
    if (!window.electronAPI || !defaultConnection) return
    // Update defaultModel on the connection, then save the full connection
    const updated = { ...defaultConnection, defaultModel: model }
    // Remove status fields that aren't part of LlmConnection
    const { isAuthenticated: _a, authError: _b, isDefault: _c, ...connectionData } = updated
    await window.electronAPI.saveLlmConnection(connectionData as import('../../../shared/types').LlmConnection)
    await refreshLlmConnections()
  }, [defaultConnection, refreshLlmConnections])

  const handleDefaultThinkingChange = useCallback(async (level: ThinkingLevel) => {
    if (!window.electronAPI) return

    const previous = defaultThinking
    setDefaultThinking(level)

    try {
      const result = await window.electronAPI.setDefaultThinkingLevel(level)
      if (!result.success) {
        console.error('Failed to set default thinking level:', result.error)
        setDefaultThinking(previous)
      }
    } catch (error) {
      console.error('Failed to set default thinking level:', error)
      setDefaultThinking(previous)
    }
  }, [defaultThinking])

  const handleExtendedPromptCacheChange = useCallback(async (enabled: boolean) => {
    setExtendedPromptCache(enabled)
    await window.electronAPI?.setExtendedPromptCache(enabled)
  }, [])

  const handleEnable1MContextChange = useCallback(async (enabled: boolean) => {
    setEnable1MContext(enabled)
    await window.electronAPI?.setEnable1MContext(enabled)
  }, [])

  const handleRtkToggle = useCallback(async (enabled: boolean) => {
    setRtkEnabled(enabled)
    await window.electronAPI?.setRtkEnabled(enabled)
  }, [])

  const handleRecheckRtk = useCallback(async () => {
    setRtkRechecking(true)
    try {
      const status = await window.electronAPI?.getRtkStatus({ forceRecheck: true })
      if (status) setRtkStatus(status)
    } finally {
      setRtkRechecking(false)
    }
  }, [])

  const handleGetRtk = useCallback(() => {
    window.electronAPI?.openUrl('https://github.com/rtk-ai/rtk')
  }, [])

  const refreshRtkGain = useCallback(async () => {
    const gain = await window.electronAPI?.getRtkGain()
    setRtkGain(gain ?? null)
  }, [])

  // Refresh gain stats whenever rtk transitions to installed-and-enabled
  useEffect(() => {
    if (rtkStatus?.installed && rtkEnabled) {
      refreshRtkGain()
    } else {
      setRtkGain(null)
    }
  }, [rtkStatus?.installed, rtkEnabled, refreshRtkGain])

  // Refresh callback for workspace cards
  const handleWorkspaceSettingsChange = useCallback(() => {
    // Refresh context so changes propagate immediately
    refreshLlmConnections?.()
  }, [refreshLlmConnections])

  return (
    <AiSettingsContent
      t={t}
      credentialHealthIssues={credentialHealthIssues}
      handleReauthenticate={handleReauthenticate}
      llmConnections={llmConnections}
      defaultConnection={defaultConnection}
      handleSetDefaultConnection={handleSetDefaultConnection}
      defaultModel={defaultModel}
      handleDefaultModelChange={handleDefaultModelChange}
      defaultThinking={defaultThinking}
      handleDefaultThinkingChange={handleDefaultThinkingChange}
      workspaces={workspaces}
      handleWorkspaceSettingsChange={handleWorkspaceSettingsChange}
      handleRenameClick={handleRenameClick}
      handleDeleteConnection={handleDeleteConnection}
      handleValidateConnection={handleValidateConnection}
      handleReauthenticateConnection={handleReauthenticateConnection}
      handleEditConnection={handleEditConnection}
      handleSetMidStreamBehavior={handleSetMidStreamBehavior}
      validationStates={validationStates}
      duplicateAccountUuids={duplicateAccountUuids}
      openApiSetup={openApiSetup}
      enable1MContext={enable1MContext}
      handleEnable1MContextChange={handleEnable1MContextChange}
      extendedPromptCache={extendedPromptCache}
      handleExtendedPromptCacheChange={handleExtendedPromptCacheChange}
      rtkStatus={rtkStatus}
      rtkEnabled={rtkEnabled}
      handleRtkToggle={handleRtkToggle}
      rtkGain={rtkGain}
      refreshRtkGain={refreshRtkGain}
      handleGetRtk={handleGetRtk}
      handleRecheckRtk={handleRecheckRtk}
      rtkRechecking={rtkRechecking}
      showApiSetup={showApiSetup}
      handleCloseApiSetup={handleCloseApiSetup}
      apiSetupOnboarding={apiSetupOnboarding}
      isDirectEdit={isDirectEdit}
      handleApiSetupFinish={handleApiSetupFinish}
      editInitialValues={editInitialValues}
      renameDialogOpen={renameDialogOpen}
      setRenameDialogOpen={setRenameDialogOpen}
      renameValue={renameValue}
      setRenameValue={setRenameValue}
      handleRenameSubmit={handleRenameSubmit}
    />
  )
}
