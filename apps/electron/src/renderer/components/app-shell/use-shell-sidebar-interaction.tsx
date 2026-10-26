import * as React from "react";

import { useRef, useEffect, useCallback } from "react";

import { Tag } from "lucide-react";

import { Tooltip, TooltipTrigger, TooltipContent } from "@craft-agent/ui";

import { type LinkItem } from "./LeftSidebar";

import type { Workspace, AutomationFilter } from "../../../shared/types";

import { type SessionStatusId, type SessionStatus } from "@/config/session-status-config";

import { LabelIcon, LabelValueTypeIcon } from "@/components/ui/label-icon";

import { getLabelDisplayName } from "@craft-agent/shared/labels";
import type { LabelConfig, LabelTreeNode } from "@craft-agent/shared/labels";

import { isSourcesNavigation, isSettingsNavigation, isSkillsNavigation, isAutomationsNavigation, isProjectsNavigation, isMissionsNavigation, type NavigationState } from "@/contexts/NavigationContext";
import type { SettingsSubpage } from "../../../shared/types";

interface useShellSidebarInteractionInput {
  menuNewChatTrigger: number | undefined
  handleNewChat: (newPanel?: boolean) => void
  handleAllSessionsClick: () => void
  effectiveSessionStatuses: SessionStatus[]
  handleSessionStatusClick: (stateId: SessionStatusId) => void
  handleFlaggedClick: () => void
  handleArchivedClick: () => void
  handleLabelClick: (labelId: string) => void
  labelTree: LabelTreeNode[]
  handleSourcesClick: () => void
  handleSkillsClick: () => void
  handleProjectsClick: () => void
  handleAutomationsClick: () => void
  handleSettingsClick: (subpage?: SettingsSubpage) => void
  handleWhatsNewClick: () => Promise<void>
  labelConfigs: LabelConfig[]
  viewConfigs: import("@craft-agent/shared/views").ViewConfig[]
  handleViewClick: (viewId: string) => void
  setExpandedFolders: React.Dispatch<React.SetStateAction<Set<string>>>
  focusedSidebarItemId: string | null
  sidebarItemRefs: React.RefObject<Map<string, HTMLElement>>
  sidebarFocused: boolean
  setFocusedSidebarItemId: React.Dispatch<React.SetStateAction<string | null>>
  focusZone: (id: import("@/context/FocusContext").FocusZoneId, options?: import("@/context/FocusContext").FocusZoneOptions) => void
  navState: NavigationState
  t: import("i18next").TFunction<"translation", undefined>
  automationFilter: AutomationFilter | null
  sessionFilter: import("@/contexts/NavigationContext").SessionFilter | null
  labelCounts: Record<string, number>
  activeWorkspace: Workspace | undefined
  openConfigureLabels: (labelId?: string) => void
  handleAddLabel: (parentId?: string) => void
  handleDeleteLabel: (labelId: string) => Promise<void>
  isExpanded: (id: string) => boolean
  toggleExpanded: (id: string) => void
}

export function useShellSidebarInteraction({
  menuNewChatTrigger,
  handleNewChat,
  handleAllSessionsClick,
  effectiveSessionStatuses,
  handleSessionStatusClick,
  handleFlaggedClick,
  handleArchivedClick,
  handleLabelClick,
  labelTree,
  handleSourcesClick,
  handleSkillsClick,
  handleProjectsClick,
  handleAutomationsClick,
  handleSettingsClick,
  handleWhatsNewClick,
  labelConfigs,
  viewConfigs,
  handleViewClick,
  setExpandedFolders,
  focusedSidebarItemId,
  sidebarItemRefs,
  sidebarFocused,
  setFocusedSidebarItemId,
  focusZone,
  navState,
  t,
  automationFilter,
  sessionFilter,
  labelCounts,
  activeWorkspace,
  openConfigureLabels,
  handleAddLabel,
  handleDeleteLabel,
  isExpanded,
  toggleExpanded,
}: useShellSidebarInteractionInput) {
const menuTriggerRef = useRef(menuNewChatTrigger)

useEffect(() => {
    // Skip initial render
    if (menuTriggerRef.current === menuNewChatTrigger) return
    menuTriggerRef.current = menuNewChatTrigger
    handleNewChat()
  }, [menuNewChatTrigger, handleNewChat])

type SidebarItem = {
    id: string
    type: 'nav'
    action?: () => void
  }

const unifiedSidebarItems = React.useMemo((): SidebarItem[] => {
    const result: SidebarItem[] = []

    // 1. Sessions section: All Sessions (expandable) with status items, Flagged, Archived as children
    result.push({ id: 'nav:allSessions', type: 'nav', action: handleAllSessionsClick })
    for (const state of effectiveSessionStatuses) {
      result.push({ id: `nav:state:${state.id}`, type: 'nav', action: () => handleSessionStatusClick(state.id) })
    }
    result.push({ id: 'nav:flagged', type: 'nav', action: handleFlaggedClick })
    result.push({ id: 'nav:archived', type: 'nav', action: handleArchivedClick })

    // 2. Labels section header + regular label tree for keyboard nav
    result.push({ id: 'nav:labels', type: 'nav', action: () => handleLabelClick('__all__') })
    // Flatten regular label tree for keyboard navigation (depth-first)
    const flattenTree = (nodes: LabelTreeNode[]) => {
      for (const node of nodes) {
        if (node.label) {
          result.push({ id: `nav:label:${node.fullId}`, type: 'nav', action: () => handleLabelClick(node.fullId) })
        }
        if (node.children.length > 0) flattenTree(node.children)
      }
    }
    flattenTree(labelTree)

    // 3. Sources, Skills, Settings
    result.push({ id: 'nav:sources', type: 'nav', action: handleSourcesClick })
    result.push({ id: 'nav:skills', type: 'nav', action: handleSkillsClick })
    result.push({ id: 'nav:projects', type: 'nav', action: handleProjectsClick })
    result.push({ id: 'nav:automations', type: 'nav', action: handleAutomationsClick })
    result.push({ id: 'nav:settings', type: 'nav', action: () => handleSettingsClick() })
    result.push({ id: 'nav:whats-new', type: 'nav', action: handleWhatsNewClick })

    return result
  }, [handleAllSessionsClick, handleFlaggedClick, handleArchivedClick, handleSessionStatusClick, effectiveSessionStatuses, handleLabelClick, labelTree, handleSourcesClick, handleSkillsClick, handleProjectsClick, handleAutomationsClick, handleSettingsClick, handleWhatsNewClick])

const handleToggleFolder = React.useCallback((path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [ setExpandedFolders])

const getSidebarItemProps = React.useCallback((id: string) => ({
    tabIndex: focusedSidebarItemId === id ? 0 : -1,
    'data-focused': focusedSidebarItemId === id,
    ref: (el: HTMLElement | null) => {
      if (el) {
        sidebarItemRefs.current.set(id, el)
      } else {
        sidebarItemRefs.current.delete(id)
      }
    },
  }), [focusedSidebarItemId, sidebarItemRefs])

const handleSidebarKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (!sidebarFocused || unifiedSidebarItems.length === 0) return

    const currentIndex = unifiedSidebarItems.findIndex(item => item.id === focusedSidebarItemId)
    const currentItem = currentIndex >= 0 ? unifiedSidebarItems[currentIndex] : null

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const nextIndex = currentIndex < unifiedSidebarItems.length - 1 ? currentIndex + 1 : 0
        const nextItem = unifiedSidebarItems[nextIndex]
        setFocusedSidebarItemId(nextItem.id)
        sidebarItemRefs.current.get(nextItem.id)?.focus()
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : unifiedSidebarItems.length - 1
        const prevItem = unifiedSidebarItems[prevIndex]
        setFocusedSidebarItemId(prevItem.id)
        sidebarItemRefs.current.get(prevItem.id)?.focus()
        break
      }
      case 'ArrowLeft': {
        e.preventDefault()
        // At boundary - do nothing (Left doesn't change zones from sidebar)
        break
      }
      case 'ArrowRight': {
        e.preventDefault()
        // Move to next zone (navigator) - keyboard navigation
        focusZone('navigator', { intent: 'keyboard' })
        break
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        if (currentItem?.type === 'nav' && currentItem.action) {
          currentItem.action()
        }
        break
      }
      case 'Home': {
        e.preventDefault()
        if (unifiedSidebarItems.length > 0) {
          const firstItem = unifiedSidebarItems[0]
          setFocusedSidebarItemId(firstItem.id)
          sidebarItemRefs.current.get(firstItem.id)?.focus()
        }
        break
      }
      case 'End': {
        e.preventDefault()
        if (unifiedSidebarItems.length > 0) {
          const lastItem = unifiedSidebarItems[unifiedSidebarItems.length - 1]
          setFocusedSidebarItemId(lastItem.id)
          sidebarItemRefs.current.get(lastItem.id)?.focus()
        }
        break
      }
    }
  }, [sidebarFocused, unifiedSidebarItems, focusedSidebarItemId, focusZone, setFocusedSidebarItemId, sidebarItemRefs])

React.useEffect(() => {
    if (sidebarFocused && unifiedSidebarItems.length > 0) {
      // Set focused item if not already set
      const itemId = focusedSidebarItemId || unifiedSidebarItems[0].id
      if (!focusedSidebarItemId) {
        setFocusedSidebarItemId(itemId)
      }
      // Actually focus the DOM element
      requestAnimationFrame(() => {
        sidebarItemRefs.current.get(itemId)?.focus()
      })
    }
  }, [sidebarFocused, focusedSidebarItemId, unifiedSidebarItems, setFocusedSidebarItemId, sidebarItemRefs])

const listTitle = React.useMemo(() => {
    // Sources navigator
    if (isSourcesNavigation(navState)) {
      return t("sidebar.sources")
    }

    // Skills navigator
    if (isSkillsNavigation(navState)) {
      return t("sidebar.allSkills")
    }

    // Projects navigator
    if (isProjectsNavigation(navState)) {
      return t("sidebar.allProjects")
    }

    if (isMissionsNavigation(navState)) {
      return t("sidebar.missions")
    }

    // Automations navigator
    if (isAutomationsNavigation(navState)) {
      if (!automationFilter) return t("sidebar.allAutomations")
      switch (automationFilter.automationType) {
        case 'scheduled': return t("sidebar.scheduled")
        case 'event': return t("sidebar.eventBased")
        case 'agentic': return t("sidebar.agentic")
        default: return t("sidebar.allAutomations")
      }
    }

    // Settings navigator
    if (isSettingsNavigation(navState)) return t("sidebar.settings")

    // Sessions navigator - use sessionFilter
    if (!sessionFilter) return t("sidebar.allSessions")

    switch (sessionFilter.kind) {
      case 'flagged':
        return t("sidebar.flagged")
      case 'state': {
        const state = effectiveSessionStatuses.find(s => s.id === sessionFilter.stateId)
        return state ? t(`status.${state.id}`, state.label) : t("sidebar.allSessions")
      }
      case 'label':
        return sessionFilter.labelId === '__all__' ? t("sidebar.labels") : getLabelDisplayName(labelConfigs, sessionFilter.labelId)
      case 'view':
        return sessionFilter.viewId === '__all__' ? t("sidebar.views") : viewConfigs.find(v => v.id === sessionFilter.viewId)?.name || t("sidebar.views")
      default:
        return t("sidebar.allSessions")
    }
  }, [navState, t, sessionFilter, automationFilter, labelConfigs, viewConfigs, effectiveSessionStatuses])

const buildLabelSidebarItems = useCallback((nodes: LabelTreeNode[]): LinkItem[] => {
    return nodes.map(node => {
      const hasChildren = node.children.length > 0
      const isActive = sessionFilter?.kind === 'label' && sessionFilter.labelId === node.fullId
      const count = labelCounts[node.fullId] || 0

      const item: LinkItem = {
        id: `nav:label:${node.fullId}`,
        title: node.label?.name || node.segment.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        label: count > 0 ? String(count) : undefined,
        // Show label type icon (Hash/Calendar/Type) right-aligned before count, with tooltip explaining the type
        afterTitle: node.label?.valueType ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center"><LabelValueTypeIcon valueType={node.label.valueType} size={10} /></span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {t("sidebar.labelValueTypeTooltip", { valueType: t(`sidebar.labelValueType.${node.label.valueType}`) })}
            </TooltipContent>
          </Tooltip>
        ) : undefined,
        icon: node.label && activeWorkspace?.id ? (
          <LabelIcon
            label={node.label}
            size="sm"
            hasChildren={hasChildren}
          />
        ) : <Tag className="h-3.5 w-3.5" />,
        variant: isActive ? "default" : "ghost",
        compact: true, // Reduced height for label items (many labels expected)
        // All labels navigate on click — parent and leaf alike
        onClick: () => handleLabelClick(node.fullId),
        contextMenu: {
          type: 'labels' as const,
          labelId: node.fullId,
          onConfigureLabels: openConfigureLabels,
          onAddLabel: handleAddLabel,
          onDeleteLabel: handleDeleteLabel,
        },
      }

      if (hasChildren) {
        item.expandable = true
        item.expanded = isExpanded(`nav:label:${node.fullId}`)
        // Chevron toggles expand/collapse independently of navigation
        item.onToggle = () => toggleExpanded(`nav:label:${node.fullId}`)
        item.items = buildLabelSidebarItems(node.children)
      }

      return item
    })
  }, [sessionFilter, labelCounts, activeWorkspace?.id, handleLabelClick, isExpanded, toggleExpanded, openConfigureLabels, handleAddLabel, handleDeleteLabel, t])
return { handleSidebarKeyDown, getSidebarItemProps, buildLabelSidebarItems, listTitle }
}
