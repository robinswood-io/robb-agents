import { omitUndefined } from '@craft-agent/shared/utils/json';
import { useCallback } from 'react';

import type { LlmConnectionWithStatus } from '../../../shared/types';

import { useOnboarding } from '@/hooks/useOnboarding';

import { type ModelDefinition } from '@config/models';
import { resolveMidStreamBehavior, type CustomEndpointApi, type MidStreamBehavior } from '@config/llm-connections';

import { toast } from 'sonner';
import { type ValidationState, getApiKeyMethodForConnection } from "./ai-connection-settings";

interface useAiConnectionActionsInput {
  renamingConnection: { slug: string; name: string; } | null
  renameValue: string
  setRenameDialogOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>
  refreshLlmConnections: () => Promise<void>
  setRenamingConnection: import("react").Dispatch<import("react").SetStateAction<{ slug: string; name: string; } | null>>
  setRenameValue: import("react").Dispatch<import("react").SetStateAction<string>>
  openApiSetup: (connectionSlug?: string) => void
  apiSetupOnboarding: ReturnType<typeof useOnboarding>
  setEditInitialValues: import("react").Dispatch<import("react").SetStateAction<{ apiKey?: string; baseUrl?: string; connectionDefaultModel?: string; activePreset?: string; models?: string[]; customApi?: CustomEndpointApi; googleCloudProject?: string; } | undefined>>
  setIsDirectEdit: import("react").Dispatch<import("react").SetStateAction<boolean>>
  setValidationStates: import("react").Dispatch<import("react").SetStateAction<Record<string, { state: ValidationState; error?: string; }>>>
  t: import("i18next").TFunction<"translation", undefined>
}

export function useAiConnectionActions({
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
}: useAiConnectionActionsInput) {
const handleRenameSubmit = useCallback(async () => {
    if (!renamingConnection || !window.electronAPI) return
    const trimmedName = renameValue.trim()
    if (!trimmedName || trimmedName === renamingConnection.name) {
      setRenameDialogOpen(false)
      return
    }
    try {
      // Get the full connection, update name, and save
      const connection = await window.electronAPI.getLlmConnection(renamingConnection.slug)
      if (connection) {
        const result = await window.electronAPI.saveLlmConnection({ ...connection, name: trimmedName })
        if (result.success) {
          refreshLlmConnections?.()
        } else {
          console.error('Failed to rename connection:', result.error)
        }
      }
    } catch (error) {
      console.error('Failed to rename connection:', error)
    }
    setRenameDialogOpen(false)
    setRenamingConnection(null)
    setRenameValue('')
  }, [renamingConnection, renameValue, refreshLlmConnections, setRenameDialogOpen, setRenamingConnection, setRenameValue])

const handleReauthenticateConnection = useCallback((connection: LlmConnectionWithStatus) => {
    openApiSetup(connection.slug)
    apiSetupOnboarding.reset()

    if (connection.piAuthProvider === 'google-antigravity') {
      apiSetupOnboarding.handleStartOAuth('pi_google_antigravity_subscription', connection.slug)
      return
    }

    if (connection.authType === 'oauth') {
      const method = connection.providerType === 'pi'
                   ? (connection.piAuthProvider === 'github-copilot' ? 'pi_copilot_oauth' : 'pi_chatgpt_oauth')
                   : 'claude_oauth'
      apiSetupOnboarding.handleStartOAuth(method, connection.slug)
    }
  }, [apiSetupOnboarding, openApiSetup])

const handleEditConnection = useCallback(async (connection: LlmConnectionWithStatus) => {
    // Fetch stored API key (best-effort — if IPC not available yet, skip pre-fill)
    let apiKey: string | undefined
    try {
      apiKey = (await window.electronAPI.getLlmConnectionApiKey(connection.slug)) ?? undefined
    } catch {
      // IPC method may not exist if app wasn't restarted after code change
    }

    // Build model string from connection's models array
    const modelStr = connection.models
      ?.map((m: string | ModelDefinition) => typeof m === 'string' ? m : m.id)
      .join(', ') || connection.defaultModel || ''

    // Set initial values before opening overlay so ApiKeyInput mounts with them
    const modelIds = connection.models
      ?.map((m: string | ModelDefinition) => typeof m === 'string' ? m : m.id)
      .filter(Boolean)

    const isCustomEndpointConnection = !!connection.customEndpoint && !!connection.baseUrl?.trim()

    setEditInitialValues(omitUndefined({
      apiKey,
      baseUrl: connection.baseUrl,
      connectionDefaultModel: modelStr,
      activePreset: isCustomEndpointConnection ? 'custom' : (connection.piAuthProvider || undefined),
      models: modelIds,
      customApi: connection.customEndpoint?.api,
      googleCloudProject: connection.googleCloudProject,
    }))

    // Open overlay and jump directly to credentials step (no reset — jumpToCredentials sets state)
    openApiSetup(connection.slug)
    setIsDirectEdit(true)
    const method = getApiKeyMethodForConnection(connection)
    apiSetupOnboarding.jumpToCredentials(method)
  }, [apiSetupOnboarding, openApiSetup, setEditInitialValues, setIsDirectEdit])

const handleDeleteConnection = useCallback(async (slug: string) => {
    if (!window.electronAPI) return
    try {
      const result = await window.electronAPI.deleteLlmConnection(slug)
      if (result.success) {
        refreshLlmConnections?.()
      } else {
        console.error('Failed to delete connection:', result.error)
      }
    } catch (error) {
      console.error('Failed to delete connection:', error)
    }
  }, [refreshLlmConnections])

const handleValidateConnection = useCallback(async (slug: string) => {
    if (!window.electronAPI) return

    // Set validating state
    setValidationStates(prev => ({ ...prev, [slug]: { state: 'validating' } }))

    try {
      const result = await window.electronAPI.testLlmConnection(slug)

      if (result.success) {
        setValidationStates(prev => ({ ...prev, [slug]: { state: 'success' } }))
        // Auto-clear success state after 3 seconds
        setTimeout(() => {
          setValidationStates(prev => ({ ...prev, [slug]: { state: 'idle' } }))
        }, 3000)
      } else {
        setValidationStates(prev => ({
          ...prev,
          [slug]: { state: 'error', ...(result.error !== undefined ? { error: result.error } : {}) }
        }))
        // Auto-clear error state after 5 seconds
        setTimeout(() => {
          setValidationStates(prev => ({ ...prev, [slug]: { state: 'idle' } }))
        }, 5000)
      }
    } catch (error) {
      setValidationStates(prev => ({
        ...prev,
        [slug]: { state: 'error', error: t("settings.ai.validationFailed") }
      }))
      setTimeout(() => {
        setValidationStates(prev => ({ ...prev, [slug]: { state: 'idle' } }))
      }, 5000)
    }
  }, [t, setValidationStates])

const handleSetDefaultConnection = useCallback(async (slug: string) => {
    if (!window.electronAPI) return
    try {
      const result = await window.electronAPI.setDefaultLlmConnection(slug)
      if (result.success) {
        refreshLlmConnections?.()
      } else {
        console.error('Failed to set default connection:', result.error)
      }
    } catch (error) {
      console.error('Failed to set default connection:', error)
    }
  }, [refreshLlmConnections])

const handleSetMidStreamBehavior = useCallback(async (
    connection: LlmConnectionWithStatus,
    behavior: MidStreamBehavior,
  ) => {
    if (!window.electronAPI) return
    if (resolveMidStreamBehavior(connection) === behavior) return
    try {
      const updated = { ...connection, midStreamBehavior: behavior }
      const { isAuthenticated: _a, authError: _b, isDefault: _c, ...connectionData } = updated
      const result = await window.electronAPI.saveLlmConnection(connectionData as import('../../../shared/types').LlmConnection)
      if (result.success) {
        refreshLlmConnections?.()
      } else {
        console.error('Failed to update mid-stream behavior:', result.error)
        toast.error(t('settings.ai.midStream.updateFailed'))
      }
    } catch (error) {
      console.error('Failed to update mid-stream behavior:', error)
      toast.error(t('settings.ai.midStream.updateFailed'))
    }
  }, [refreshLlmConnections, t])
return { handleRenameSubmit, handleReauthenticateConnection, handleEditConnection, handleDeleteConnection, handleValidateConnection, handleSetDefaultConnection, handleSetMidStreamBehavior }
}
