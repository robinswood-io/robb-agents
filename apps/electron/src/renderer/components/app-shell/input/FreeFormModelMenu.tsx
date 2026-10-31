import * as React from 'react';

import { Check, ChevronDown, AlertCircle, Image as ImageIcon } from 'lucide-react';
import { Spinner } from '@craft-agent/ui';
import * as storage from '@/lib/local-storage';

import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuSub } from '@/components/ui/dropdown-menu';
import { StyledDropdownMenuContent, StyledDropdownMenuItem, StyledDropdownMenuSeparator, StyledDropdownMenuSubTrigger, StyledDropdownMenuSubContent } from '@/components/ui/styled-dropdown';
import { cn } from '@/lib/utils';

import { ANTHROPIC_MODELS, getModelShortName, type ModelDefinition } from '@config/models';
import { isCompatProvider, modelSupportsImages } from '@config/llm-connections';

import { ConnectionIcon } from '@/components/icons/ConnectionIcon';

import { type ThinkingLevel, getThinkingLevelNameKey } from '@craft-agent/shared/agent/thinking-levels';

import { formatTokenCount, getSelectableConnectionModels, stripPiPrefixForDisplay } from './model-picker-helpers';

interface FreeFormModelMenuProps {
  modelDropdownOpen: boolean
  setModelDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>
  isProcessing: boolean
  connectionUnavailable: boolean
  t: import("i18next").TFunction<"translation", undefined>
  selectorDisplayName: string
  effectiveConnectionDetails: import("@config/llm-connections").LlmConnectionWithStatus | null
  llmConnections: import("@config/llm-connections").LlmConnectionWithStatus[]
  pickerMode: import("./picker-mode").PickerMode
  connectionDefaultModel: string | null
  handleToggleModelVision: import("./useModelVisionToggle").ToggleModelVision
  connectionsByProvider: [string, import("@config/llm-connections").LlmConnectionWithStatus[]][]
  effectiveConnection: string | undefined
  currentModel: string
  onConnectionChange: ((connectionSlug: string) => void) | undefined
  onModelChange: (model: string | null, connection?: string) => void
  isEmptySession: boolean
  currentConnectionDetails: import("@config/llm-connections").LlmConnectionWithStatus | null
  availableModels: (string | ModelDefinition)[]
  availableThinkingLevels: readonly import("@craft-agent/shared/agent").ThinkingLevelDefinition[]
  thinkingDisabled: boolean
  thinkingLevel: "off" | "low" | "medium" | "high" | "xhigh" | "max"
  onThinkingLevelChange: ((level: ThinkingLevel) => void) | undefined
  contextStatus: { isCompacting?: boolean; inputTokens?: number; contextWindow?: number; } | undefined
}

export function FreeFormModelMenu({
  modelDropdownOpen,
  setModelDropdownOpen,
  isProcessing,
  connectionUnavailable,
  t,
  selectorDisplayName,
  effectiveConnectionDetails,
  llmConnections,
  pickerMode,
  connectionDefaultModel,
  handleToggleModelVision,
  connectionsByProvider,
  effectiveConnection,
  currentModel,
  onConnectionChange,
  onModelChange,
  isEmptySession,
  currentConnectionDetails,
  availableModels,
  availableThinkingLevels,
  thinkingDisabled,
  thinkingLevel,
  onThinkingLevelChange,
  contextStatus,
}: FreeFormModelMenuProps) {
  return (
<DropdownMenu open={modelDropdownOpen} onOpenChange={setModelDropdownOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    data-testid="model-selector-trigger"
                    disabled={isProcessing}
                    aria-label={connectionUnavailable
                      ? t('common.unavailable')
                      : `${t('common.model')}: ${selectorDisplayName}`}
                    className={cn(
                      "input-toolbar-btn inline-flex items-center h-7 px-1.5 gap-0.5 text-[13px] shrink-0 rounded-[6px] hover:bg-foreground/5 transition-colors select-none",
                      modelDropdownOpen && "bg-foreground/5",
                      connectionUnavailable && "text-destructive",
                    )}
                  >
                    {connectionUnavailable ? (
                      <>
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                        {t('common.unavailable')}
                      </>
                    ) : (
                      <>
                        {effectiveConnectionDetails && llmConnections.length > 1 && storage.get(storage.KEYS.showConnectionIcons, true) && <ConnectionIcon connection={effectiveConnectionDetails} size={14} showTooltip />}
                        <span className="truncate max-w-[180px]">{selectorDisplayName}</span>
                        {!isProcessing && pickerMode !== 'locked-single' && <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />}
                      </>
                    )}
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">
                {t('common.model')}
              </TooltipContent>
            </Tooltip>
            <StyledDropdownMenuContent side="top" align="end" sideOffset={8} className="min-w-[260px]">
              {/* Connection unavailable message */}
              {pickerMode === 'unavailable' ? (
                <div className="flex flex-col items-center justify-center py-6 px-4 text-center">
                  <AlertCircle className="h-8 w-8 text-destructive mb-2" />
                  <div className="font-medium text-sm mb-1">{t('chat.connectionUnavailable')}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('chat.connectionUnavailableDescription')}
                  </div>
                </div>
              ) : pickerMode === 'locked-single' && connectionDefaultModel ? (
                (() => {
                  // Single-model pi_compat connection on a non-empty session (or
                  // when there's only one connection, so no switcher to show).
                  // Model row is disabled (locked to this session); vision toggle
                  // remains interactive.
                  const showVisionToggle =
                    !!effectiveConnectionDetails && isCompatProvider(effectiveConnectionDetails.providerType)
                  const visionOn = showVisionToggle && modelSupportsImages(effectiveConnectionDetails!, connectionDefaultModel)
                  return (
                    <StyledDropdownMenuItem
                      disabled
                      className="flex items-center justify-between px-2 py-2 rounded-lg"
                    >
                      <div className="text-left">
                        <div className="font-medium text-sm">{stripPiPrefixForDisplay(connectionDefaultModel)}</div>
                        <div className="text-xs text-muted-foreground">{t('chat.connectionDefault')}</div>
                      </div>
                      <div className="flex items-center gap-1 ml-3 shrink-0">
                        {showVisionToggle && effectiveConnectionDetails && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span
                                role="button"
                                tabIndex={0}
                                aria-label={visionOn
                                  ? t('chat.modelPicker.supportsImagesOn')
                                  : t('chat.modelPicker.supportsImagesOff')}
                                className="inline-flex items-center justify-center p-1 rounded pointer-events-auto opacity-100 hover:bg-foreground/5 cursor-pointer"
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  handleToggleModelVision(effectiveConnectionDetails.slug, connectionDefaultModel, !visionOn)
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    handleToggleModelVision(effectiveConnectionDetails.slug, connectionDefaultModel, !visionOn)
                                  }
                                }}
                              >
                                <ImageIcon className={cn(
                                  "h-3.5 w-3.5",
                                  visionOn ? "text-foreground/70" : "text-foreground/30"
                                )} />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {visionOn
                                ? t('chat.modelPicker.supportsImagesOn')
                                : t('chat.modelPicker.supportsImagesOff')}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {(
                          <Check className="h-3 w-3 text-foreground" />
                        )}
                      </div>
                    </StyledDropdownMenuItem>
                  )
                })()
              ) : pickerMode === 'switcher' ? (
                /* Explicit provider → connection → model selection between turns. */
                connectionsByProvider.map(([providerName, connections], index) => (
                  <React.Fragment key={providerName}>
                    {/* Provider group label */}
                    <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide select-none">
                      {providerName}
                    </div>
                    {connections.map((conn) => {
                      const isCurrentConnection = effectiveConnection === conn.slug
                      const isAuthenticated = conn.isAuthenticated
                      return (
                        <DropdownMenuSub key={conn.slug}>
                          <StyledDropdownMenuSubTrigger
                            data-testid="model-connection-option"
                            disabled={!isAuthenticated}
                            className={cn(
                              "flex items-center justify-between px-2 py-2 rounded-lg",
                              isCurrentConnection && "bg-foreground/5"
                            )}
                          >
                            <div className="text-left flex-1">
                              <div className="font-medium text-sm flex items-center gap-1.5">
                                <ConnectionIcon connection={conn} size={14} />
                                {conn.name}
                                {isCurrentConnection && <Check className="h-3 w-3 text-foreground" />}
                              </div>
                              {!isAuthenticated && (
                                <div className="text-xs text-muted-foreground">{t('settings.ai.notAuthenticated')}</div>
                              )}
                            </div>
                          </StyledDropdownMenuSubTrigger>
                          {isAuthenticated && (
                            <StyledDropdownMenuSubContent className="min-w-[220px]">
                              {/* Show models for this connection - use provider-specific models as fallback */}
                              {getSelectableConnectionModels(conn, ANTHROPIC_MODELS).map((model) => {
                                const modelId = typeof model === 'string' ? model : model.id
                                const modelName = typeof model === 'string'
                                  ? stripPiPrefixForDisplay(getModelShortName(model))
                                  : (model.name ?? stripPiPrefixForDisplay(model.id))
                                const isSelectedModel =
                                                                    isCurrentConnection && currentModel === modelId
                                const showVisionToggle = isCompatProvider(conn.providerType)
                                const visionOn = showVisionToggle && modelSupportsImages(conn, modelId)
                                return (
                                  <StyledDropdownMenuItem
                                    key={modelId}
                                    onSelect={async () => {
                                      // Finish the connection handoff before persisting its explicit model.
                                      if (!isCurrentConnection && onConnectionChange) {
                                        await onConnectionChange(conn.slug)
                                      }
                                      // Always pass connection with model for proper persistence
                                      onModelChange(modelId, conn.slug)
                                    }}
                                    className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
                                  >
                                    <div className="font-medium text-sm">{modelName}</div>
                                    <div className="flex items-center gap-1 ml-3 shrink-0">
                                      {showVisionToggle && (
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <span
                                              role="button"
                                              tabIndex={0}
                                              aria-label={visionOn
                                                ? t('chat.modelPicker.supportsImagesOn')
                                                : t('chat.modelPicker.supportsImagesOff')}
                                              className="inline-flex items-center justify-center p-1 rounded hover:bg-foreground/5 cursor-pointer"
                                              onClick={(e) => {
                                                e.preventDefault()
                                                e.stopPropagation()
                                                handleToggleModelVision(conn.slug, modelId, !visionOn)
                                              }}
                                              onKeyDown={(e) => {
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                  e.preventDefault()
                                                  e.stopPropagation()
                                                  handleToggleModelVision(conn.slug, modelId, !visionOn)
                                                }
                                              }}
                                            >
                                              <ImageIcon className={cn(
                                                "h-3.5 w-3.5",
                                                visionOn ? "text-foreground/70" : "text-foreground/30"
                                              )} />
                                            </span>
                                          </TooltipTrigger>
                                          <TooltipContent>
                                            {visionOn
                                              ? t('chat.modelPicker.supportsImagesOn')
                                              : t('chat.modelPicker.supportsImagesOff')}
                                          </TooltipContent>
                                        </Tooltip>
                                      )}
                                      {isSelectedModel && (
                                        <Check className="h-3 w-3 text-foreground" />
                                      )}
                                    </div>
                                  </StyledDropdownMenuItem>
                                )
                              })}
                            </StyledDropdownMenuSubContent>
                          )}
                        </DropdownMenuSub>
                      )
                    })}
                    {index < connectionsByProvider.length - 1 && (
                      <StyledDropdownMenuSeparator className="my-1" />
                    )}
                  </React.Fragment>
                ))
              ) : (
                /* Flat model list (single connection or session started) */
                <>
                  {/* Indicator showing which connection is being used */}
                  {!isEmptySession && currentConnectionDetails && llmConnections.length > 1 && (
                    <>
                      <div className="flex items-center gap-2 px-2 py-1.5 text-xs select-none text-muted-foreground">
                        <span>{t('chat.usingConnection', { name: currentConnectionDetails.name })}</span>
                      </div>
                      <StyledDropdownMenuSeparator className="my-1" />
                    </>
                  )}
                  {/* Model options based on effective connection's provider type */}
                  {availableModels.map((model) => {
                    const modelId = typeof model === 'string' ? model : model.id
                    const modelName = typeof model === 'string'
                      ? stripPiPrefixForDisplay(getModelShortName(model))
                      : (model.name ?? stripPiPrefixForDisplay(model.id))
                    const isSelected = currentModel === modelId
                    const descriptionKey = typeof model !== 'string' && 'descriptionKey' in model ? (model.descriptionKey as string) : undefined
                    const description = descriptionKey ? t(descriptionKey) : (typeof model !== 'string' && 'description' in model ? (model.description as string) : '')
                    const showVisionToggle =
                      !!effectiveConnectionDetails && isCompatProvider(effectiveConnectionDetails.providerType)
                    const visionOn = showVisionToggle && modelSupportsImages(effectiveConnectionDetails!, modelId)
                    return (
                      <StyledDropdownMenuItem
                        key={modelId}
                        onSelect={() => onModelChange(modelId, effectiveConnection)}
                        className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
                      >
                        <div className="text-left">
                          <div className="font-medium text-sm">{modelName}</div>
                          {description && (
                            <div className="text-xs text-muted-foreground">{description}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 ml-3 shrink-0">
                          {showVisionToggle && effectiveConnectionDetails && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  role="button"
                                  tabIndex={0}
                                  aria-label={visionOn
                                    ? t('chat.modelPicker.supportsImagesOn')
                                    : t('chat.modelPicker.supportsImagesOff')}
                                  className="inline-flex items-center justify-center p-1 rounded hover:bg-foreground/5 cursor-pointer"
                                  onClick={(e) => {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    handleToggleModelVision(effectiveConnectionDetails.slug, modelId, !visionOn)
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault()
                                      e.stopPropagation()
                                      handleToggleModelVision(effectiveConnectionDetails.slug, modelId, !visionOn)
                                    }
                                  }}
                                >
                                  <ImageIcon className={cn(
                                    "h-3.5 w-3.5",
                                    visionOn ? "text-foreground/70" : "text-foreground/30"
                                  )} />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                {visionOn
                                  ? t('chat.modelPicker.supportsImagesOn')
                                  : t('chat.modelPicker.supportsImagesOff')}
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {isSelected && (
                            <Check className="h-3 w-3 text-foreground" />
                          )}
                        </div>
                      </StyledDropdownMenuItem>
                    )
                  })}
                </>
              )}

              {/* Thinking level selector — only shown when thinking levels are available
                  (Claude supports extended thinking, OpenAI backends may not) */}
              {availableThinkingLevels.length > 0 && (
                <>
                  <StyledDropdownMenuSeparator className="my-1" />

                  <DropdownMenuSub>
                    <StyledDropdownMenuSubTrigger disabled={thinkingDisabled} className={cn("flex items-center justify-between px-2 py-2 rounded-lg", thinkingDisabled && "opacity-50 cursor-not-allowed")}>
                      <div className="text-left flex-1">
                        <div className="font-medium text-sm">{t(getThinkingLevelNameKey(thinkingLevel))}</div>
                        <div className="text-xs text-muted-foreground">{thinkingDisabled ? t('thinking.notSupported') : t('thinking.extendedDesc')}</div>
                      </div>
                    </StyledDropdownMenuSubTrigger>
                    <StyledDropdownMenuSubContent className="min-w-[220px]">
                      {availableThinkingLevels.map(({ id, nameKey, descriptionKey }) => {
                        const isSelected = thinkingLevel === id
                        return (
                          <StyledDropdownMenuItem
                            key={id}
                            onSelect={() => onThinkingLevelChange?.(id)}
                            className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
                          >
                            <div className="text-left">
                              <div className="font-medium text-sm">{t(nameKey)}</div>
                              <div className="text-xs text-muted-foreground">{t(descriptionKey)}</div>
                            </div>
                            {isSelected && (
                              <Check className="h-3 w-3 text-foreground shrink-0 ml-3" />
                            )}
                          </StyledDropdownMenuItem>
                        )
                      })}
                    </StyledDropdownMenuSubContent>
                  </DropdownMenuSub>
                </>
              )}

              {/* Context usage footer - only show when we have token data */}
              {contextStatus?.inputTokens != null && contextStatus.inputTokens > 0 && (
                <>
                  <StyledDropdownMenuSeparator className="my-1" />
                  <div className="px-2 py-1.5 select-none">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{t('chat.context')}</span>
                      <span className="flex items-center gap-1.5">
                        {contextStatus.isCompacting && (
                          <Spinner className="h-3 w-3" />
                        )}
                        {t('chat.tokensUsed', { displayCount: formatTokenCount(contextStatus.inputTokens) })}
                      </span>
                    </div>
                  </div>
                </>
              )}
            </StyledDropdownMenuContent>
          </DropdownMenu>
  )
}
