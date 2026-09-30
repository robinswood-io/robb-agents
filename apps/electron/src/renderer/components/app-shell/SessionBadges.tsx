import { useMemo } from "react"
import { parseLabelEntry } from "@craft-agent/shared/labels"
import { EntityListLabelBadge } from "@/components/ui/entity-list-label-badge"
import { useSessionListContext } from "@/context/SessionListContext"
import type { SessionMeta } from "@/atoms/sessions"
import type { LabelConfig } from "@craft-agent/shared/labels"

interface SessionBadgesProps {
  item: SessionMeta
  maxVisible?: number
}

export function SessionBadges({ item, maxVisible = 2 }: SessionBadgesProps) {
  const ctx = useSessionListContext()

  const resolvedLabels = useMemo(() => {
    if (!item.labels || item.labels.length === 0 || ctx.flatLabels.length === 0) return []
    return item.labels
      .map(entry => {
        const parsed = parseLabelEntry(entry)
        const config = ctx.flatLabels.find(l => l.id === parsed.id)
        if (!config) return null
        return { config, rawValue: parsed.rawValue }
      })
      .filter((l): l is { config: LabelConfig; rawValue: string | undefined } => l != null)
  }, [item.labels, ctx.flatLabels])

  if (resolvedLabels.length === 0) return null

  const visibleLabels = resolvedLabels.slice(0, maxVisible)
  const remainingCount = resolvedLabels.length - visibleLabels.length

  return (
    <div className="flex items-center gap-1 min-w-0">
      {visibleLabels.map(({ config, rawValue }, idx) => (
        <EntityListLabelBadge
          key={`${config.id}-${idx}`}
          label={config}
          rawValue={rawValue}
          sessionLabels={item.labels || []}
          onLabelsChange={(updated) => ctx.onLabelsChange?.(item.id, updated)}
          onToggleFilter={ctx.onToggleLabelFilter}
        />
      ))}
      {remainingCount > 0 && (
        <span
          className="shrink-0 h-[18px] px-1.5 text-[9px] font-medium rounded bg-foreground/5 text-foreground/60 flex items-center cursor-default"
          title={resolvedLabels.slice(maxVisible).map(l => l.config.name).join(', ')}
        >
          +{remainingCount}
        </span>
      )}
    </div>
  )
}
