import * as React from "react";

import { type FilterMode } from "./view-filters";

import { type SessionStatusId, type SessionStatus } from "@/config/session-status-config";

import { type LabelMenuItem } from "@/components/ui/label-menu-utils";

interface ShellFilterSearchProps {
  filterDropdownInputRef: React.RefObject<HTMLInputElement | null>
  filterDropdownQuery: string
  setFilterDropdownQuery: React.Dispatch<React.SetStateAction<string>>
  filterDropdownResults: { states: SessionStatus[]; labels: LabelMenuItem[]; }
  setFilterDropdownSelectedIdx: React.Dispatch<React.SetStateAction<number>>
  filterDropdownSelectedIdx: number
  pinnedFilters: { pinnedStatusId: string | null; pinnedLabelId: string | null; pinnedFlagged: boolean; }
  setListFilter: (updater: Map<SessionStatusId, FilterMode> | ((prev: Map<SessionStatusId, FilterMode>) => Map<SessionStatusId, FilterMode>)) => void
  setLabelFilter: (updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => void
  t: import("i18next").TFunction<"translation", undefined>
}

export function ShellFilterSearch({
  filterDropdownInputRef,
  filterDropdownQuery,
  setFilterDropdownQuery,
  filterDropdownResults,
  setFilterDropdownSelectedIdx,
  filterDropdownSelectedIdx,
  pinnedFilters,
  setListFilter,
  setLabelFilter,
  t,
}: ShellFilterSearchProps) {
  return (
<div className="px-1 pb-3 border-b border-foreground/5">
                          <div className="bg-background rounded-[6px] shadow-minimal px-2 py-1.5">
                            <input
                              ref={filterDropdownInputRef}
                              type="text"
                              value={filterDropdownQuery}
                              onChange={(e) => setFilterDropdownQuery(e.target.value)}
                              onKeyDown={(e) => {
                                // When input is empty, let ArrowDown/ArrowUp blur the input
                                // so Radix's native menu keyboard navigation takes over
                                if (!filterDropdownQuery.trim() && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                                  e.preventDefault()
                                  ;(e.target as HTMLInputElement).blur()
                                  // Focus the first menu item so Radix's keyboard navigation activates
                                  const menu = (e.target as HTMLElement).closest('[role="menu"]')
                                  const firstItem = menu?.querySelector('[role="menuitem"]') as HTMLElement | null
                                  firstItem?.focus()
                                  return
                                }
                                e.stopPropagation()
                                const { states: ms, labels: ml } = filterDropdownResults
                                const total = ms.length + ml.length
                                if (total === 0) return
                                switch (e.key) {
                                  case 'ArrowDown':
                                    e.preventDefault()
                                    setFilterDropdownSelectedIdx(prev => (prev < total - 1 ? prev + 1 : 0))
                                    break
                                  case 'ArrowUp':
                                    e.preventDefault()
                                    setFilterDropdownSelectedIdx(prev => (prev > 0 ? prev - 1 : total - 1))
                                    break
                                  case 'Enter': {
                                    e.preventDefault()
                                    const mode: FilterMode = e.altKey ? 'exclude' : 'include'
                                    const idx = filterDropdownSelectedIdx
                                    if (idx < ms.length) {
                                      // Toggle a status filter
                                      const state = ms[idx]
                                      if (state.id !== pinnedFilters.pinnedStatusId) {
                                        setListFilter(prev => {
                                          const next = new Map(prev)
                                          if (next.has(state.id)) next.delete(state.id)
                                          else next.set(state.id, mode)
                                          return next
                                        })
                                      }
                                    } else {
                                      // Toggle a label filter
                                      const item = ml[idx - ms.length]
                                      if (item && item.id !== pinnedFilters.pinnedLabelId) {
                                        setLabelFilter(prev => {
                                          const next = new Map(prev)
                                          if (next.has(item.id)) next.delete(item.id)
                                          else next.set(item.id, mode)
                                          return next
                                        })
                                      }
                                    }
                                    break
                                  }
                                }
                              }}
                              placeholder={t("sidebar.searchStatusesLabels")}
                              className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
                              autoFocus
                            />
                          </div>
                        </div>
  )
}
