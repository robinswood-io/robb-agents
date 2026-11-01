import type * as React from "react";
import type { TFunction } from "i18next";
import type { PiModelInfo } from "./tier-models";
import { type PresetKey } from "./submit-helpers";
import type { CustomEndpointApi, CustomEndpointConfig } from '@config/llm-connections';
import { ROBINSWOOD_BACKEND_NAME } from '@craft-agent/shared/robinswood-branding';


export type ApiKeyStatus = 'idle' | 'validating' | 'success' | 'error'


export interface ApiKeySubmitData {
  apiKey: string
  baseUrl?: string | undefined
  connectionDefaultModel?: string
  models?: string[]
  piAuthProvider?: string
  modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier'
  /** Custom endpoint protocol — set when user configures an arbitrary API endpoint */
  customEndpoint?: CustomEndpointConfig
  /** IAM credentials for Pi+Bedrock (piAuthProvider='amazon-bedrock') setup */
  iamCredentials?: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
  }
  /** AWS region for Pi+Bedrock */
  awsRegion?: string
  /** Bedrock authentication method — determines auth type for Pi+Bedrock connections */
  bedrockAuthMethod?: 'iam_credentials' | 'environment'
}


export interface ApiKeyInputProps {
  /** Current validation status */
  status: ApiKeyStatus
  /** Error message to display when status is 'error' */
  errorMessage?: string | undefined
  /** Called when the form is submitted with the key and optional endpoint config */
  onSubmit: (data: ApiKeySubmitData) => void
  /** Form ID for external submit button binding (default: "api-key-form") */
  formId?: string | undefined
  /** Disable the input (e.g. during validation) */
  disabled?: boolean | undefined
  /** Provider type determines which presets and placeholders to show */
  providerType?: 'anthropic' | 'openai' | 'pi' | 'google' | 'pi_api_key' | undefined
  /** Pre-fill values when editing an existing connection */
  initialValues?: {
    apiKey?: string
    baseUrl?: string
    connectionDefaultModel?: string
    activePreset?: string
    models?: string[]
    /** Pre-fill the protocol toggle for custom endpoints */
    customApi?: CustomEndpointApi
  } | undefined
}


export interface Preset {
  key: PresetKey
  label: string
  url: string
  placeholder?: string
}


// Anthropic provider presets - for Claude Code backend
// Also used by Pi API key flow (same providers, routed via Pi SDK)
export const ANTHROPIC_PRESETS: Preset[] = [
  { key: 'anthropic', label: 'Anthropic', url: 'https://api.anthropic.com', placeholder: 'sk-ant-...' },
  { key: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', placeholder: 'sk-...' },
  { key: 'openai-eu', label: 'OpenAI EU', url: 'https://eu.api.openai.com/v1', placeholder: 'sk-...' },
  { key: 'openai-us', label: 'OpenAI US', url: 'https://us.api.openai.com/v1', placeholder: 'sk-...' },
  { key: 'google', label: 'Google AI Studio', url: 'https://generativelanguage.googleapis.com/v1beta', placeholder: 'AIza...' },
  { key: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', placeholder: 'sk-or-...' },
  { key: 'azure-openai-responses', label: 'Azure OpenAI', url: '', placeholder: 'Paste your key here...' },
  { key: 'amazon-bedrock', label: 'Amazon Bedrock', url: 'https://bedrock-runtime.us-east-1.amazonaws.com', placeholder: 'AKIA...' },
  { key: 'groq', label: 'Groq', url: 'https://api.groq.com/openai/v1', placeholder: 'gsk_...' },
  { key: 'mistral', label: 'Mistral', url: 'https://api.mistral.ai/v1', placeholder: 'Paste your key here...' },
  { key: 'deepseek', label: 'DeepSeek', url: 'https://api.deepseek.com', placeholder: 'sk-...' },
  { key: 'xai', label: 'xAI (Grok)', url: 'https://api.x.ai/v1', placeholder: 'xai-...' },
  { key: 'cerebras', label: 'Cerebras', url: 'https://api.cerebras.ai/v1', placeholder: 'csk-...' },
  { key: 'zai', label: 'z.ai (GLM)', url: 'https://api.z.ai/api/coding/paas/v4', placeholder: 'Paste your key here...' },
  { key: 'huggingface', label: 'Hugging Face', url: 'https://router.huggingface.co/v1', placeholder: 'hf_...' },
  { key: 'minimax-global', label: 'Minimax Global', url: 'https://api.minimax.io/anthropic', placeholder: 'Paste your key here...' },
  { key: 'minimax-cn', label: 'Minimax CN', url: 'https://api.minimaxi.com/anthropic', placeholder: 'Paste your key here...' },
  { key: 'kimi-coding', label: 'Kimi (Coding)', url: 'https://api.kimi.com/coding', placeholder: 'sk-kimi-...' },
  { key: 'vercel-ai-gateway', label: 'Vercel AI Gateway', url: 'https://ai-gateway.vercel.sh', placeholder: 'Paste your key here...' },
  { key: 'manifest', label: 'Manifest', url: 'https://app.manifest.build/v1', placeholder: 'mnfst_...' },
  { key: 'custom', label: 'Custom', url: '', placeholder: 'Paste your key here...' },
]


/**
 * Presets without a Pi SDK provider entry that nonetheless expose a known
 * OpenAI-compatible protocol. They behave like 'custom' on submit (customEndpoint
 * gets pinned to openai-completions) but stay branded in the dropdown.
 */
export const OPENAI_COMPAT_CUSTOM_URL_PRESETS: ReadonlySet<string> = new Set(['manifest'])


// OpenAI provider presets - for Codex backend
// Only direct OpenAI is supported; 3PP providers (OpenRouter, Vercel, Ollama) should be
// configured via the Anthropic/Claude connection which routes through the Claude Agent SDK.
export const OPENAI_PRESETS: Preset[] = [
  { key: 'openai', label: 'OpenAI', url: '' },
]


// Pi provider presets - unified API for 20+ LLM providers
export const PI_PRESETS: Preset[] = [
  { key: 'pi', label: `${ROBINSWOOD_BACKEND_NAME} (Direct)`, url: '' },
  { key: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api' },
  { key: 'custom', label: 'Custom', url: '' },
]


// Google AI Studio preset - single endpoint, no custom URL needed
export const GOOGLE_PRESETS: Preset[] = [
  { key: 'google', label: 'Google AI Studio', url: '' },
]


/** Presets that require the Pi SDK for authentication — hidden in Anthropic API Key mode */
export const PI_ONLY_PRESET_KEYS: ReadonlySet<string> = new Set(['minimax-global', 'minimax-cn'])


export const COMPAT_ANTHROPIC_DEFAULTS = 'claude-opus-5, claude-fable-5-1, claude-opus-4-8, claude-sonnet-5, claude-sonnet-4-6, claude-haiku-4-5'

export const COMPAT_OPENAI_DEFAULTS = 'openai/gpt-6.1-sol, openai/gpt-6-astra, openai/gpt-5.6-sol, openai/gpt-5.6-luna'

export const COMPAT_MINIMAX_DEFAULTS = 'MiniMax-M3, MiniMax-M2.7, MiniMax-M2.7-highspeed'

export const COMPAT_KIMI_DEFAULTS = 'k2p7, kimi-for-coding, kimi-k2-thinking'


// These are recommendations, not a restriction: all native Mistral models
// remain selectable in the tier dropdowns. The order is frontier agentic,
// efficient general-purpose agentic, then utility/summarization.
export const MISTRAL_AGENTIC_TIER_RECOMMENDATIONS = [
  'pi/mistral-medium-3.5',
  'pi/mistral-small-latest',
  'pi/ministral-3b-latest',
]


export function getPresetsForProvider(providerType: 'anthropic' | 'openai' | 'pi' | 'google' | 'pi_api_key'): Preset[] {
  if (providerType === 'pi_api_key') return ANTHROPIC_PRESETS
  if (providerType === 'google') return GOOGLE_PRESETS
  if (providerType === 'pi') return PI_PRESETS
  if (providerType === 'openai') return OPENAI_PRESETS
  // Anthropic mode: exclude presets that only work via Pi SDK
  return ANTHROPIC_PRESETS.filter(p => !PI_ONLY_PRESET_KEYS.has(p.key))
}


export function getPresetForUrl(url: string, presets: Preset[]): PresetKey {
  const match = presets.find(p => p.key !== 'custom' && p.url === url)
  return match?.key ?? 'custom'
}


export function parseModelList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export interface ApiKeyInputViewProps {
  formId: string
  handleSubmit: (e: React.FormEvent<Element>) => void
  isBedrock: boolean
  showValue: boolean
  apiKey: string
  setApiKey: React.Dispatch<React.SetStateAction<string>>
  apiKeyPlaceholder: string
  status: ApiKeyStatus
  isDisabled: boolean
  setShowValue: React.Dispatch<React.SetStateAction<boolean>>
  presets: Preset[]
  activePreset: string
  handlePresetSelect: (preset: Preset) => void
  usesManagedProviderEndpoint: boolean
  baseUrl: string
  handleBaseUrlChange: (value: string) => void
  setCustomApi: React.Dispatch<React.SetStateAction<CustomEndpointApi>>
  customApi: CustomEndpointApi
  setBedrockAuthMethod: React.Dispatch<React.SetStateAction<"iam_credentials" | "environment">>
  bedrockAuthMethod: "iam_credentials" | "environment"
  awsAccessKeyId: string
  setAwsAccessKeyId: React.Dispatch<React.SetStateAction<string>>
  awsSecretAccessKey: string
  setAwsSecretAccessKey: React.Dispatch<React.SetStateAction<string>>
  t: TFunction<"translation", undefined>
  awsSessionToken: string
  setAwsSessionToken: React.Dispatch<React.SetStateAction<string>>
  awsRegion: string
  setAwsRegion: React.Dispatch<React.SetStateAction<string>>
  hasPiModels: boolean
  piModelsLoading: boolean
  tierConfigs: { label: string; desc: string; value: string; onChange: React.Dispatch<React.SetStateAction<string>>; }[]
  openTier: string | null
  setOpenTier: React.Dispatch<React.SetStateAction<string | null>>
  setTierFilter: React.Dispatch<React.SetStateAction<string>>
  setTierDropdownPosition: React.Dispatch<React.SetStateAction<{ top: number; left: number; width: number; } | null>>
  tierFilterInputRef: React.RefObject<HTMLInputElement | null>
  piModels: PiModelInfo[]
  activeTierConfig: { label: string; desc: string; value: string; onChange: React.Dispatch<React.SetStateAction<string>>; } | null | undefined
  tierDropdownPosition: { top: number; left: number; width: number; } | null
  tierFilter: string
  modelError: string | null
  connectionDefaultModel: string
  setConnectionDefaultModel: React.Dispatch<React.SetStateAction<string>>
  setModelError: React.Dispatch<React.SetStateAction<string | null>>
  errorMessage: string | undefined
}

export const DEFAULT_ENDPOINT_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'openai', 'pi', 'google'])
