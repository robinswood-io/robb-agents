import type { OnboardingState, OnboardingStep, ApiSetupMethod } from '@/components/onboarding';
import type { ProviderChoice } from '@/components/onboarding/ProviderSelectStep';
import type { LocalModelSubmitData } from '@/components/onboarding/LocalModelStep';
import type { ApiKeySubmitData } from '@/components/apisetup';
import type { CustomEndpointConfig } from '@config/llm-connections';
import type { SetupNeeds, LlmConnectionSetup, ClaudeOAuthIdentityDto } from "../../shared/types";


export interface UseOnboardingOptions {
  /** Called when onboarding is complete */
  onComplete: () => void
  /** Initial setup needs from auth state check */
  initialSetupNeeds?: SetupNeeds
  /** Start the wizard at a specific step (default: 'welcome') */
  initialStep?: OnboardingStep
  /** Pre-select an API setup method (useful when editing an existing connection) */
  initialApiSetupMethod?: ApiSetupMethod
  /** Called when user goes back from the initial step (dismisses the wizard) */
  onDismiss?: () => void
  /** Called immediately after config is saved to disk (before wizard closes).
   *  Use this to propagate billing/model changes to the UI without waiting for onComplete. */
  onConfigSaved?: () => void
  /** Slug of existing connection being edited (null = creating new) */
  editingSlug?: string | null
  /** Set of slugs already in use (for generating unique slugs when creating new) */
  existingSlugs?: Set<string>
}


export interface UseOnboardingReturn {
  // State
  state: OnboardingState

  // Wizard actions
  handleContinue: () => void
  handleBack: () => void

  // Provider select (new flow)
  handleSelectProvider: (choice: ProviderChoice) => void

  // API Setup (legacy — kept for direct edit)
  handleSelectApiSetupMethod: (method: ApiSetupMethod) => void

  // Credentials
  handleSubmitCredential: (data: ApiKeySubmitData) => void

  // Local model
  handleSubmitLocalModel: (data: LocalModelSubmitData) => void
  handleStartOAuth: (methodOverride?: ApiSetupMethod, connectionSlugOverride?: string, googleCloudProject?: string) => void

  // Claude OAuth (two-step flow)
  isWaitingForCode: boolean
  handleSubmitAuthCode: (code: string) => void
  handleCancelOAuth: () => void

  // Copilot device code (displayed during device flow)
  copilotDeviceCode?: { userCode: string; verificationUri: string }

  // Git Bash (Windows)
  handleBrowseGitBash: () => Promise<string | null>
  handleUseGitBashPath: (path: string) => void
  handleRecheckGitBash: () => void
  handleClearError: () => void

  // Skip setup ("Setup later")
  handleSkipSetup: () => void

  // Completion
  handleFinish: () => void
  handleCancel: () => void

  // Direct edit (skip method selection, jump to credentials)
  jumpToCredentials: (method: ApiSetupMethod) => void

  // Reset
  reset: () => void
}


// Base slug for each setup method (used as template key in ipc.ts)
export const BASE_SLUG_FOR_METHOD: Record<ApiSetupMethod, string> = {
  anthropic_api_key: 'anthropic-api',
  claude_oauth: 'claude-max',
  pi_chatgpt_oauth: 'chatgpt-plus',
  pi_copilot_oauth: 'github-copilot',
  pi_gemini_oauth: 'google-gemini',
  pi_google_antigravity_subscription: 'google-antigravity',
  pi_mistral_vibe_subscription: 'mistral-vibe',
  pi_api_key: 'pi-api-key',
}


export interface ProviderSetupSelection {
  method: ApiSetupMethod
  preferredPiPreset?: string
  startOAuth: boolean
}


/**
 * Resolve the safe default setup for a provider card. Google account access
 * uses the official Antigravity CLI; the legacy Code Assist OAuth method
 * remains available from direct setup for separately licensed organizations.
 */
export function resolveProviderSetupSelection(
  choice: Exclude<ProviderChoice, 'local'>,
): ProviderSetupSelection {
  const selections: Record<Exclude<ProviderChoice, 'local'>, ProviderSetupSelection> = {
    claude: { method: 'claude_oauth', startOAuth: true },
    chatgpt: { method: 'pi_chatgpt_oauth', startOAuth: true },
    copilot: { method: 'pi_copilot_oauth', startOAuth: true },
    google: { method: 'pi_google_antigravity_subscription', startOAuth: true },
    mistral: { method: 'pi_mistral_vibe_subscription', startOAuth: false },
    api_key: { method: 'pi_api_key', startOAuth: false },
  }
  return selections[choice]
}


/**
 * Generate a unique slug for a new connection.
 * If the base slug is taken, appends -2, -3, etc.
 * When editingSlug is provided, reuses that slug (editing existing connection).
 */
export function resolveSlugForMethod(
  method: ApiSetupMethod,
  editingSlug: string | null,
  existingSlugs: Set<string>,
): string {
  // Editing an existing connection — reuse its slug
  if (editingSlug) return editingSlug

  const base = BASE_SLUG_FOR_METHOD[method]
  if (!existingSlugs.has(base)) return base

  let i = 2
  while (existingSlugs.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}


// Map ApiSetupMethod to LlmConnectionSetup for the new unified connection system
export function isLoopbackEndpoint(baseUrl?: string): boolean {
  if (!baseUrl?.trim()) return false
  try {
    const hostname = new URL(baseUrl.trim()).hostname
    const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname
    return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1'
  } catch {
    return false
  }
}


export function apiSetupMethodToConnectionSetup(
  method: ApiSetupMethod,
  options: {
    credential?: string
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
  editingSlug: string | null,
  existingSlugs: Set<string>,
): LlmConnectionSetup {
  const slug = resolveSlugForMethod(method, editingSlug, existingSlugs)

  switch (method) {
    case 'anthropic_api_key':
      return {
        slug,
        credential: options.credential,
        baseUrl: options.baseUrl,
        defaultModel: options.connectionDefaultModel,
        models: options.models,
        customEndpoint: options.customEndpoint,
      }
    case 'claude_oauth':
      return {
        slug,
        credential: options.credential,
        oauthIdentity: options.oauthIdentity,
      }
    case 'pi_chatgpt_oauth':
    case 'pi_copilot_oauth':
      return {
        slug,
        credential: options.credential,
      }
    case 'pi_gemini_oauth':
      return {
        slug,
        credential: options.credential,
        googleCloudProject: options.googleCloudProject,
      }
    case 'pi_google_antigravity_subscription':
      return { slug }
    case 'pi_mistral_vibe_subscription':
      return { slug }
    case 'pi_api_key':
      return {
        slug,
        credential: options.credential,
        baseUrl: options.baseUrl,
        defaultModel: options.connectionDefaultModel,
        models: options.models,
        piAuthProvider: options.piAuthProvider,
        modelSelectionMode: options.modelSelectionMode,
        customEndpoint: options.customEndpoint,
        iamCredentials: options.iamCredentials,
        awsRegion: options.awsRegion,
        bedrockAuthMethod: options.bedrockAuthMethod,
      }
  }
}
