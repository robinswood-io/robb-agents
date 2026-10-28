/**
 * AutomationCard
 *
 * Expandable inline row for compact automation display.
 * Collapsed: shows name + summary. Expanded: shows trigger, actions, and controls.
 */


import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AutomationAvatar } from './AutomationAvatar'
import { AutomationActionPreview } from './AutomationActionPreview'
import { Switch } from '@/components/ui/switch'
import { getEventDisplayName, type AutomationListItem } from './types'

export interface AutomationCardProps {
  automation: AutomationListItem
  defaultExpanded?: boolean | undefined
  onToggleEnabled?: ((enabled: boolean) => void) | undefined
  onTest?: (() => void) | undefined
  className?: string | undefined
}

export function AutomationCard({
  automation,
  defaultExpanded = false,
  onToggleEnabled,
  onTest,
  className,
}: AutomationCardProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <div
      className={cn(
        'rounded-[8px] bg-background shadow-minimal overflow-hidden transition-all',
        !automation.enabled && 'opacity-50',
        className
      )}
    >
      {/* Collapsed header */}
      <div className="flex w-full items-center hover:bg-foreground/2 transition-colors">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
        >
          {/* Expand chevron */}
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}

          {/* Avatar */}
          <AutomationAvatar event={automation.event} size="sm" />

          {/* Name + summary */}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{automation.name}</div>
            <div className="text-xs text-foreground/50 truncate">{automation.summary}</div>
          </div>

        </button>

        {/* Enable toggle stays separate from the expansion button. */}
        <div className="pr-4">
          <Switch
            aria-label={automation.name}
            checked={automation.enabled}
            onCheckedChange={(checked) => onToggleEnabled?.(checked)}
          />
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border/30 px-4 py-3 space-y-3">
          {/* Trigger info */}
          <div className="space-y-1">
            <h5 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{t('automations.sectionWhen')}</h5>
            <div className="text-xs text-foreground/70">
              <span className="font-medium">{getEventDisplayName(automation.event)}</span>
              {automation.matcher && (
                <span className="ml-2">
                  {t('automations.matching')} <code className="font-mono bg-foreground/5 px-1 rounded">{automation.matcher}</code>
                </span>
              )}
              {automation.cron && (
                <span className="ml-2">
                  {t('automations.at')} <code className="font-mono bg-foreground/5 px-1 rounded">{automation.cron}</code>
                </span>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="space-y-1">
            <h5 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{t('automations.sectionThen')}</h5>
            <AutomationActionPreview actions={automation.actions} />
          </div>

          {/* Actions bar */}
          <div className="flex items-center gap-2 pt-1">
            {onTest && (
              <button
                onClick={onTest}
                className="px-2.5 py-1 text-xs font-medium rounded-md bg-foreground/[0.03] shadow-minimal hover:bg-foreground/[0.06] transition-colors"
              >
                {t('automations.runTest')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
