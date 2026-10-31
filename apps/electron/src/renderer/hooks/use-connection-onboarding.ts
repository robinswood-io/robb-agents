import type { TestLlmConnectionParams } from '../../../../../packages/shared/src/protocol/dto/connections.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import { useState, useCallback } from 'react';
import { resolveProviderSetupSelection, isLoopbackEndpoint, apiSetupMethodToConnectionSetup } from "./onboarding-connection-setup";
import type { OnboardingState, ApiSetupMethod } from '@/components/onboarding';
import type { ProviderChoice } from '@/components/onboarding/ProviderSelectStep';

import type { ApiKeySubmitData } from '@/components/apisetup';
import type { CustomEndpointConfig } from '@config/llm-connections';
import type { ClaudeOAuthIdentityDto } from '../../shared/types';

interface useConnectionOnboardingInput {
  setState: import("react").Dispatch<import("react").SetStateAction<OnboardingState>>
  state: OnboardingState
  handleSaveConfig: (credential?: string, options?: { baseUrl?: string; connectionDefaultModel?: string; models?: string[]; piAuthProvider?: string; googleCloudProject?: string; modelSelectionMode?: "automaticallySyncedFromProvider" | "userDefined3Tier"; customEndpoint?: CustomEndpointConfig; iamCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string; }; awsRegion?: string; bedrockAuthMethod?: "iam_credentials" | "environment"; oauthIdentity?: ClaudeOAuthIdentityDto; }, methodOverride?: ApiSetupMethod, connectionSlugOverride?: string, updateOnly?: boolean) => Promise<boolean>
  editingSlug: string | null
  existingSlugs: Set<string>
}

export function useConnectionOnboarding({
  setState,
  state,
  handleSaveConfig,
  editingSlug,
  existingSlugs,
}: useConnectionOnboardingInput) {
const handleSubmitCredential = useCallback(async (data: ApiKeySubmitData) => {
    setState(s => (omitUndefined<OnboardingState>({ ...s, credentialStatus: 'validating', errorMessage: undefined })))

    const isPiApiKeyFlow = state.apiSetupMethod === 'pi_api_key'

    try {
      // Bedrock (Pi+amazon-bedrock) — skip API key validation and connection test
      if (data.bedrockAuthMethod) {
        const saved = await handleSaveConfig(undefined, omitUndefined({
          baseUrl: data.baseUrl,
          connectionDefaultModel: data.connectionDefaultModel,
          models: data.models,
          piAuthProvider: data.piAuthProvider,
          modelSelectionMode: data.modelSelectionMode,
          iamCredentials: data.iamCredentials,
          awsRegion: data.awsRegion,
          bedrockAuthMethod: data.bedrockAuthMethod,
        }))
        if (saved) {
          setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
        } else {
          setState(s => ({ ...s, credentialStatus: 'error' }))
        }
        return
      }

      // When editing an existing connection, API key is optional (empty = keep existing credential)
      if (!data.apiKey.trim() && editingSlug) {
        const saved = await handleSaveConfig(undefined, omitUndefined({
          baseUrl: data.baseUrl,
          connectionDefaultModel: data.connectionDefaultModel,
          models: data.models,
          piAuthProvider: data.piAuthProvider,
          modelSelectionMode: data.modelSelectionMode,
          customEndpoint: data.customEndpoint,
        }))
        if (saved) {
          setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
        } else {
          setState(s => ({ ...s, credentialStatus: 'error' }))
        }
        return
      }

      // API key validation differs by endpoint locality:
      // - Local/loopback custom endpoints may be keyless (e.g. Ollama)
      // - Non-local endpoints require an API key
      const isLoopbackCustomEndpoint = isLoopbackEndpoint(data.baseUrl)
      if (isPiApiKeyFlow) {
        if (!data.apiKey.trim() && !isLoopbackCustomEndpoint) {
          setState(s => ({
            ...s,
            credentialStatus: 'error',
            errorMessage: 'Please enter a valid API key',
          }))
          return
        }
      } else {
        if (!data.apiKey.trim() && !isLoopbackCustomEndpoint) {
          setState(s => ({
            ...s,
            credentialStatus: 'error',
            errorMessage: 'Please enter a valid API key',
          }))
          return
        }
      }

      // Validate connection by spawning a lightweight subprocess test.
      // Custom endpoint protocol routes through PiAgent at runtime, so test with Pi too.
      const setupTestProvider = data.customEndpoint ? 'pi' : (isPiApiKeyFlow ? 'pi' : 'anthropic')
      const effectivePiAuthProvider = data.piAuthProvider
      const testResult = await window.electronAPI.testLlmConnectionSetup(omitUndefined<TestLlmConnectionParams>({
        provider: setupTestProvider,
        apiKey: data.apiKey,
        ...(data.baseUrl !== undefined ? { baseUrl: data.baseUrl } : {}),
        model: data.models?.[0],
        ...(effectivePiAuthProvider !== undefined ? { piAuthProvider: effectivePiAuthProvider } : {}),
        ...(data.customEndpoint !== undefined ? { customEndpoint: data.customEndpoint } : {}),
      }))

      if (!testResult.success) {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: testResult.error || 'Connection test failed',
        }))
        return
      }

      const saved = await handleSaveConfig(data.apiKey, omitUndefined({
        baseUrl: data.baseUrl,
        connectionDefaultModel: data.connectionDefaultModel,
        models: data.models,
        piAuthProvider: effectivePiAuthProvider,
        modelSelectionMode: data.modelSelectionMode,
        customEndpoint: data.customEndpoint,
      }))

      if (saved) {
        setState(s => ({
          ...s,
          credentialStatus: 'success',
          step: 'complete',
        }))
      } else {
        // Save failed — error is already set by handleSaveConfig, stay on credentials step
        setState(s => ({ ...s, credentialStatus: 'error' }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'Validation failed',
      }))
    }
  }, [handleSaveConfig, state.apiSetupMethod, editingSlug, setState])

const saveAndValidateConnection = useCallback(async (
    connectionSlug: string,
    method: ApiSetupMethod,
    credential?: string,
    updateOnly?: boolean,
    oauthIdentity?: ClaudeOAuthIdentityDto,
    googleCloudProject?: string,
  ): Promise<boolean> => {
    const setupOptions = oauthIdentity || googleCloudProject
      ? { ...(oauthIdentity ? { oauthIdentity } : {}), ...(googleCloudProject ? { googleCloudProject } : {}) }
      : undefined
    const saved = await handleSaveConfig(credential, setupOptions, method, connectionSlug, updateOnly)
    if (!saved) {
      setState(s => ({ ...s, credentialStatus: 'error' }))
      return false
    }
    const testResult = await window.electronAPI.testLlmConnection(connectionSlug)
    if (testResult.success) {
      setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
      return true
    } else {
      setState(s => ({ ...s, credentialStatus: 'error', errorMessage: testResult.error || 'Connection test failed' }))
      return false
    }
  }, [handleSaveConfig, setState])

const [isWaitingForCode, setIsWaitingForCode] = useState(false)

const [copilotDeviceCode, setCopilotDeviceCode] = useState<{ userCode: string; verificationUri: string } | undefined>()

const handleStartOAuth = useCallback(async (
    methodOverride?: ApiSetupMethod,
    connectionSlugOverride?: string,
    googleCloudProject?: string,
  ) => {
    const effectiveMethod = methodOverride ?? state.apiSetupMethod

    if (methodOverride && methodOverride !== state.apiSetupMethod) {
      setState(s => (omitUndefined<OnboardingState>({
        ...s,
        apiSetupMethod: methodOverride,
        step: 'credentials',
        credentialStatus: 'validating',
        errorMessage: undefined,
      })))
    } else {
      setState(s => (omitUndefined<OnboardingState>({ ...s, credentialStatus: 'validating', errorMessage: undefined })))
    }

    if (!effectiveMethod) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: 'Select an authentication method first.',
      }))
      return
    }

    try {
      // ChatGPT OAuth (single-step flow - opens browser, captures tokens automatically)
      if (effectiveMethod === 'pi_chatgpt_oauth') {
        const effectiveEditingSlug = connectionSlugOverride ?? editingSlug
        const isReauth = !!effectiveEditingSlug
        const connectionSlug = apiSetupMethodToConnectionSetup(effectiveMethod, {}, effectiveEditingSlug, existingSlugs).slug
        const result = await window.electronAPI.startChatGptOAuth(connectionSlug)

        if (result.success) {
          await saveAndValidateConnection(connectionSlug, effectiveMethod, undefined, isReauth)
        } else {
          setState(s => ({
            ...s,
            credentialStatus: 'error',
            errorMessage: result.error || 'ChatGPT authentication failed',
          }))
        }
        return
      }

      // Mistral Vibe subscription (delegated browser flow owned by Vibe)
      if (effectiveMethod === 'pi_mistral_vibe_subscription') {
        const effectiveEditingSlug = connectionSlugOverride ?? editingSlug
        const isReauth = !!effectiveEditingSlug
        const connectionSlug = apiSetupMethodToConnectionSetup(effectiveMethod, {}, effectiveEditingSlug, existingSlugs).slug
        const result = await window.electronAPI.startMistralVibeSetup()
        if (result.success) {
          await saveAndValidateConnection(connectionSlug, effectiveMethod, undefined, isReauth)
        } else {
          setState(s => ({ ...s, credentialStatus: 'error', errorMessage: result.error || 'Mistral Vibe setup failed' }))
        }
        return
      }

      // Google Antigravity subscription (official CLI owns the browser login
      // and keeps its credential in the operating-system keyring).
      if (effectiveMethod === 'pi_google_antigravity_subscription') {
        const effectiveEditingSlug = connectionSlugOverride ?? editingSlug
        const isReauth = !!effectiveEditingSlug
        const connectionSlug = apiSetupMethodToConnectionSetup(effectiveMethod, {}, effectiveEditingSlug, existingSlugs).slug
        const result = await window.electronAPI.startGoogleAntigravitySetup()
        if (result.success) {
          await saveAndValidateConnection(connectionSlug, effectiveMethod, undefined, isReauth)
        } else {
          setState(s => ({ ...s, credentialStatus: 'error', errorMessage: result.error || 'Google Antigravity setup failed' }))
        }
        return
      }

      if (effectiveMethod === 'pi_gemini_oauth') {
        const trimmedProject = googleCloudProject?.trim() ?? ''
        if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(trimmedProject)) {
          setState(s => ({
            ...s,
            credentialStatus: 'error',
            errorMessage: 'Enter a valid Google Cloud project ID before signing in.',
          }))
          return
        }
        const effectiveEditingSlug = connectionSlugOverride ?? editingSlug
        const isReauth = !!effectiveEditingSlug
        const connectionSlug = apiSetupMethodToConnectionSetup(effectiveMethod, {}, effectiveEditingSlug, existingSlugs).slug
        const result = await window.electronAPI.startGeminiOAuth(connectionSlug)

        if (result.success) {
          await saveAndValidateConnection(connectionSlug, effectiveMethod, undefined, isReauth, undefined, trimmedProject)
        } else {
          setState(s => ({
            ...s,
            credentialStatus: 'error',
            errorMessage: result.error || 'Google authentication failed',
          }))
        }
        return
      }

      // Copilot OAuth (device flow — polls for token after user enters code on GitHub)
      if (effectiveMethod === 'pi_copilot_oauth') {
        const effectiveEditingSlug = connectionSlugOverride ?? editingSlug
        const isReauth = !!effectiveEditingSlug
        const connectionSlug = apiSetupMethodToConnectionSetup(effectiveMethod, {}, effectiveEditingSlug, existingSlugs).slug

        // Subscribe to device code event before starting the flow
        const cleanup = window.electronAPI.onCopilotDeviceCode((data) => {
          setCopilotDeviceCode(data)
        })

        try {
          const result = await window.electronAPI.startCopilotOAuth(connectionSlug)

          if (result.success) {
            await saveAndValidateConnection(connectionSlug, effectiveMethod, undefined, isReauth)
          } else {
            setState(s => ({
              ...s,
              credentialStatus: 'error',
              errorMessage: result.error || 'GitHub authentication failed',
            }))
          }
        } finally {
          cleanup()
          setCopilotDeviceCode(undefined)
        }
        return
      }

      // Claude OAuth (two-step flow - opens browser, user copies code)
      // Remaining method must be claude_oauth
      if (effectiveMethod !== 'claude_oauth') {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: 'This connection uses API keys, not OAuth.',
        }))
        return
      }

      const result = await window.electronAPI.startClaudeOAuth()

      if (result.success) {
        // Browser opened successfully, now waiting for user to copy the code
        setIsWaitingForCode(true)
        setState(s => ({ ...s, credentialStatus: 'idle' }))
      } else {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: result.error || 'Failed to start OAuth',
        }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'OAuth failed',
      }))
    }
  }, [state.apiSetupMethod, saveAndValidateConnection, editingSlug, existingSlugs, setState])

const handleSelectProvider = useCallback((choice: ProviderChoice) => {
    if (choice === 'local') {
      // Local uses anthropic_api_key with custom endpoint (Ollama doesn't need an API key)
      setState(s => (omitUndefined<OnboardingState>({ ...s, step: 'local-model', apiSetupMethod: 'anthropic_api_key', credentialStatus: 'idle', errorMessage: undefined })))
      return
    }

    const selection = resolveProviderSetupSelection(choice)
    const method = selection.method
    setState(s => (omitUndefined<OnboardingState>({
      ...s,
      apiSetupMethod: method,
      preferredPiPreset: selection.preferredPiPreset,
      step: 'credentials',
      credentialStatus: 'idle',
      errorMessage: undefined,
    })))

    // OAuth methods start immediately
    if (selection.startOAuth) {
      // Defer to next tick so state is updated before handleStartOAuth reads it
      setTimeout(() => handleStartOAuth(method), 0)
    }
  }, [handleStartOAuth, setState])
return { handleSubmitCredential, saveAndValidateConnection, isWaitingForCode, setIsWaitingForCode, copilotDeviceCode, setCopilotDeviceCode, handleStartOAuth, handleSelectProvider }
}
