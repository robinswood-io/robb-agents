import { useState, useCallback, useEffect, useRef } from "react";

import * as storage from "@/lib/local-storage";
import { KEYS } from "@/lib/local-storage";

import { buildCollapsedGroupsScopeSuffix, parseCollapsedGroups } from "@/utils/session-list-collapse";

import type { ChatGroupingMode } from "./session-list-data";

interface SessionListCollapseInput {
  workspaceId: string | undefined
  currentFilter: import("@/contexts/NavigationContext").SessionFilter | undefined
  groupingMode: ChatGroupingMode
}

export function useSessionListCollapse({
  workspaceId,
  currentFilter,
  groupingMode,
}: SessionListCollapseInput) {
  const collapseScopeSuffix = buildCollapsedGroupsScopeSuffix({
    ...(workspaceId !== undefined ? { workspaceId: workspaceId } : {}),
    ...(currentFilter !== undefined ? { currentFilter: currentFilter } : {}),
    groupingMode,
  })

  const readCollapsedGroupsForScope = useCallback((scopeSuffix: string): Set<string> => {
    const scopedRaw = storage.getRaw(KEYS.collapsedSessionGroups, scopeSuffix)
    if (scopedRaw !== null) {
      try {
        const parsed: unknown = JSON.parse(scopedRaw)
        return parseCollapsedGroups(parsed)
      } catch {
        return new Set()
      }
    }

    // Legacy fallback: previous versions used a single global key with no scope suffix.
    // Use as migration source only when this scope has never been written.
    const legacy = storage.get<unknown>(KEYS.collapsedSessionGroups, [])
    return parseCollapsedGroups(legacy)
  }, [])

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => readCollapsedGroupsForScope(collapseScopeSuffix))

  const collapseScopeRef = useRef(collapseScopeSuffix)

  useEffect(() => {
    if (collapseScopeRef.current === collapseScopeSuffix) return
    setCollapsedGroups(readCollapsedGroupsForScope(collapseScopeSuffix))
    collapseScopeRef.current = collapseScopeSuffix
  }, [collapseScopeSuffix, readCollapsedGroupsForScope])

  useEffect(() => {
    // Avoid writing stale groups from a previous scope during context switches.
    if (collapseScopeRef.current !== collapseScopeSuffix) return
    storage.set(KEYS.collapsedSessionGroups, Array.from(collapsedGroups), collapseScopeSuffix)
  }, [collapsedGroups, collapseScopeSuffix])

  const toggleGroupCollapse = useCallback((groupKey: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
  }, [])

  return { setCollapsedGroups, collapsedGroups, toggleGroupCollapse }
}
