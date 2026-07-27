/**
 * Provider Icons
 *
 * Maps LLM provider types and base URLs to their respective brand icons.
 * Used in AI Settings page and anywhere connection logos are needed.
 */

import awsIcon from '@/assets/provider-icons/aws.svg'
import azureIcon from '@/assets/provider-icons/azure.svg'
import claudeIcon from '@/assets/provider-icons/claude.svg'
import copilotIcon from '@/assets/provider-icons/copilot.svg'
import googleIcon from '@/assets/provider-icons/google.svg'
import huggingfaceIcon from '@/assets/provider-icons/huggingface.svg'
import kimiIcon from '@/assets/provider-icons/kimi.svg'
import minimaxIcon from '@/assets/provider-icons/minimax.svg'
import mistralIcon from '@/assets/provider-icons/mistral.svg'
import ollamaIcon from '@/assets/provider-icons/ollama.svg'
import openaiIcon from '@/assets/provider-icons/openai.svg'
import openrouterIcon from '@/assets/provider-icons/openrouter.svg'
import piIcon from '@/assets/provider-icons/pi.svg'
import vercelIcon from '@/assets/provider-icons/vercel.svg'

import type { LlmProviderType } from '@craft-agent/shared/config/llm-connections'
import { ROBINSWOOD_BACKEND_NAME } from '@craft-agent/shared/robinswood-branding'

/**
 * Icon URLs for each provider
 */
export const providerIcons = {
  anthropic: claudeIcon,
  aws: awsIcon,
  azure: azureIcon,
  copilot: copilotIcon,
  google: googleIcon,
  huggingface: huggingfaceIcon,
  kimi: kimiIcon,
  minimax: minimaxIcon,
  mistral: mistralIcon,
  ollama: ollamaIcon,
  openai: openaiIcon,
  openrouter: openrouterIcon,
  pi: piIcon,
  vercel: vercelIcon,
} as const

export type ProviderIconKey = keyof typeof providerIcons

/** Human-readable provider names */
const providerDisplayNames: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openai_compat: 'OpenAI',
  copilot: 'GitHub Copilot',
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  minimax: 'Minimax',
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
  pi: ROBINSWOOD_BACKEND_NAME,
  pi_compat: ROBINSWOOD_BACKEND_NAME,
  vercel: 'Vercel',
}

function parseProviderHostname(baseUrl: string): string | null {
  try {
    const candidate = baseUrl.includes('://') ? baseUrl : `http://${baseUrl}`
    return new URL(candidate).hostname.toLowerCase()
  } catch {
    return null
  }
}

function matchesProviderHostname(hostname: string, ...domains: string[]): boolean {
  return domains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
}

function hostnameHasSegment(hostname: string, segment: string): boolean {
  return hostname.split('.').some(part => part === segment || part.startsWith(`${segment}-`))
}

/** Get a human-readable provider name from provider type and optional base URL */
export function getProviderDisplayName(providerType: string, baseUrl?: string | null): string {
  // Try URL detection first for compat providers
  if (baseUrl) {
    const hostname = parseProviderHostname(baseUrl)
    if (hostname && matchesProviderHostname(hostname, 'openrouter.ai')) return 'OpenRouter'
    if (hostname && (hostname === 'ollama' || hostname.endsWith('.ollama'))) return 'Ollama'
    if (hostname && matchesProviderHostname(hostname, 'kimi.com')) return 'Kimi'
    if (hostname && matchesProviderHostname(hostname, 'minimax.io', 'minimaxi.com')) return 'Minimax'
    if (hostname && matchesProviderHostname(hostname, 'v0.dev', 'vercel.app', 'vercel.com')) return 'Vercel'
    if (hostname && matchesProviderHostname(hostname, 'manifest.build')) return 'Manifest'
  }
  return providerDisplayNames[providerType] || providerType
}

/**
 * Detect provider from base URL
 */
function detectProviderFromUrl(baseUrl: string): ProviderIconKey | null {
  const hostname = parseProviderHostname(baseUrl)
  if (!hostname) return null

  if (matchesProviderHostname(hostname, 'openrouter.ai')) return 'openrouter'
  if (hostname === 'ollama' || hostname.endsWith('.ollama')) return 'ollama'
  if (matchesProviderHostname(hostname, 'api.anthropic.com')) return 'anthropic'
  if (matchesProviderHostname(hostname, 'api.openai.com')) return 'openai'
  if (matchesProviderHostname(hostname, 'v0.dev', 'vercel.app', 'vercel.com')) return 'vercel'
  if (matchesProviderHostname(hostname, 'generativelanguage.googleapis.com', 'ai.google')) return 'google'
  if (matchesProviderHostname(hostname, 'kimi.com')) return 'kimi'
  if (matchesProviderHostname(hostname, 'minimax.io', 'minimaxi.com')) return 'minimax'
  if (matchesProviderHostname(hostname, 'mistral.ai')) return 'mistral'
  if (hostnameHasSegment(hostname, 'bedrock')) return 'aws'
  if (matchesProviderHostname(hostname, 'huggingface.co')) return 'huggingface'

  return null
}

/**
 * Map Pi SDK auth provider names to icon keys.
 * For Pi connections, we show the actual upstream provider's icon
 * instead of the generic Pi logo.
 */
function piAuthProviderToIcon(piAuthProvider: string): ProviderIconKey | null {
  switch (piAuthProvider) {
    case 'openai':
    case 'openai-codex':
      return 'openai'
    case 'anthropic':
      return 'anthropic'
    case 'github-copilot':
      return 'copilot'
    case 'openrouter':
      return 'openrouter'
    case 'google':
      return 'google'
    case 'kimi-coding':
      return 'kimi'
    case 'minimax':
    case 'minimax-global':
    case 'minimax-cn':
      return 'minimax'
    case 'mistral':
      return 'mistral'
    case 'amazon-bedrock':
      return 'aws'
    case 'azure-openai-responses':
      return 'azure'
    case 'huggingface':
      return 'huggingface'
    case 'vercel-ai-gateway':
      return 'vercel'
    default:
      return null
  }
}

/**
 * Domain map for providers without static SVG icons.
 * Used to generate Google Favicon V2 URLs as fallback.
 */
const PI_AUTH_PROVIDER_DOMAINS: Record<string, string> = {
  groq: 'groq.com',
  xai: 'x.ai',
  cerebras: 'cerebras.ai',
  deepseek: 'deepseek.com',
  zai: 'z.ai',
}

/**
 * Get provider icon URL for a given provider type and optional base URL.
 * Base URL detection takes precedence for compatible providers (openai_compat, pi_compat).
 * For Pi connections, resolves to the upstream provider's icon via piAuthProvider.
 *
 * @param providerType - The LLM provider type
 * @param baseUrl - Optional custom base URL for detection
 * @param piAuthProvider - Optional Pi SDK auth provider (e.g. 'openai-codex', 'github-copilot')
 * @returns Icon URL string or null if no matching icon
 */
export function getProviderIcon(
  providerType: LlmProviderType | string,
  baseUrl?: string | null,
  piAuthProvider?: string | null
): string | null {
  // For compatible providers, try to detect from URL first
  if (baseUrl && (providerType === 'openai_compat' || providerType === 'pi_compat')) {
    const detectedProvider = detectProviderFromUrl(baseUrl)
    if (detectedProvider) {
      return providerIcons[detectedProvider]
    }
    // Manifest has no bundled SVG — fall back to Google Favicon V2 (same trick used for groq/xai elsewhere).
    const hostname = parseProviderHostname(baseUrl)
    if (hostname && matchesProviderHostname(hostname, 'manifest.build')) {
      return 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=128&url=https://app.manifest.build'
    }
  }

  // Map provider type to icon
  switch (providerType) {
    case 'anthropic':
      return providerIcons.anthropic
    case 'openai':
    case 'openai_compat':
      return providerIcons.openai
    case 'copilot':
      return providerIcons.copilot
    case 'pi':
    case 'pi_compat': {
      // Resolve to actual upstream provider icon
      if (piAuthProvider) {
        const iconKey = piAuthProviderToIcon(piAuthProvider)
        if (iconKey) return providerIcons[iconKey]
        // Favicon fallback for providers without static SVGs
        const domain = PI_AUTH_PROVIDER_DOMAINS[piAuthProvider]
        if (domain) {
          return `https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=128&url=https://${domain}`
        }
      }
      return null  // Unknown/custom Pi provider — caller shows brain icon
    }
    default:
      // Try URL detection as fallback
      if (baseUrl) {
        const detectedProvider = detectProviderFromUrl(baseUrl)
        if (detectedProvider) {
          return providerIcons[detectedProvider]
        }
      }
      return null
  }
}
