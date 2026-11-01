import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

import { DropdownMenuSub, StyledDropdownMenuSubTrigger, StyledDropdownMenuSubContent } from "@/components/ui/styled-dropdown";

import { type FilterMode } from "./view-filters";

import { type SessionStatusId, type SessionStatus, resolveStatusDisplayLabel } from "@/config/session-status-config";
import { LabelIcon } from "@/components/ui/label-icon";
import { type LabelMenuItem } from "@/components/ui/label-menu-utils";

import { AltExcludeTooltip, FilterModeBadge, FilterModeSubMenuItems, FilterMenuRow } from "./app-shell-filter-controls";

interface ShellFilterGroupingProps {
  filterDropdownResults: { states: SessionStatus[]; labels: LabelMenuItem[]; }
  filterDropdownListRef: React.RefObject<HTMLDivElement | null>
  pinnedFilters: { pinnedStatusId: string | null; pinnedLabelId: string | null; pinnedFlagged: boolean; }
  listFilter: Map<string, FilterMode>
  filterDropdownSelectedIdx: number
  setFilterDropdownSelectedIdx: React.Dispatch<React.SetStateAction<number>>
  setListFilter: (updater: Map<SessionStatusId, FilterMode> | ((prev: Map<SessionStatusId, FilterMode>) => Map<SessionStatusId, FilterMode>)) => void
  t: import("i18next").TFunction<"translation", undefined>
  filterAltHeld: boolean
  labelFilter: Map<string, FilterMode>
  setLabelFilter: (updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => void
}

export function ShellFilterGrouping({
  filterDropdownResults,
  filterDropdownListRef,
  pinnedFilters,
  listFilter,
  filterDropdownSelectedIdx,
  setFilterDropdownSelectedIdx,
  setListFilter,
  t,
  filterAltHeld,
  labelFilter,
  setLabelFilter,
}: ShellFilterGroupingProps) {
  return (
<>
                            {/* === FLAT FILTERED MODE (has query) ===
                                Uses the same filter/score logic as the # inline menu.
                                Shows matching statuses and labels in a single flat list.
                                Supports keyboard navigation (ArrowUp/Down/Enter in input). */}
                            {filterDropdownResults.states.length === 0 && filterDropdownResults.labels.length === 0 ? (
                              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                                No matching statuses or labels
                              </div>
                            ) : (
                              <div ref={filterDropdownListRef} className="max-h-[240px] overflow-y-auto py-1">
                                {/* Matched statuses */}
                                {filterDropdownResults.states.length > 0 && (
                                  <>
                                    <div className="px-3 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                                      Statuses
                                    </div>
                                    {filterDropdownResults.states.map((state, index) => {
                                      const applyColor = state.iconColorable
                                      const isPinned = state.id === pinnedFilters.pinnedStatusId
                                      const currentMode = listFilter.get(state.id)
                                      const isHighlighted = index === filterDropdownSelectedIdx
                                      const isActive = !!currentMode && !isPinned
                                      // Active status → DropdownMenuSub with mode options
                                      if (isActive) {
                                        return (
                                          <DropdownMenuSub key={`flat-status-${state.id}`}>
                                            <StyledDropdownMenuSubTrigger
                                              data-filter-selected={isHighlighted}
                                              onMouseEnter={() => setFilterDropdownSelectedIdx(index)}
                                              className={cn("mx-1", isHighlighted && "bg-foreground/5")}
                                              onClick={(e) => { e.preventDefault(); setListFilter(prev => { const next = new Map(prev); next.delete(state.id); return next }) }}
                                            >
                                              <FilterMenuRow
                                                icon={state.icon}
                                                label={resolveStatusDisplayLabel(state, t)}
                                                accessory={<FilterModeBadge mode={currentMode} />}
                                                iconStyle={applyColor ? { color: state.resolvedColor } : undefined}
                                                noIconContainer
                                              />
                                            </StyledDropdownMenuSubTrigger>
                                            <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                              <FilterModeSubMenuItems
                                                mode={currentMode}
                                                onChangeMode={(newMode) => setListFilter(prev => {
                                                  const next = new Map(prev)
                                                  next.set(state.id, newMode)
                                                  return next
                                                })}
                                                onRemove={() => setListFilter(prev => {
                                                  const next = new Map(prev)
                                                  next.delete(state.id)
                                                  return next
                                                })}
                                              />
                                            </StyledDropdownMenuSubContent>
                                          </DropdownMenuSub>
                                        )
                                      }
                                      // Inactive / pinned status → plain div with click-to-toggle
                                      return (
                                        <AltExcludeTooltip key={`flat-status-${state.id}`} show={filterAltHeld && !isPinned}>
                                          <div
                                            data-filter-selected={isHighlighted}
                                            onMouseEnter={() => setFilterDropdownSelectedIdx(index)}
                                            onClick={(e) => {
                                              if (isPinned) return
                                              e.preventDefault()
                                              setListFilter(prev => {
                                                const next = new Map(prev)
                                                if (next.has(state.id)) next.delete(state.id)
                                                else next.set(state.id, e.altKey ? 'exclude' : 'include')
                                                return next
                                              })
                                            }}
                                            className={cn(
                                              // SVG sizing matches StyledDropdownMenuSubTrigger so icons render at the same size
                                              "flex cursor-pointer select-none items-center gap-2 rounded-[4px] mx-1 px-2 py-1.5 text-sm [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
                                              isHighlighted && "bg-foreground/5",
                                              isPinned && "opacity-50 pointer-events-none",
                                            )}
                                          >
                                            <FilterMenuRow
                                              icon={state.icon}
                                              label={resolveStatusDisplayLabel(state, t)}
                                              accessory={isPinned ? <Check className="h-3 w-3 text-muted-foreground" /> : null}
                                              iconStyle={applyColor ? { color: state.resolvedColor } : undefined}
                                              noIconContainer
                                            />
                                          </div>
                                        </AltExcludeTooltip>
                                      )
                                    })}
                                  </>
                                )}
                                {/* Separator between sections */}
                                {filterDropdownResults.states.length > 0 && filterDropdownResults.labels.length > 0 && (
                                  <div className="my-1 mx-2 border-t border-border/40" />
                                )}
                                {/* Matched labels — flat list with parent breadcrumbs */}
                                {filterDropdownResults.labels.length > 0 && (
                                  <>
                                    <div className="px-3 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                                      Labels
                                    </div>
                                    {filterDropdownResults.labels.map((item, index) => {
                                      // Offset by state count for unified index
                                      const flatIndex = filterDropdownResults.states.length + index
                                      const isPinned = item.id === pinnedFilters.pinnedLabelId
                                      const currentMode = labelFilter.get(item.id)
                                      const isHighlighted = flatIndex === filterDropdownSelectedIdx
                                      const isActive = !!currentMode && !isPinned
                                      const labelDisplay = item.parentPath
                                        ? <><span className="text-muted-foreground">{item.parentPath}</span>{item.label}</>
                                        : item.label
                                      // Active label → DropdownMenuSub with mode options
                                      if (isActive) {
                                        return (
                                          <DropdownMenuSub key={`flat-label-${item.id}`}>
                                            <StyledDropdownMenuSubTrigger
                                              data-filter-selected={isHighlighted}
                                              onMouseEnter={() => setFilterDropdownSelectedIdx(flatIndex)}
                                              className={cn("mx-1", isHighlighted && "bg-foreground/5")}
                                              onClick={(e) => { e.preventDefault(); setLabelFilter(prev => { const next = new Map(prev); next.delete(item.id); return next }) }}
                                            >
                                              <FilterMenuRow
                                                icon={<LabelIcon label={item.config} size="lg" />}
                                                label={labelDisplay}
                                                accessory={<FilterModeBadge mode={currentMode} />}
                                              />
                                            </StyledDropdownMenuSubTrigger>
                                            <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                              <FilterModeSubMenuItems
                                                mode={currentMode}
                                                onChangeMode={(newMode) => setLabelFilter(prev => {
                                                  const next = new Map(prev)
                                                  next.set(item.id, newMode)
                                                  return next
                                                })}
                                                onRemove={() => setLabelFilter(prev => {
                                                  const next = new Map(prev)
                                                  next.delete(item.id)
                                                  return next
                                                })}
                                              />
                                            </StyledDropdownMenuSubContent>
                                          </DropdownMenuSub>
                                        )
                                      }
                                      // Inactive / pinned label → plain div with click-to-toggle
                                      return (
                                        <AltExcludeTooltip key={`flat-label-${item.id}`} show={filterAltHeld && !isPinned}>
                                          <div
                                            data-filter-selected={isHighlighted}
                                            onMouseEnter={() => setFilterDropdownSelectedIdx(flatIndex)}
                                            onClick={(e) => {
                                              if (isPinned) return
                                              e.preventDefault()
                                              setLabelFilter(prev => {
                                                const next = new Map(prev)
                                                if (next.has(item.id)) next.delete(item.id)
                                                else next.set(item.id, e.altKey ? 'exclude' : 'include')
                                                return next
                                              })
                                            }}
                                            className={cn(
                                              // SVG sizing matches StyledDropdownMenuSubTrigger so icons render at the same size
                                              "flex cursor-pointer select-none items-center gap-2 rounded-[4px] mx-1 px-2 py-1.5 text-sm [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
                                              isHighlighted && "bg-foreground/5",
                                              isPinned && "opacity-50 pointer-events-none",
                                            )}
                                          >
                                            <FilterMenuRow
                                              icon={<LabelIcon label={item.config} size="lg" />}
                                              label={labelDisplay}
                                              accessory={isPinned ? <Check className="h-3 w-3 text-muted-foreground" /> : null}
                                            />
                                          </div>
                                        </AltExcludeTooltip>
                                      )
                                    })}
                                  </>
                                )}
                              </div>
                            )}
                          </>
  )
}
