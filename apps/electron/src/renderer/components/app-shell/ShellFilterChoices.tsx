import * as React from "react";
import { Flag, Tag, Check, Search, Inbox, Calendar, Layers, MailOpen, FolderKanban } from "lucide-react";

import { DropdownMenuSub, StyledDropdownMenuItem, StyledDropdownMenuSeparator, StyledDropdownMenuSubTrigger, StyledDropdownMenuSubContent } from "@/components/ui/styled-dropdown";
import { type ChatGroupingMode } from "./SessionList";

import { type FilterMode } from "./view-filters";

import { type SessionStatusId, type SessionStatus, resolveLabelDisplayName, resolveStatusDisplayLabel } from "@/config/session-status-config";
import { LabelIcon } from "@/components/ui/label-icon";

import { findLabelById } from "@craft-agent/shared/labels";
import type { LabelConfig } from "@craft-agent/shared/labels";

import { AltExcludeTooltip, FilterModeBadge, FilterModeSubMenuItems, FilterMenuRow } from "./app-shell-filter-controls";
import { FilterLabelItems } from "./FilterLabelItems";

interface ShellFilterChoicesProps {
  pinnedFilters: { pinnedStatusId: string | null; pinnedLabelId: string | null; pinnedFlagged: boolean; }
  listFilter: Map<string, FilterMode>
  labelFilter: Map<string, FilterMode>
  projectFilter: Map<string, FilterMode>
  t: import("i18next").TFunction<"translation", undefined>
  effectiveSessionStatuses: SessionStatus[]
  labelConfigs: LabelConfig[]
  setListFilter: (updater: Map<SessionStatusId, FilterMode> | ((prev: Map<SessionStatusId, FilterMode>) => Map<SessionStatusId, FilterMode>)) => void
  setLabelFilter: (updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => void
  projectMenuOptions: { id: string; slug: string; name: string; color: string | undefined; }[]
  setProjectFilter: (updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => void
  filterAltHeld: boolean
  displayLabelConfigs: LabelConfig[]
  isStateSubView: boolean
  setChatGroupingMode: (mode: ChatGroupingMode) => void
  chatGroupingMode: ChatGroupingMode
  setSearchActive: React.Dispatch<React.SetStateAction<boolean>>
}

export function ShellFilterChoices({
  pinnedFilters,
  listFilter,
  labelFilter,
  projectFilter,
  t,
  effectiveSessionStatuses,
  labelConfigs,
  setListFilter,
  setLabelFilter,
  projectMenuOptions,
  setProjectFilter,
  filterAltHeld,
  displayLabelConfigs,
  isStateSubView,
  setChatGroupingMode,
  chatGroupingMode,
  setSearchActive,
}: ShellFilterChoicesProps) {
  return (
<>
                            {/* === HIERARCHICAL MODE (default) === */}

                            {/* Active filter chips: pinned (non-removable) + user-added (removable) */}
                            {(pinnedFilters.pinnedFlagged || pinnedFilters.pinnedStatusId || pinnedFilters.pinnedLabelId || listFilter.size > 0 || labelFilter.size > 0 || projectFilter.size > 0) && (
                              <>
                                {/* Pinned: flagged */}
                                {pinnedFilters.pinnedFlagged && (
                                  <StyledDropdownMenuItem disabled>
                                    <FilterMenuRow
                                      icon={<Flag className="h-3.5 w-3.5" />}
                                      label={t("sidebar.flagged")}
                                      accessory={<Check className="h-3 w-3 text-muted-foreground" />}
                                    />
                                  </StyledDropdownMenuItem>
                                )}
                                {/* Pinned: status from state view */}
                                {(() => {
                                  if (!pinnedFilters.pinnedStatusId) return null
                                  const state = effectiveSessionStatuses.find(s => s.id === pinnedFilters.pinnedStatusId)
                                  if (!state) return null
                                  return (
                                    <StyledDropdownMenuItem disabled key={`pinned-status-${state.id}`}>
                                      <FilterMenuRow
                                        icon={state.icon}
                                        label={resolveStatusDisplayLabel(state, t)}
                                        accessory={<Check className="h-3 w-3 text-muted-foreground" />}
                                        iconStyle={state.iconColorable ? { color: state.resolvedColor } : undefined}
                                        noIconContainer
                                      />
                                    </StyledDropdownMenuItem>
                                  )
                                })()}
                                {/* Pinned: label from label view */}
                                {(() => {
                                  if (!pinnedFilters.pinnedLabelId) return null
                                  const label = findLabelById(labelConfigs, pinnedFilters.pinnedLabelId)
                                  if (!label) return null
                                  return (
                                    <StyledDropdownMenuItem disabled key={`pinned-label-${label.id}`}>
                                      <FilterMenuRow
                                        icon={<LabelIcon label={label} size="lg" />}
                                        label={resolveLabelDisplayName(label, t)}
                                        accessory={<Check className="h-3 w-3 text-muted-foreground" />}
                                      />
                                    </StyledDropdownMenuItem>
                                  )
                                })()}
                                {/* User-added: selected statuses with mode pill (include/exclude) */}
                                {effectiveSessionStatuses.filter(s => listFilter.has(s.id)).map(state => {
                                  const applyColor = state.iconColorable
                                  const mode = listFilter.get(state.id)!
                                  return (
                                    <DropdownMenuSub key={`sel-status-${state.id}`}>
                                      <StyledDropdownMenuSubTrigger onClick={(e) => { e.preventDefault(); setListFilter(prev => { const next = new Map(prev); next.delete(state.id); return next }) }}>
                                        <FilterMenuRow
                                          icon={state.icon}
                                          label={resolveStatusDisplayLabel(state, t)}
                                          accessory={<FilterModeBadge mode={mode} />}
                                          iconStyle={applyColor ? { color: state.resolvedColor } : undefined}
                                          noIconContainer
                                        />
                                      </StyledDropdownMenuSubTrigger>
                                      <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                        <FilterModeSubMenuItems
                                          mode={mode}
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
                                })}
                                {/* User-added: selected labels with mode pill (include/exclude) */}
                                {Array.from(labelFilter).map(([labelId, mode]) => {
                                  const label = findLabelById(labelConfigs, labelId)
                                  if (!label) return null
                                  return (
                                    <DropdownMenuSub key={`sel-label-${labelId}`}>
                                      <StyledDropdownMenuSubTrigger onClick={(e) => { e.preventDefault(); setLabelFilter(prev => { const next = new Map(prev); next.delete(labelId); return next }) }}>
                                        <FilterMenuRow
                                          icon={<LabelIcon label={label} size="lg" />}
                                          label={resolveLabelDisplayName(label, t)}
                                          accessory={<FilterModeBadge mode={mode} />}
                                        />
                                      </StyledDropdownMenuSubTrigger>
                                      <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                        <FilterModeSubMenuItems
                                          mode={mode}
                                          onChangeMode={(newMode) => setLabelFilter(prev => {
                                            const next = new Map(prev)
                                            next.set(labelId, newMode)
                                            return next
                                          })}
                                          onRemove={() => setLabelFilter(prev => {
                                            const next = new Map(prev)
                                            next.delete(labelId)
                                            return next
                                          })}
                                        />
                                      </StyledDropdownMenuSubContent>
                                    </DropdownMenuSub>
                                  )
                                })}
                                {/* User-added: selected projects with mode pill (include/exclude) */}
                                {Array.from(projectFilter).map(([projectId, mode]) => {
                                  const project = projectMenuOptions.find(p => p.id === projectId)
                                  if (!project) return null
                                  return (
                                    <DropdownMenuSub key={`sel-project-${projectId}`}>
                                      <StyledDropdownMenuSubTrigger onClick={(e) => { e.preventDefault(); setProjectFilter(prev => { const next = new Map(prev); next.delete(projectId); return next }) }}>
                                        <FilterMenuRow
                                          icon={<FolderKanban className="h-3.5 w-3.5" />}
                                          label={project.name}
                                          accessory={<FilterModeBadge mode={mode} />}
                                        />
                                      </StyledDropdownMenuSubTrigger>
                                      <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                        <FilterModeSubMenuItems
                                          mode={mode}
                                          onChangeMode={(newMode) => setProjectFilter(prev => {
                                            const next = new Map(prev)
                                            next.set(projectId, newMode)
                                            return next
                                          })}
                                          onRemove={() => setProjectFilter(prev => {
                                            const next = new Map(prev)
                                            next.delete(projectId)
                                            return next
                                          })}
                                        />
                                      </StyledDropdownMenuSubContent>
                                    </DropdownMenuSub>
                                  )
                                })}
                                <StyledDropdownMenuSeparator />
                              </>
                            )}

                            {/* Statuses submenu - hierarchical with toggle selection */}
                            <DropdownMenuSub>
                              <StyledDropdownMenuSubTrigger>
                                <Inbox className="h-3.5 w-3.5" />
                                <span className="flex-1">{t("sidebar.statuses")}</span>
                              </StyledDropdownMenuSubTrigger>
                              <StyledDropdownMenuSubContent minWidth="min-w-[180px]">
                                {effectiveSessionStatuses.map(state => {
                                  const applyColor = state.iconColorable
                                  const isPinned = state.id === pinnedFilters.pinnedStatusId
                                  const currentMode = listFilter.get(state.id)
                                  const isActive = !!currentMode && !isPinned
                                  // Active status → DropdownMenuSub with mode options (Radix safe-triangle hover)
                                  if (isActive) {
                                    return (
                                      <DropdownMenuSub key={state.id}>
                                        <StyledDropdownMenuSubTrigger onClick={(e) => { e.preventDefault(); setListFilter(prev => { const next = new Map(prev); next.delete(state.id); return next }) }}>
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
                                  // Inactive / pinned status → simple toggleable item
                                  return (
                                    <AltExcludeTooltip key={state.id} show={filterAltHeld && !isPinned}>
                                      <StyledDropdownMenuItem
                                        disabled={isPinned}
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
                                      >
                                        <FilterMenuRow
                                          icon={state.icon}
                                          label={resolveStatusDisplayLabel(state, t)}
                                          accessory={isPinned ? <Check className="h-3 w-3 text-muted-foreground" /> : null}
                                          iconStyle={applyColor ? { color: state.resolvedColor } : undefined}
                                          noIconContainer
                                        />
                                      </StyledDropdownMenuItem>
                                    </AltExcludeTooltip>
                                  )
                                })}
                              </StyledDropdownMenuSubContent>
                            </DropdownMenuSub>

                            {/* Labels submenu - hierarchical tree with recursive submenus */}
                            <DropdownMenuSub>
                              <StyledDropdownMenuSubTrigger>
                                <Tag className="h-3.5 w-3.5" />
                                <span className="flex-1">{t("sidebar.labels")}</span>
                              </StyledDropdownMenuSubTrigger>
                              <StyledDropdownMenuSubContent minWidth="min-w-[180px]">
                                {labelConfigs.length === 0 ? (
                                  <StyledDropdownMenuItem disabled>
                                    <span className="text-muted-foreground">{t("table.noLabelsConfigured")}</span>
                                  </StyledDropdownMenuItem>
                                ) : (
                                  <FilterLabelItems
                                    labels={displayLabelConfigs}
                                    labelFilter={labelFilter}
                                    setLabelFilter={setLabelFilter}
                                    pinnedLabelId={pinnedFilters.pinnedLabelId}
                                    altHeld={filterAltHeld}
                                  />
                                )}
                              </StyledDropdownMenuSubContent>
                            </DropdownMenuSub>

                            {/* Projects submenu - flat list of workspace projects */}
                            {projectMenuOptions.length > 0 && (
                              <DropdownMenuSub>
                                <StyledDropdownMenuSubTrigger>
                                  <FolderKanban className="h-3.5 w-3.5" />
                                  <span className="flex-1">{t("sidebar.projects")}</span>
                                </StyledDropdownMenuSubTrigger>
                                <StyledDropdownMenuSubContent minWidth="min-w-[180px]">
                                  {projectMenuOptions.map(project => {
                                    const currentMode = projectFilter.get(project.id)
                                    const isActive = !!currentMode
                                    if (isActive) {
                                      return (
                                        <DropdownMenuSub key={project.id}>
                                          <StyledDropdownMenuSubTrigger onClick={(e) => { e.preventDefault(); setProjectFilter(prev => { const next = new Map(prev); next.delete(project.id); return next }) }}>
                                            <FilterMenuRow
                                              icon={<FolderKanban className="h-3.5 w-3.5" />}
                                              label={project.name}
                                              accessory={<FilterModeBadge mode={currentMode} />}
                                            />
                                          </StyledDropdownMenuSubTrigger>
                                          <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                            <FilterModeSubMenuItems
                                              mode={currentMode}
                                              onChangeMode={(newMode) => setProjectFilter(prev => {
                                                const next = new Map(prev)
                                                next.set(project.id, newMode)
                                                return next
                                              })}
                                              onRemove={() => setProjectFilter(prev => {
                                                const next = new Map(prev)
                                                next.delete(project.id)
                                                return next
                                              })}
                                            />
                                          </StyledDropdownMenuSubContent>
                                        </DropdownMenuSub>
                                      )
                                    }
                                    return (
                                      <AltExcludeTooltip key={project.id} show={filterAltHeld}>
                                        <StyledDropdownMenuItem
                                          onClick={(e) => {
                                            e.preventDefault()
                                            setProjectFilter(prev => {
                                              const next = new Map(prev)
                                              if (next.has(project.id)) next.delete(project.id)
                                              else next.set(project.id, e.altKey ? 'exclude' : 'include')
                                              return next
                                            })
                                          }}
                                        >
                                          <FilterMenuRow
                                            icon={<FolderKanban className="h-3.5 w-3.5" />}
                                            label={project.name}
                                          />
                                        </StyledDropdownMenuItem>
                                      </AltExcludeTooltip>
                                    )
                                  })}
                                </StyledDropdownMenuSubContent>
                              </DropdownMenuSub>
                            )}

                            {/* Group by submenu - hidden in state sub-views (always date there) */}
                            {!isStateSubView && (
                              <>
                                <StyledDropdownMenuSeparator />
                                <DropdownMenuSub>
                                  <StyledDropdownMenuSubTrigger>
                                    <Layers className="h-3.5 w-3.5" />
                                    <span className="flex-1">{t("sidebar.group")}</span>
                                  </StyledDropdownMenuSubTrigger>
                                  <StyledDropdownMenuSubContent minWidth="min-w-[140px]">
                                    <StyledDropdownMenuItem onClick={() => setChatGroupingMode('date')}>
                                      <Calendar className="h-3.5 w-3.5" />
                                      <span className="flex-1">{t("sidebar.groupByDate")}</span>
                                      {chatGroupingMode === 'date' && <Check className="h-3 w-3 text-muted-foreground" />}
                                    </StyledDropdownMenuItem>
                                    <StyledDropdownMenuItem onClick={() => setChatGroupingMode('status')}>
                                      <Inbox className="h-3.5 w-3.5" />
                                      <span className="flex-1">{t("sidebar.groupByStatus")}</span>
                                      {chatGroupingMode === 'status' && <Check className="h-3 w-3 text-muted-foreground" />}
                                    </StyledDropdownMenuItem>
                                    <StyledDropdownMenuItem onClick={() => setChatGroupingMode('unread')}>
                                      <MailOpen className="h-3.5 w-3.5" />
                                      <span className="flex-1">{t("sidebar.groupByUnread")}</span>
                                      {chatGroupingMode === 'unread' && <Check className="h-3 w-3 text-muted-foreground" />}
                                    </StyledDropdownMenuItem>
                                    {projectMenuOptions.length > 0 && (
                                      <StyledDropdownMenuItem onClick={() => setChatGroupingMode('project')}>
                                        <FolderKanban className="h-3.5 w-3.5" />
                                        <span className="flex-1">{t("sidebar.groupByProject")}</span>
                                        {chatGroupingMode === 'project' && <Check className="h-3 w-3 text-muted-foreground" />}
                                      </StyledDropdownMenuItem>
                                    )}
                                  </StyledDropdownMenuSubContent>
                                </DropdownMenuSub>
                              </>
                            )}

                            <StyledDropdownMenuSeparator />
                            <StyledDropdownMenuItem
                              onClick={() => {
                                setSearchActive(true)
                              }}
                            >
                              <Search className="h-3.5 w-3.5" />
                              <span className="flex-1">{t("sidebar.search")}</span>
                            </StyledDropdownMenuItem>
                          </>
  )
}
