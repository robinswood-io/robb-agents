import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Image as ImageIcon } from 'lucide-react';


import { cn } from '@/lib/utils';




import { isCompatProvider, modelSupportsImages, type LlmConnectionWithStatus } from '@config/llm-connections';
import { type ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels';


import { stripPiPrefixForDisplay } from "./model-picker-helpers";



export interface CompactModelSelectorProps {
  currentModel: string
  currentConnection?: string
  onModelChange: (model: string, connection?: string) => void
  onConnectionChange?: (connectionSlug: string) => void | Promise<void>
  thinkingLevel?: ThinkingLevel
  onThinkingLevelChange?: (level: ThinkingLevel) => void
  isEmptySession?: boolean
  connectionUnavailable?: boolean
  contextStatus?: {
    isCompacting?: boolean
    inputTokens?: number
    contextWindow?: number
  }
  /** Provider handoff is rejected while the current turn is processing. */
  disabled?: boolean
}


export function LockedSingleRow({
  modelId,
  connection,
  onToggleVision,
}: {
  modelId: string
  connection: LlmConnectionWithStatus | null
  onToggleVision: (connectionSlug: string, modelId: string, enabled: boolean) => Promise<void>
}) {
  const { t } = useTranslation()
  const showVision = !!connection && isCompatProvider(connection.providerType)
  const visionOn = !!(showVision && connection && modelSupportsImages(connection, modelId))
  return (
    <div className="flex items-center justify-between px-3 py-2 rounded-lg opacity-80 select-none">
      <div className="min-w-0">
        <div className="text-sm font-medium truncate">{stripPiPrefixForDisplay(modelId)}</div>
        <div className="text-xs text-foreground/50">{t('chat.connectionDefault')}</div>
      </div>
      <div className="flex items-center gap-1 ml-3 shrink-0">
        {showVision && connection && (
          <VisionToggle
            visionOn={visionOn}
            onToggle={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onToggleVision(connection.slug, modelId, !visionOn)
            }}
          />
        )}
        <Check className="h-3 w-3 text-foreground/60" />
      </div>
    </div>
  )
}


export function VisionToggle({
  visionOn,
  onToggle,
}: {
  visionOn: boolean
  onToggle: (e: React.MouseEvent | React.KeyboardEvent) => void
}) {
  const { t } = useTranslation()
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={visionOn
        ? t('chat.modelPicker.supportsImagesOn')
        : t('chat.modelPicker.supportsImagesOff')}
      className="inline-flex items-center justify-center p-2 rounded hover:bg-foreground/5 cursor-pointer"
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onToggle(e)
      }}
    >
      <ImageIcon
        className={cn(
          'h-3.5 w-3.5',
          visionOn ? 'text-foreground/70' : 'text-foreground/30',
        )}
      />
    </span>
  )
}
