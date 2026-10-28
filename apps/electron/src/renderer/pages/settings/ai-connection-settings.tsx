import { omitUndefined } from '@craft-agent/shared/utils/json';
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';

import { MoreHorizontal, Pencil, Trash2, Star, CheckCircle2, AlertTriangle, RefreshCcw, Settings2, MessageSquareMore, Zap, Clock, Check } from 'lucide-react';
import type { CredentialHealthIssue } from '../../../shared/types';
import { Tooltip, TooltipTrigger, TooltipContent } from '@craft-agent/ui';

import type { LlmConnectionWithStatus } from '../../../shared/types';

import { ROBINSWOOD_BACKEND_NAME } from '@craft-agent/shared/robinswood-branding';

import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { StyledDropdownMenuContent, StyledDropdownMenuItem, StyledDropdownMenuSeparator, DropdownMenuSub, StyledDropdownMenuSubTrigger, StyledDropdownMenuSubContent } from '@/components/ui/styled-dropdown';

import { ConnectionIcon } from '@/components/icons/ConnectionIcon';
import { SettingsRow } from '@/components/settings';

import { type ApiSetupMethod } from '@/components/onboarding';

import { getModelShortName } from '@config/models';
import { getModelsForProviderType, resolveMidStreamBehavior, type MidStreamBehavior } from '@config/llm-connections';
import { getSelectableConnectionModels } from '@/components/app-shell/input/model-picker-helpers';

export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function getModelOptionsForConnection(
  connection: LlmConnectionWithStatus | undefined,
): Array<{ value: string; label: string; description: string; descriptionKey?: string }> {
  if (!connection) return []

  const models = getSelectableConnectionModels(
    omitUndefined({ ...connection, models: connection.models?.length ? connection.models : undefined }),
    getModelsForProviderType(connection.providerType, connection.piAuthProvider),
  )
  return models.map((model) => typeof model === 'string'
    ? { value: model, label: getModelShortName(model), description: '' }
    : omitUndefined({ value: model.id, label: model.name, description: model.description, descriptionKey: model.descriptionKey }),
  )
}

export function getHealthIssueMessage(issue: CredentialHealthIssue, t: (key: string) => string): string {
  switch (issue.type) {
    case 'file_corrupted':
      return t("settings.ai.credentialCorrupted")
    case 'decryption_failed':
      return t("settings.ai.credentialOtherMachine")
    case 'no_default_credentials':
      return t("settings.ai.credentialNotFound")
    default:
      return issue.message || 'Credential issue detected.'
  }
}

export interface CredentialHealthBannerProps {
  issues: CredentialHealthIssue[]
  onReauthenticate: () => void
}

export function CredentialHealthBanner({ issues, onReauthenticate }: CredentialHealthBannerProps) {
  const { t } = useTranslation()
  const firstIssue = issues[0]
  if (!firstIssue) return null

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 mb-6">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-amber-700 dark:text-amber-400">
            {t("settings.ai.credentialIssue")}
          </h4>
          <p className="mt-1 text-sm text-amber-600 dark:text-amber-300/80">
            {getHealthIssueMessage(firstIssue, t)}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onReauthenticate}
          className="flex-shrink-0 border-amber-500/30 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10"
        >
          {t("settings.ai.reAuthenticate")}
        </Button>
      </div>
    </div>
  )
}

export const PI_AUTH_PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic API',
  openai: 'OpenAI API',
  'openai-codex': 'OpenAI API',
  google: 'Google AI Studio',
  openrouter: 'OpenRouter',
  'azure-openai-responses': 'Azure OpenAI',
  'amazon-bedrock': 'Amazon Bedrock',
  groq: 'Groq',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  cerebras: 'Cerebras',
  zai: 'z.ai',
  huggingface: 'Hugging Face',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  'github-copilot': 'GitHub Copilot',
  'google-antigravity': 'Google Antigravity',
}

export type ValidationState = 'idle' | 'validating' | 'success' | 'error'

export interface ConnectionRowProps {
  connection: LlmConnectionWithStatus
  isLastConnection: boolean
  onRenameClick: () => void
  onDelete: () => void
  onSetDefault: () => void
  onValidate: () => void
  onReauthenticate: () => void
  onEdit: () => void
  onSetMidStreamBehavior: (behavior: MidStreamBehavior) => void
  validationState: ValidationState
  validationError?: string | undefined
  /** True when another OAuth connection resolves to the same Anthropic account (issue #838) */
  isDuplicateAccount?: boolean | undefined
}

export function ConnectionRow({ connection, isLastConnection, onRenameClick, onDelete, onSetDefault, onValidate, onReauthenticate, onEdit, onSetMidStreamBehavior, validationState, validationError, isDuplicateAccount }: ConnectionRowProps) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [piBaseUrl, setPiBaseUrl] = useState<string | undefined>(undefined)

  // Opening dialog/overlay flows directly from a dropdown item can race with
  // menu teardown and leave a transient interaction lock behind on some systems.
  // Force menu close first, then trigger action on next frame.
  const runAfterMenuClose = useCallback((action: () => void) => {
    setMenuOpen(false)
    requestAnimationFrame(() => {
      action()
    })
  }, [])

  // Load Pi provider base URL via IPC (Pi SDK can't run in renderer)
  useEffect(() => {
    const provider = connection.providerType || connection.type
    if (provider === 'pi' && connection.piAuthProvider && !connection.baseUrl) {
      window.electronAPI.getPiProviderBaseUrl(connection.piAuthProvider).then(url => setPiBaseUrl(url))
    }
  }, [connection.providerType, connection.type, connection.piAuthProvider, connection.baseUrl])

  // Build description with provider, default indicator, auth status, and validation state
  const getDescription = () => {
    // Show validation state if not idle
    if (validationState === 'validating') return t("settings.ai.validating")
    if (validationState === 'success') return t("settings.ai.connectionValid")
    if (validationState === 'error') return validationError || t("settings.ai.validationFailed")

    const parts: string[] = []

    // Provider type (fall back to legacy 'type' field if providerType missing)
    // OAuth = subscription (Pro/Plus/Max), API key = API
    const provider = connection.providerType || connection.type
    const isSubscription = connection.authType === 'oauth'
    switch (provider) {
      case 'anthropic': parts.push(isSubscription ? 'Anthropic Subscription' : 'Anthropic API'); break
      case 'pi': {
        // Show upstream provider name for API key connections (e.g. "Google AI Studio")
        const piLabel = !isSubscription && connection.piAuthProvider
          ? PI_AUTH_PROVIDER_LABELS[connection.piAuthProvider]
          : null
        parts.push(piLabel ?? ROBINSWOOD_BACKEND_NAME)
        break
      }
      case 'pi_compat':
        parts.push(connection.baseUrl?.toLowerCase().includes('manifest.build')
          ? 'Manifest'
          : `${ROBINSWOOD_BACKEND_NAME} Compatible`)
        break
      default: parts.push(provider || 'Unknown')
    }

    // Base URL for API key connections (show custom endpoint or default for provider)
    if (connection.authType !== 'oauth') {
      let endpoint = connection.baseUrl
      // Use default endpoints for standard providers if no custom baseUrl
      if (!endpoint) {
        if (provider === 'anthropic') endpoint = 'https://api.anthropic.com'
        else if (provider === 'pi' && connection.piAuthProvider) {
          endpoint = piBaseUrl
        }
      }
      if (endpoint) {
        // Extract hostname from URL for cleaner display
        try {
          const url = new URL(endpoint)
          parts.push(url.host)
        } catch {
          parts.push(endpoint)
        }
      }
    }

    // Auth status
    if (!connection.isAuthenticated) parts.push(t("settings.ai.notAuthenticated"))

    return parts.join(' · ')
  }

  // Resolved Anthropic identity (issue #838): render `email · org` independently of
  // validation state. It cannot live in getDescription() — that short-circuits for
  // validating/success/error and would hide the identity during those states.
  const oauthIdentityLine = connection.authType === 'oauth' && connection.oauthAccountEmail
    ? [connection.oauthAccountEmail, connection.oauthOrganizationName].filter(Boolean).join(' · ')
    : null

  return (
    <SettingsRow
      label={(
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-1">
            <ConnectionIcon connection={connection} size={14} />
            <span>{connection.name}</span>
            {connection.isDefault && (
              <span className="inline-flex items-center h-5 px-2 text-[11px] font-medium rounded-[4px] bg-background shadow-minimal text-foreground/60">
                {t("common.default")}
              </span>
            )}
            {isDuplicateAccount && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center" aria-label={t("settings.ai.duplicateAccount")}>
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                  </span>
                </TooltipTrigger>
                <TooltipContent>{t("settings.ai.duplicateAccount")}</TooltipContent>
              </Tooltip>
            )}
          </div>
          {oauthIdentityLine && (
            <span className="text-xs text-muted-foreground truncate">{oauthIdentityLine}</span>
          )}
        </div>
      )}
      description={getDescription()}
    >
      <DropdownMenu modal={false} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            className="p-1.5 rounded-md hover:bg-foreground/[0.05] data-[state=open]:bg-foreground/[0.05] transition-colors"
            data-state={menuOpen ? 'open' : 'closed'}
          >
            <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <StyledDropdownMenuContent align="end">
          <StyledDropdownMenuItem onClick={() => runAfterMenuClose(onRenameClick)}>
            <Pencil className="h-3.5 w-3.5" />
            <span>{t("common.rename")}</span>
          </StyledDropdownMenuItem>
          {!connection.isDefault && (
            <StyledDropdownMenuItem onClick={onSetDefault}>
              <Star className="h-3.5 w-3.5" />
              <span>{t("settings.ai.setAsDefault")}</span>
            </StyledDropdownMenuItem>
          )}
          {connection.authType === 'oauth' || connection.piAuthProvider === 'google-antigravity' ? (
            <StyledDropdownMenuItem onClick={() => runAfterMenuClose(onReauthenticate)}>
              <RefreshCcw className="h-3.5 w-3.5" />
              <span>{t("settings.ai.reAuthenticate")}</span>
            </StyledDropdownMenuItem>
          ) : (
            <StyledDropdownMenuItem onClick={() => runAfterMenuClose(onEdit)}>
              <Settings2 className="h-3.5 w-3.5" />
              <span>{t("common.edit")}</span>
            </StyledDropdownMenuItem>
          )}
          <StyledDropdownMenuItem
            onClick={onValidate}
            disabled={validationState === 'validating'}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>{t("settings.ai.validateConnection")}</span>
          </StyledDropdownMenuItem>
          {(() => {
            const currentBehavior = resolveMidStreamBehavior(connection)
            return (
              <DropdownMenuSub>
                <StyledDropdownMenuSubTrigger>
                  <MessageSquareMore className="h-3.5 w-3.5" />
                  <span>{t("settings.ai.midStream.title")}</span>
                </StyledDropdownMenuSubTrigger>
                <StyledDropdownMenuSubContent>
                  <StyledDropdownMenuItem onClick={() => onSetMidStreamBehavior('steer')}>
                    <Zap className="h-3.5 w-3.5" />
                    <span className="flex-1">{t("settings.ai.midStream.steer")}</span>
                    {currentBehavior === 'steer' && <Check className="h-3.5 w-3.5" />}
                  </StyledDropdownMenuItem>
                  <StyledDropdownMenuItem onClick={() => onSetMidStreamBehavior('queue')}>
                    <Clock className="h-3.5 w-3.5" />
                    <span className="flex-1">{t("settings.ai.midStream.queue")}</span>
                    {currentBehavior === 'queue' && <Check className="h-3.5 w-3.5" />}
                  </StyledDropdownMenuItem>
                </StyledDropdownMenuSubContent>
              </DropdownMenuSub>
            )
          })()}
          <StyledDropdownMenuSeparator />
          <StyledDropdownMenuItem
            onClick={onDelete}
            variant="destructive"
            disabled={isLastConnection}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{t("common.delete")}</span>
          </StyledDropdownMenuItem>
        </StyledDropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
  )
}

export function getApiKeyMethodForConnection(conn: LlmConnectionWithStatus): ApiSetupMethod {
  const provider = conn.providerType || conn.type
  if (provider === 'pi' && conn.piAuthProvider === 'google-antigravity') return 'pi_google_antigravity_subscription'
  if (provider === 'pi' && conn.piAuthProvider === 'google-gemini-code-assist') return 'pi_gemini_oauth'
  if (provider === 'pi' || provider === 'pi_compat') return 'pi_api_key'
  return 'anthropic_api_key'
}
