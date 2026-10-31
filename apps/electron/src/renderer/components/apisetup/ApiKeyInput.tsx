import type { ApiKeySubmitData } from './api-key-input-config.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import "cmdk";
import "@/components/ui/input";
import "@/components/ui/label";
import "@/components/ui/styled-dropdown";
import "@/lib/utils";
import "lucide-react";
import { resolveTierModels, type PiModelInfo } from "./tier-models";
import { resolveCustomEndpointPayload, resolvePiAuthProviderForSubmit, resolvePresetStateForBaseUrlChange, type PresetKey } from "./submit-helpers";
import "@craft-agent/shared/robinswood-branding";
import { DEFAULT_ENDPOINT_PROVIDERS, type ApiKeyInputProps, type Preset, OPENAI_COMPAT_CUSTOM_URL_PRESETS, COMPAT_ANTHROPIC_DEFAULTS, COMPAT_OPENAI_DEFAULTS, COMPAT_MINIMAX_DEFAULTS, COMPAT_KIMI_DEFAULTS, MISTRAL_AGENTIC_TIER_RECOMMENDATIONS, getPresetsForProvider, getPresetForUrl, parseModelList } from "./api-key-input-config";

import { ApiKeyInputView } from "./api-key-input-view";
/**
 * ApiKeyInput - Reusable API key entry form control
 *
 * Renders a password input for the API key, a preset selector for Base URL,
 * and an optional Model override field.
 *
 * Does NOT include layout wrappers or action buttons — the parent
 * controls placement via the form ID ("api-key-form") for submit binding.
 *
 * Used in: Onboarding CredentialsStep, Settings API dialog
 */

/**
 * ApiKeyInput - Reusable API key entry form control
 *
 * Renders a password input for the API key, a preset selector for Base URL,
 * and an optional Model override field.
 *
 * Does NOT include layout wrappers or action buttons — the parent
 * controls placement via the form ID ("api-key-form") for submit binding.
 *
 * Used in: Onboarding CredentialsStep, Settings API dialog
 */








export { type ApiKeyStatus, type ApiKeySubmitData, type ApiKeyInputProps } from "./api-key-input-config";











import type { CustomEndpointApi } from '@config/llm-connections';


export type { CustomEndpointApi }

// ============================================================
// Pi model tier selection (for providers with many models)
// ============================================================

export function ApiKeyInput({
  status,
  errorMessage,
  onSubmit,
  formId = "api-key-form",
  disabled,
  providerType = 'anthropic',
  initialValues,
}: ApiKeyInputProps) {
  // Get presets based on provider type
  const presets = getPresetsForProvider(providerType)
  const defaultPreset = presets[0]
  if (!defaultPreset) throw new Error('Provider has no endpoint presets')

  // Compute initial preset: explicit (Pi piAuthProvider), derived from URL, or default.
  const initialPreset = initialValues?.activePreset
    ?? (initialValues?.baseUrl ? getPresetForUrl(initialValues.baseUrl, presets) : defaultPreset.key)
  const initialPresetDefinition = presets.find(preset => preset.key === initialPreset) ?? defaultPreset

  const { t } = useTranslation()
  const [apiKey, setApiKey] = useState(initialValues?.apiKey ?? '')
  const [showValue, setShowValue] = useState(false)
  const [baseUrl, setBaseUrl] = useState(initialValues?.baseUrl ?? initialPresetDefinition.url)
  const [activePreset, setActivePreset] = useState<PresetKey>(initialPreset)
  const [lastNonCustomPreset, setLastNonCustomPreset] = useState<PresetKey | null>(
    initialPreset !== 'custom' ? initialPreset : defaultPreset.key
  )
  const [connectionDefaultModel, setConnectionDefaultModel] = useState(initialValues?.connectionDefaultModel ?? '')
  const [customApi, setCustomApi] = useState<CustomEndpointApi>(initialValues?.customApi ?? 'openai-completions')
  const [modelError, setModelError] = useState<string | null>(null)

  // Bedrock auth state
  const [bedrockAuthMethod, setBedrockAuthMethod] = useState<'iam_credentials' | 'environment'>('iam_credentials')
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('')
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState('')
  const [awsSessionToken, setAwsSessionToken] = useState('')
  const [awsRegion, setAwsRegion] = useState('us-east-1')

  // Pi model tier state (for providers with many models like OpenRouter, Vercel)
  const [piModels, setPiModels] = useState<PiModelInfo[]>([])
  const [piModelsLoading, setPiModelsLoading] = useState(false)
  const [bestModel, setBestModel] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [cheapModel, setCheapModel] = useState('')
  const [openTier, setOpenTier] = useState<string | null>(null)
  const [tierFilter, setTierFilter] = useState('')
  const [tierDropdownPosition, setTierDropdownPosition] = useState<{ top: number; left: number; width: number } | null>(null)
  const tierFilterInputRef = useRef<HTMLInputElement>(null)
  const hydratedTierProviderRef = useRef<string | null>(null)

  const isDisabled = disabled || status === 'validating'

  const isPiApiKeyFlow = providerType === 'pi_api_key'
  const isBedrock = activePreset === 'amazon-bedrock'
  // Hide endpoint/model fields for providers with well-known endpoints handled by the SDK.
  const isDefaultProviderPreset = DEFAULT_ENDPOINT_PROVIDERS.has(activePreset)
  // Branded Pi providers (including Mistral) must use the SDK's native
  // provider endpoint rather than persist a user-visible default URL as a
  // custom endpoint override.
  const isNativePiProvider = isPiApiKeyFlow
    && activePreset !== 'custom'
    && !isBedrock
    && !OPENAI_COMPAT_CUSTOM_URL_PRESETS.has(activePreset)
  const usesManagedProviderEndpoint = isDefaultProviderPreset || isNativePiProvider

  // Provider-specific placeholders from the active preset
  const activePresetObj = presets.find(p => p.key === activePreset)
  const apiKeyPlaceholder = activePresetObj?.placeholder
    ?? (providerType === 'google' ? 'AIza...'
    : providerType === 'pi' ? 'pi-...'
    : providerType === 'openai' ? 'sk-...'
    : 'Paste your key here...')

  // Fetch Pi SDK models when a provider is selected in pi_api_key flow.
  // Returns all models sorted by cost (expensive-first) for the searchable tier dropdowns.
  const loadPiModels = useCallback(async (provider: string) => {
    if (!isPiApiKeyFlow || !provider || provider === 'custom' || DEFAULT_ENDPOINT_PROVIDERS.has(provider) || OPENAI_COMPAT_CUSTOM_URL_PRESETS.has(provider)) {
      setPiModels([])
      return
    }
    setPiModelsLoading(true)
    try {
      const result = await window.electronAPI.getPiProviderModels(provider)
      setPiModels(result.models)

      if (hydratedTierProviderRef.current !== provider) {
        const tiers = resolveTierModels(
          result.models,
          provider === initialPreset ? initialValues?.models : undefined,
          provider === 'mistral' ? MISTRAL_AGENTIC_TIER_RECOMMENDATIONS : undefined,
        )
        setBestModel(tiers.best)
        setDefaultModel(tiers.default_)
        setCheapModel(tiers.cheap)
        hydratedTierProviderRef.current = provider
      }
    } catch (err) {
      console.error('[ApiKeyInput] Failed to load models for', provider, err)
      setPiModels([])
    } finally {
      setPiModelsLoading(false)
    }
  }, [isPiApiKeyFlow, initialPreset, initialValues?.models])

  useEffect(() => {
    loadPiModels(activePreset)
  }, [activePreset, loadPiModels])

  // Whether to show 3 tier dropdowns instead of text input
  const hasPiModels = isPiApiKeyFlow && piModels.length > 0 && !isDefaultProviderPreset && activePreset !== 'custom' && !isBedrock

  const handlePresetSelect = (preset: Preset) => {
    setActivePreset(preset.key)
    if (preset.key !== 'custom') {
      setLastNonCustomPreset(preset.key)
    }
    if (preset.key === 'custom') {
      setBaseUrl('')
    } else {
      setBaseUrl(preset.url)
    }
    setModelError(null)
    // Pre-fill recommended model for Ollama; clear for all others
    // (Default provider presets hide the field entirely, others default to provider model IDs when empty)
    if (preset.key === 'ollama') {
      setConnectionDefaultModel('qwen3-coder')
    } else if (preset.key === 'openrouter' || preset.key === 'vercel-ai-gateway') {
      setConnectionDefaultModel(providerType === 'openai' ? COMPAT_OPENAI_DEFAULTS : COMPAT_ANTHROPIC_DEFAULTS)
    } else if (preset.key === 'minimax-global' || preset.key === 'minimax-cn') {
      setConnectionDefaultModel(COMPAT_MINIMAX_DEFAULTS)
    } else if (preset.key === 'kimi-coding') {
      setConnectionDefaultModel(COMPAT_KIMI_DEFAULTS)
    } else if (preset.key === 'manifest') {
      setConnectionDefaultModel('auto')
    } else if (preset.key === 'custom' || OPENAI_COMPAT_CUSTOM_URL_PRESETS.has(preset.key)) {
      setConnectionDefaultModel(providerType === 'openai' ? COMPAT_OPENAI_DEFAULTS : COMPAT_ANTHROPIC_DEFAULTS)
    } else {
      setConnectionDefaultModel('')
    }
  }

  const handleBaseUrlChange = (value: string) => {
    setBaseUrl(value)
    const presetKey = getPresetForUrl(value, presets)
    const currentPresetObj = presets.find(p => p.key === activePreset)
    const nextPresetState = resolvePresetStateForBaseUrlChange({
      matchedPreset: presetKey,
      activePreset,
      activePresetHasEmptyUrl: currentPresetObj?.url === '',
      lastNonCustomPreset,
    })
    setActivePreset(nextPresetState.activePreset)
    setLastNonCustomPreset(nextPresetState.lastNonCustomPreset)
    setModelError(null)
    if (!connectionDefaultModel.trim()) {
      if (presetKey === 'ollama') {
        setConnectionDefaultModel('qwen3-coder')
      } else if (presetKey === 'manifest') {
        setConnectionDefaultModel('auto')
      } else if (presetKey === 'minimax-global' || presetKey === 'minimax-cn') {
        setConnectionDefaultModel(COMPAT_MINIMAX_DEFAULTS)
      } else if (presetKey === 'kimi-coding') {
        setConnectionDefaultModel(COMPAT_KIMI_DEFAULTS)
      } else if (presetKey === 'openrouter' || presetKey === 'vercel-ai-gateway' || presetKey === 'custom') {
        setConnectionDefaultModel(providerType === 'openai' ? COMPAT_OPENAI_DEFAULTS : COMPAT_ANTHROPIC_DEFAULTS)
      }
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    const effectivePiAuthProvider = isPiApiKeyFlow
      ? resolvePiAuthProviderForSubmit(activePreset, lastNonCustomPreset)
      : undefined

    // Pi API key flow with tier dropdowns — submit selected models
    if (hasPiModels) {
      if (!bestModel || !defaultModel || !cheapModel) {
        setModelError('Please select a model for each tier.')
        return
      }
      const models: string[] = [bestModel, defaultModel, cheapModel]
      onSubmit({
        apiKey: apiKey.trim(),
        // Native Pi providers resolve their API endpoint from the SDK catalog.
        // Persisting the branded URL here would incorrectly turn it into an override.
        baseUrl: undefined,
        connectionDefaultModel: bestModel,
        models,
        ...(effectivePiAuthProvider !== undefined ? { piAuthProvider: effectivePiAuthProvider } : {}),
        modelSelectionMode: 'userDefined3Tier',
      })
      return
    }

    // Bedrock — routes through Pi SDK with piAuthProvider='amazon-bedrock'.
    // Submit with auth method and optional IAM credentials.
    if (isBedrock) {
      if (bedrockAuthMethod === 'iam_credentials' && !awsAccessKeyId.trim()) {
        setModelError('Access Key ID is required for IAM authentication.')
        return
      }
      if (bedrockAuthMethod === 'iam_credentials' && !awsSecretAccessKey.trim()) {
        setModelError('Secret Access Key is required for IAM authentication.')
        return
      }
      const parsedModels = parseModelList(connectionDefaultModel)
      onSubmit(omitUndefined<ApiKeySubmitData>({
        apiKey: '',
        ...(effectivePiAuthProvider !== undefined ? { piAuthProvider: effectivePiAuthProvider } : {}),
        bedrockAuthMethod,
        awsRegion: awsRegion.trim() || 'us-east-1',
        ...(bedrockAuthMethod === 'iam_credentials' ? {
          iamCredentials: {
            accessKeyId: awsAccessKeyId.trim(),
            secretAccessKey: awsSecretAccessKey.trim(),
            ...(awsSessionToken.trim() ? { sessionToken: awsSessionToken.trim() } : {}),
          },
        } : {}),
        connectionDefaultModel: parsedModels[0],
        models: parsedModels.length > 0 ? parsedModels : undefined,
      }))
      return
    }

    const effectiveBaseUrl = baseUrl.trim()

    const parsedModels = parseModelList(connectionDefaultModel)

    const isUsingDefaultEndpoint = usesManagedProviderEndpoint || !effectiveBaseUrl
    const requiresModel = !usesManagedProviderEndpoint && !!effectiveBaseUrl
    if (requiresModel && parsedModels.length === 0) {
      setModelError('Default model is required for custom endpoints.')
      return
    }

    // Include custom endpoint protocol when user configured a custom base URL.
    // Branded openai-compat presets (e.g. Manifest) are pinned to openai-completions
    // and routed via the Pi SDK's openai adapter.
    const { customEndpoint, piAuthProvider: resolvedPiAuthProvider } = resolveCustomEndpointPayload({
      activePreset,
      baseUrl: effectiveBaseUrl,
      customApi,
      brandedOpenAiCompatPresets: OPENAI_COMPAT_CUSTOM_URL_PRESETS,
      fallbackPiAuthProvider: effectivePiAuthProvider,
    })

    onSubmit(omitUndefined<ApiKeySubmitData>({
      apiKey: apiKey.trim(),
      baseUrl: isUsingDefaultEndpoint ? undefined : effectiveBaseUrl,
      connectionDefaultModel: parsedModels[0],
      models: parsedModels.length > 0 ? parsedModels : undefined,
      ...(resolvedPiAuthProvider !== undefined ? { piAuthProvider: resolvedPiAuthProvider } : {}),
      modelSelectionMode: isPiApiKeyFlow
        ? (parsedModels.length > 0 ? 'userDefined3Tier' : 'automaticallySyncedFromProvider')
        : undefined,
      ...(customEndpoint !== undefined ? { customEndpoint: customEndpoint } : {}),
    }))
  }

  const tierConfigs = [
    { label: 'Best', desc: 'most capable', value: bestModel, onChange: setBestModel },
    { label: 'Balanced', desc: 'good for everyday use', value: defaultModel, onChange: setDefaultModel },
    { label: 'Fast', desc: 'summarization & utility', value: cheapModel, onChange: setCheapModel },
  ]
  const activeTierConfig = openTier ? tierConfigs.find(t => t.label === openTier) : null

  return (
    <ApiKeyInputView
      formId={formId}
      handleSubmit={handleSubmit}
      isBedrock={isBedrock}
      showValue={showValue}
      apiKey={apiKey}
      setApiKey={setApiKey}
      apiKeyPlaceholder={apiKeyPlaceholder}
      status={status}
      isDisabled={isDisabled}
      setShowValue={setShowValue}
      presets={presets}
      activePreset={activePreset}
      handlePresetSelect={handlePresetSelect}
      usesManagedProviderEndpoint={usesManagedProviderEndpoint}
      baseUrl={baseUrl}
      handleBaseUrlChange={handleBaseUrlChange}
      setCustomApi={setCustomApi}
      customApi={customApi}
      setBedrockAuthMethod={setBedrockAuthMethod}
      bedrockAuthMethod={bedrockAuthMethod}
      awsAccessKeyId={awsAccessKeyId}
      setAwsAccessKeyId={setAwsAccessKeyId}
      awsSecretAccessKey={awsSecretAccessKey}
      setAwsSecretAccessKey={setAwsSecretAccessKey}
      t={t}
      awsSessionToken={awsSessionToken}
      setAwsSessionToken={setAwsSessionToken}
      awsRegion={awsRegion}
      setAwsRegion={setAwsRegion}
      hasPiModels={hasPiModels}
      piModelsLoading={piModelsLoading}
      tierConfigs={tierConfigs}
      openTier={openTier}
      setOpenTier={setOpenTier}
      setTierFilter={setTierFilter}
      setTierDropdownPosition={setTierDropdownPosition}
      tierFilterInputRef={tierFilterInputRef}
      piModels={piModels}
      activeTierConfig={activeTierConfig}
      tierDropdownPosition={tierDropdownPosition}
      tierFilter={tierFilter}
      modelError={modelError}
      connectionDefaultModel={connectionDefaultModel}
      setConnectionDefaultModel={setConnectionDefaultModel}
      setModelError={setModelError}
      errorMessage={errorMessage}
    />
  )
}
