import { omitUndefined } from '@craft-agent/shared/utils/json';
import { useState,useCallback,useEffect } from 'react';
import { type UseOnboardingOptions,type UseOnboardingReturn,apiSetupMethodToConnectionSetup } from "./onboarding-connection-setup";
export { BASE_SLUG_FOR_METHOD, resolveProviderSetupSelection, resolveSlugForMethod, apiSetupMethodToConnectionSetup } from "./onboarding-connection-setup";

import { useConnectionOnboarding } from "./use-connection-onboarding";
/**
 * useOnboarding Hook
 *
 * Manages the state machine for the onboarding wizard.
 * Flow:
 * 1. Welcome
 * 2. Git Bash (Windows only, if not found)
 * 3. API Setup (API Key / Claude OAuth)
 * 4. Credentials (API Key or Claude OAuth)
 * 5. Complete
 */
/**
 * useOnboarding Hook
 *
 * Manages the state machine for the onboarding wizard.
 * Flow:
 * 1. Welcome
 * 2. Git Bash (Windows only, if not found)
 * 3. API Setup (API Key / Claude OAuth)
 * 4. Credentials (API Key or Claude OAuth)
 * 5. Complete
 */





import type { OnboardingState,ApiSetupMethod } from '@/components/onboarding';

import type { LocalModelSubmitData } from '@/components/onboarding/LocalModelStep';

import type { CustomEndpointConfig } from '@config/llm-connections';
import type { ClaudeOAuthIdentityDto } from '../../shared/types';

export function useOnboarding({
  onComplete,
  initialSetupNeeds,
  initialStep = 'provider-select',
  initialApiSetupMethod,
  onDismiss,
  onConfigSaved,
  editingSlug = null,
  existingSlugs = new Set(),
}: UseOnboardingOptions): UseOnboardingReturn {
  // Main wizard state
  const [state, setState] = useState<OnboardingState>(omitUndefined({
    step: initialStep,
    loginStatus: 'idle' as const,
    credentialStatus: 'idle' as const,
    completionStatus: 'saving' as const,
    apiSetupMethod: initialApiSetupMethod ?? null,
    isExistingUser: initialSetupNeeds?.needsBillingConfig ?? false,
    gitBashStatus: undefined,
    isRecheckingGitBash: false as const,
    isCheckingGitBash: true as const, // Start as true until check completes
  }))

  // Check Git Bash on Windows at mount. If missing, redirect to git-bash step
  // regardless of the initial step (provider-select skips the welcome gate).
  useEffect(() => {
    const checkGitBash = async () => {
      try {
        const status = await window.electronAPI.checkGitBash()
        setState(s => ({
          ...s,
          gitBashStatus: status,
          isCheckingGitBash: false,
          // Redirect to git-bash step when missing on Windows
          ...(status.platform === 'win32' && !status.found ? { step: 'git-bash' as const } : {}),
        }))
      } catch (error) {
        console.error('[Onboarding] Failed to check Git Bash:', error)
        // Even on error, allow continuing (will skip git-bash step)
        setState(s => ({ ...s, isCheckingGitBash: false }))
      }
    }
    checkGitBash()
  }, [])

  // Save configuration using the new unified LLM connection API
  // Returns true on success, false on failure (sets errorMessage on failure)
  // `methodOverride` lets callers pass the method explicitly to avoid stale-closure issues
  // (e.g. when called from an async OAuth flow whose closure predates the state update).
  const handleSaveConfig = useCallback(async (
    credential?: string,
    options?: {
      baseUrl?: string
      connectionDefaultModel?: string
      models?: string[]
      piAuthProvider?: string
      googleCloudProject?: string
      modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier'
      customEndpoint?: CustomEndpointConfig
      iamCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
      awsRegion?: string
      bedrockAuthMethod?: 'iam_credentials' | 'environment'
      oauthIdentity?: ClaudeOAuthIdentityDto
    },
    methodOverride?: ApiSetupMethod,
    connectionSlugOverride?: string,
    updateOnly?: boolean,
  ): Promise<boolean> => {
    const method = methodOverride ?? state.apiSetupMethod
    if (!method) {
      return false
    }

    setState(s => ({ ...s, completionStatus: 'saving' }))

    try {
      // Build connection setup from UI state
      const setup = apiSetupMethodToConnectionSetup(method, {
        ...(credential !== undefined ? { credential: credential } : {}),
        ...(options?.baseUrl !== undefined ? { baseUrl: options?.baseUrl } : {}),
        ...(options?.connectionDefaultModel !== undefined ? { connectionDefaultModel: options?.connectionDefaultModel } : {}),
        ...(options?.models !== undefined ? { models: options?.models } : {}),
        ...(options?.piAuthProvider !== undefined ? { piAuthProvider: options?.piAuthProvider } : {}),
        ...(options?.googleCloudProject !== undefined ? { googleCloudProject: options?.googleCloudProject } : {}),
        ...(options?.modelSelectionMode !== undefined ? { modelSelectionMode: options?.modelSelectionMode } : {}),
        ...(options?.customEndpoint !== undefined ? { customEndpoint: options?.customEndpoint } : {}),
        ...(options?.iamCredentials !== undefined ? { iamCredentials: options?.iamCredentials } : {}),
        ...(options?.awsRegion !== undefined ? { awsRegion: options?.awsRegion } : {}),
        ...(options?.bedrockAuthMethod !== undefined ? { bedrockAuthMethod: options?.bedrockAuthMethod } : {}),
        ...(options?.oauthIdentity !== undefined ? { oauthIdentity: options?.oauthIdentity } : {}),
      }, connectionSlugOverride ?? editingSlug, existingSlugs)
      // Use new unified API
      const result = await window.electronAPI.setupLlmConnection(
        updateOnly ? { ...setup, updateOnly: true } : setup
      )

      if (result.success) {
        setState(s => ({ ...s, completionStatus: 'complete' }))
        // Notify caller immediately so UI can reflect billing/model changes
        onConfigSaved?.()
        return true
      } else {
        console.error('[Onboarding] Save failed:', result.error)
        setState(s => ({
          ...s,
          completionStatus: 'saving',
          errorMessage: result.error || 'Failed to save configuration',
        }))
        return false
      }
    } catch (error) {
      console.error('[Onboarding] handleSaveConfig error:', error)
      setState(s => ({
        ...s,
        errorMessage: error instanceof Error ? error.message : 'Failed to save configuration',
      }))
      return false
    }
  }, [state.apiSetupMethod, onConfigSaved, editingSlug, existingSlugs])

  // Continue to next step
  const handleContinue = useCallback(async () => {
    switch (state.step) {
      case 'provider-select':
        // Handled by handleSelectProvider (card click navigates directly)
        break

      case 'welcome':
        // On Windows, check if Git Bash is needed
        if (state.gitBashStatus?.platform === 'win32' && !state.gitBashStatus?.found) {
          setState(s => ({ ...s, step: 'git-bash' }))
        } else {
          setState(s => ({ ...s, step: 'provider-select' }))
        }
        break

      case 'git-bash':
        setState(s => ({ ...s, step: 'provider-select' }))
        break

      case 'local-model':
        // Handled by handleSubmitLocalModel
        break

      case 'credentials':
        // Handled by handleSubmitCredential
        break

      case 'complete':
        onComplete()
        break
    }
  }, [state.step, state.gitBashStatus, onComplete])

  // Go back to previous step. If at the initial step, call onDismiss instead.
  const handleBack = useCallback(() => {
    if (state.step === initialStep && onDismiss) {
      onDismiss()
      return
    }
    switch (state.step) {
      case 'git-bash':
        if (onDismiss) {
          onDismiss()
        }
        break
      case 'provider-select':
        // If on Windows and Git Bash was needed, go back to git-bash step
        if (state.gitBashStatus?.platform === 'win32' && state.gitBashStatus?.found === false) {
          setState(s => ({ ...s, step: 'git-bash' }))
        } else if (onDismiss) {
          onDismiss()
        }
        break
      case 'credentials':
        setState(s => (omitUndefined<OnboardingState>({ ...s, step: 'provider-select', credentialStatus: 'idle', errorMessage: undefined })))
        break
      case 'local-model':
        setState(s => (omitUndefined<OnboardingState>({ ...s, step: 'provider-select', credentialStatus: 'idle', errorMessage: undefined })))
        break
    }
  }, [state.step, state.gitBashStatus, initialStep, onDismiss])

  // Select API setup method (legacy — kept for direct edit flows)
  const handleSelectApiSetupMethod = useCallback((method: ApiSetupMethod) => {
    setState(s => (omitUndefined<OnboardingState>({ ...s, apiSetupMethod: method, preferredPiPreset: undefined })))
  }, [])
  const { handleSubmitCredential, saveAndValidateConnection, isWaitingForCode, setIsWaitingForCode, copilotDeviceCode, handleStartOAuth, handleSelectProvider } = useConnectionOnboarding({
    setState,
    state,
    handleSaveConfig,
    editingSlug,
    existingSlugs,
  })

  // Submit authorization code (second step of OAuth flow)
  const handleSubmitAuthCode = useCallback(async (code: string) => {
    if (!code.trim()) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: 'Please enter the authorization code',
      }))
      return
    }

    setState(s => (omitUndefined<OnboardingState>({ ...s, credentialStatus: 'validating', errorMessage: undefined })))

    try {
      const connectionSlug = apiSetupMethodToConnectionSetup('claude_oauth', {}, editingSlug, existingSlugs).slug
      const result = await window.electronAPI.exchangeClaudeCode(code.trim(), connectionSlug)

      if (result.success && result.token) {
        setIsWaitingForCode(false)
        await saveAndValidateConnection(connectionSlug, 'claude_oauth', result.token, !!editingSlug, result.identity)
      } else {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: result.error || 'Failed to exchange code',
        }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to exchange code',
      }))
    }
  }, [saveAndValidateConnection, editingSlug, existingSlugs, setIsWaitingForCode])

  // Submit local model configuration (Ollama or any OpenAI-compatible local server)
  const handleSubmitLocalModel = useCallback(async (data: LocalModelSubmitData) => {
    setState(s => (omitUndefined<OnboardingState>({ ...s, credentialStatus: 'validating', errorMessage: undefined })))

    try {
      // apiSetupMethod was set to 'anthropic_api_key' when entering local-model step
      const saved = await handleSaveConfig(undefined, {
        baseUrl: data.baseUrl,
        connectionDefaultModel: data.model,
        models: data.models,
        customEndpoint: { api: 'openai-completions' },
      })

      if (saved) {
        setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
      } else {
        setState(s => ({ ...s, credentialStatus: 'error' }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to save configuration',
      }))
    }
  }, [handleSaveConfig])

  // Cancel OAuth flow
  const handleCancelOAuth = useCallback(async () => {
    setIsWaitingForCode(false)
    setState(s => (omitUndefined<OnboardingState>({ ...s, credentialStatus: 'idle', errorMessage: undefined })))
    // Clear OAuth state on backend
    await window.electronAPI.clearClaudeOAuthState()
  }, [setIsWaitingForCode])

  // Git Bash handlers (Windows only)
  const handleBrowseGitBash = useCallback(async () => {
    return window.electronAPI.browseForGitBash()
  }, [])

  const handleUseGitBashPath = useCallback(async (path: string) => {
    const result = await window.electronAPI.setGitBashPath(path)
    if (result.success) {
      // Update state to mark Git Bash as found and continue
      setState(s => ({
        ...s,
        gitBashStatus: { ...s.gitBashStatus!, found: true, path },
        step: 'provider-select',
      }))
    } else {
      setState(s => ({
        ...s,
        errorMessage: result.error || 'Invalid path',
      }))
    }
  }, [])

  const handleRecheckGitBash = useCallback(async () => {
    setState(s => ({ ...s, isRecheckingGitBash: true }))
    try {
      const status = await window.electronAPI.checkGitBash()
      setState(s => ({
        ...s,
        gitBashStatus: status,
        isRecheckingGitBash: false,
        // If found, automatically continue to next step
        step: status.found ? 'provider-select' : s.step,
      }))
    } catch (error) {
      console.error('[Onboarding] Failed to recheck Git Bash:', error)
      setState(s => ({ ...s, isRecheckingGitBash: false }))
    }
  }, [])

  const handleClearError = useCallback(() => {
    setState(s => (omitUndefined<OnboardingState>({ ...s, errorMessage: undefined })))
  }, [])

  // Skip setup — user chose "Setup later"
  const handleSkipSetup = useCallback(async () => {
    try {
      await window.electronAPI.deferSetup()
    } catch (error) {
      console.error('[Onboarding] Failed to defer setup:', error)
    }
    onComplete()
  }, [onComplete])

  // Finish onboarding
  const handleFinish = useCallback(() => {
    onComplete()
  }, [onComplete])

  // Cancel onboarding
  const handleCancel = useCallback(() => {
    setState(s => ({ ...s, step: 'welcome' }))
  }, [])

  // Jump directly to credentials step with a pre-set method (for editing existing connections)
  const jumpToCredentials = useCallback((method: ApiSetupMethod) => {
    setState(s => (omitUndefined<OnboardingState>({
      ...s,
      step: 'credentials' as const,
      apiSetupMethod: method,
      credentialStatus: 'idle' as const,
      errorMessage: undefined,
    })))
  }, [])

  // Reset onboarding to initial state (used after logout or modal close)
  const reset = useCallback(() => {
    setState(omitUndefined({
      step: initialStep,
      loginStatus: 'idle' as const,
      credentialStatus: 'idle' as const,
      completionStatus: 'saving' as const,
      apiSetupMethod: initialApiSetupMethod ?? null,
      isExistingUser: false as const,
      errorMessage: undefined,
    }))
    setIsWaitingForCode(false)
    // Clean up any pending OAuth state
    window.electronAPI.clearClaudeOAuthState().catch(() => {
      // Ignore errors - state may not exist
    })
  }, [initialStep, initialApiSetupMethod, setIsWaitingForCode])

  return {
    state,
    handleContinue,
    handleBack,
    handleSelectProvider,
    handleSelectApiSetupMethod,
    handleSubmitCredential,
    handleSubmitLocalModel,
    handleStartOAuth,
    // Two-step OAuth flow
    isWaitingForCode,
    handleSubmitAuthCode,
    handleCancelOAuth,
    // Copilot device code
    ...(copilotDeviceCode !== undefined ? { copilotDeviceCode: copilotDeviceCode } : {}),
    // Git Bash (Windows)
    handleBrowseGitBash,
    handleUseGitBashPath,
    handleRecheckGitBash,
    handleClearError,
    handleSkipSetup,
    handleFinish,
    handleCancel,
    jumpToCredentials,
    reset,
  }
}
