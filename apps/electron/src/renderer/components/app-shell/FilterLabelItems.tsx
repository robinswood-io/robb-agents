
import { useTranslation } from "react-i18next";

import { Check } from "lucide-react";

import { DropdownMenuSub, StyledDropdownMenuItem, StyledDropdownMenuSeparator, StyledDropdownMenuSubTrigger, StyledDropdownMenuSubContent } from "@/components/ui/styled-dropdown";

import { type FilterMode } from "./view-filters";

import { resolveLabelDisplayName } from "@/config/session-status-config";

import { LabelIcon } from "@/components/ui/label-icon";

import type { LabelConfig } from "@craft-agent/shared/labels";

import { AltExcludeTooltip, FilterModeBadge, FilterModeSubMenuItems, FilterMenuRow } from "./app-shell-filter-controls";

export function FilterLabelItems({
  labels,
  labelFilter,
  setLabelFilter,
  pinnedLabelId,
  altHeld,
}: {
  labels: LabelConfig[]
  labelFilter: Map<string, FilterMode>
  setLabelFilter: (updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => void
  /** Label ID pinned by the current route (non-removable, shown as checked+disabled) */
  pinnedLabelId?: string | null | undefined
  altHeld?: boolean | undefined
}) {
  const { t } = useTranslation()

  /** Toggle a label filter: if active → remove, if inactive → add as 'include' (or 'exclude' with Alt) */
  const toggleLabel = (id: string, altKey = false) => {
    setLabelFilter(prev => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, altKey ? 'exclude' : 'include')
      return next
    })
  }

  /** Build callbacks for changing/removing a label's filter mode */
  const makeModeCallbacks = (id: string) => ({
    onChangeMode: (newMode: FilterMode) => setLabelFilter(prev => {
      const next = new Map(prev)
      next.set(id, newMode)
      return next
    }),
    onRemove: () => setLabelFilter(prev => {
      const next = new Map(prev)
      next.delete(id)
      return next
    }),
  })

  return (
    <>
      {labels.map(label => {
        const hasChildren = label.children && label.children.length > 0
        const isPinned = label.id === pinnedLabelId
        const mode = labelFilter.get(label.id)
        const isActive = !!mode && !isPinned

        // --- Group labels (have children) → always DropdownMenuSub ---
        if (hasChildren) {
          // Check if any child has an active filter (to show indicator on parent)
          const hasActiveChild = label.children!.some(child => {
            const childMode = labelFilter.get(child.id)
            return !!childMode && child.id !== pinnedLabelId
          })
          const showIndicator = isActive || hasActiveChild || isPinned

          return (
            <DropdownMenuSub key={label.id}>
              <StyledDropdownMenuSubTrigger>
                <FilterMenuRow
                  icon={<LabelIcon label={label} size="lg" hasChildren />}
                  label={resolveLabelDisplayName(label, t)}
                  accessory={
                    showIndicator ? <Check className="h-3 w-3 text-muted-foreground" /> : undefined
                  }
                />
              </StyledDropdownMenuSubTrigger>
              <StyledDropdownMenuSubContent minWidth="min-w-[160px]">
                {isActive ? (
                  // Active group: group title as nested sub-trigger for mode options, then children
                  <>
                    <DropdownMenuSub>
                      {/* Click the group title to clear, hover to open mode submenu */}
                      <StyledDropdownMenuSubTrigger onClick={(e) => { e.preventDefault(); toggleLabel(label.id, e.altKey) }}>
                        <FilterMenuRow
                          icon={<LabelIcon label={label} size="lg" hasChildren />}
                          label={resolveLabelDisplayName(label, t)}
                          accessory={<FilterModeBadge mode={mode} />}
                        />
                      </StyledDropdownMenuSubTrigger>
                      <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                        <FilterModeSubMenuItems mode={mode} {...makeModeCallbacks(label.id)} />
                      </StyledDropdownMenuSubContent>
                    </DropdownMenuSub>
                    <StyledDropdownMenuSeparator />
                    <FilterLabelItems
                      labels={label.children!}
                      labelFilter={labelFilter}
                      setLabelFilter={setLabelFilter}
                      pinnedLabelId={pinnedLabelId}
                      altHeld={altHeld}
                    />
                  </>
                ) : (
                  // Inactive group: self-toggle item, then children
                  <>
                    <AltExcludeTooltip show={!!altHeld && !isPinned}>
                      <StyledDropdownMenuItem
                        disabled={isPinned}
                        onClick={(e) => {
                          if (isPinned) return
                          e.preventDefault()
                          toggleLabel(label.id, e.altKey)
                        }}
                      >
                        <FilterMenuRow
                          icon={<LabelIcon label={label} size="lg" hasChildren />}
                          label={resolveLabelDisplayName(label, t)}
                          accessory={isPinned ? <Check className="h-3 w-3 text-muted-foreground" /> : undefined}
                        />
                      </StyledDropdownMenuItem>
                    </AltExcludeTooltip>
                    <StyledDropdownMenuSeparator />
                    <FilterLabelItems
                      labels={label.children!}
                      labelFilter={labelFilter}
                      setLabelFilter={setLabelFilter}
                      pinnedLabelId={pinnedLabelId}
                      altHeld={altHeld}
                    />
                  </>
                )}
              </StyledDropdownMenuSubContent>
            </DropdownMenuSub>
          )
        }

        // --- Active leaf label → DropdownMenuSub with mode options ---
        if (isActive) {
          return (
            <DropdownMenuSub key={label.id}>
              {/* Click the item itself to clear, hover to open mode submenu */}
              <StyledDropdownMenuSubTrigger onClick={(e) => { e.preventDefault(); toggleLabel(label.id, e.altKey) }}>
                <FilterMenuRow
                  icon={<LabelIcon label={label} size="lg" />}
                  label={resolveLabelDisplayName(label, t)}
                  accessory={<FilterModeBadge mode={mode} />}
                />
              </StyledDropdownMenuSubTrigger>
              <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                <FilterModeSubMenuItems mode={mode} {...makeModeCallbacks(label.id)} />
              </StyledDropdownMenuSubContent>
            </DropdownMenuSub>
          )
        }

        // --- Inactive / pinned leaf label → simple toggleable item ---
        return (
          <AltExcludeTooltip key={label.id} show={!!altHeld && !isPinned}>
            <StyledDropdownMenuItem
              disabled={isPinned}
              onClick={(e) => {
                if (isPinned) return
                e.preventDefault()
                toggleLabel(label.id, e.altKey)
              }}
            >
              <FilterMenuRow
                icon={<LabelIcon label={label} size="lg" />}
                label={resolveLabelDisplayName(label, t)}
                accessory={isPinned ? <Check className="h-3 w-3 text-muted-foreground" /> : undefined}
              />
            </StyledDropdownMenuItem>
          </AltExcludeTooltip>
        )
      })}
    </>
  )
}
