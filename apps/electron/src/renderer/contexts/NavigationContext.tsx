import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import "sonner";
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { useSession } from '@/hooks/useSession';
import { useLabels } from '@/hooks/useLabels';
import "@craft-agent/shared/labels";
import { parseRouteToNavigationState, buildRouteFromNavigationState } from '../../shared/route-parser';
import { routes, type Route, type ViewRoute } from '../../shared/routes';
import "@craft-agent/shared/agent/mode-types";
import "../lib/navigate";
import { filterUserFacingSessionPanels, normalizePanelRouteForReconcile } from './navigation-reconcile';
import "./navigation-history";
import "@/lib/local-storage";
import { isSessionsNavigation, isSourcesNavigation, isSettingsNavigation, isSkillsNavigation, isAutomationsNavigation, isProjectsNavigation, isMissionsNavigation, DEFAULT_NAVIGATION_STATE } from '../../shared/types';
import { sessionMetaMapAtom, updateSessionMetaAtom } from '@/atoms/sessions';
import { sourcesAtom } from '@/atoms/sources';
import { skillsAtom } from '@/atoms/skills';
import { panelStackAtom, pushPanelAtom, reconcilePanelStackAtom, focusedPanelRouteAtom } from '@/atoms/panel-stack';
import "./navigation-empty-session-cleanup";
import "@/utils/session-visibility";

import { useNavigationSynchronization } from "./use-navigation-synchronization";





















import { useNavigationActions } from "./use-navigation-actions";

import { useNavigationAutoSelection } from "./use-navigation-auto-selection";

import { useNavigationSessionSelection } from "./use-navigation-session-selection";

import { useNavigationHistory } from "./use-navigation-history";

import { NavigationProviderContent } from "./navigation-provider-content";
import { type NavigationProviderProps } from "./navigation-context-state";
export { NavigationContext, useNavigation, useNavigationState } from "./navigation-context-state";
/**
 * NavigationContext
 *
 * Provides a global `navigate()` function that decouples components from
 * direct session/action imports. All navigation goes through typed routes.
 *
 * PEER PANEL MODEL:
 * All panels are equal. The **focused** panel drives the NavigationState
 * (which determines sidebar highlight, navigator content, etc.).
 * `navigate(route)` updates the focused panel's route.
 *
 * URL-DRIVEN HISTORY:
 * The URL is the source of truth. Every meaningful navigation pushes a
 * browser history entry via pushState. Back/forward uses the browser's
 * native popstate, with smart panel reconciliation to preserve React keys
 * (and thus scroll position, streaming state, etc.).
 *
 * Usage:
 *   import { useNavigation, useNavigationState } from '@/contexts/NavigationContext'
 *   import { routes } from '@/shared/routes'
 *
 *   const { navigate } = useNavigation()
 *   const navState = useNavigationState()
 *
 *   navigate(routes.view.allSessions())
 *   navigate(routes.action.newChat())
 */















import type { NavigationState, SessionFilter, RightSidebarPanel } from '../../shared/types';








// Re-export routes for convenience
export { routes }
export type { Route }

// Re-export navigation state types for consumers
export type { NavigationState, SessionFilter }
export { isSessionsNavigation, isSourcesNavigation, isSettingsNavigation, isSkillsNavigation, isAutomationsNavigation, isProjectsNavigation, isMissionsNavigation }

export function NavigationProvider({
  children,
  workspaceId,
  workspaceSlug,
  onSwitchWorkspaceBySlug,
  onCreateSession,
  onInputChange,
  getDraft,
  onAutoDeleteEmptySession,
  isReady = true,
  isSessionsReady = true,
  remoteWorkspaceId,
}: NavigationProviderProps) {
  const { t } = useTranslation()
  const [, setSession] = useSession()

  // Read session metadata directly from atom (reactive to session changes)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const sessionMetas = useMemo(() => Array.from(sessionMetaMap.values()), [sessionMetaMap])
  const updateSessionMeta = useSetAtom(updateSessionMetaAtom)
  // Label tree for filter matching (auto-select must agree with the visible list).
  const { labels: labelConfigs } = useLabels(workspaceId)

  const pushPanel = useSetAtom(pushPanelAtom)

  // Store reference for reading fresh atom values in callbacks (avoids stale closures)
  const store = useStore()

  // Read sources from atom (populated by AppShell)
  const sources = useAtomValue(sourcesAtom)

  // Read skills from atom (populated by AppShell)
  const skills = useAtomValue(skillsAtom)

  // =========================================================================
  // DERIVED NAVIGATION STATE (from focused panel + right sidebar)
  // =========================================================================

  const focusedRoute = useAtomValue(focusedPanelRouteAtom)

  // Right sidebar is independent of panels (not per-panel state)
  const [rightSidebar, setRightSidebar] = useState<RightSidebarPanel | undefined>()
  const rightSidebarRef = useRef<RightSidebarPanel | undefined>(rightSidebar)
  useEffect(() => { rightSidebarRef.current = rightSidebar }, [rightSidebar])

  // NavigationState derived from the focused panel's route
  const navigationState: NavigationState = useMemo(() => {
    const base = focusedRoute
      ? parseRouteToNavigationState(focusedRoute) ?? DEFAULT_NAVIGATION_STATE
      : DEFAULT_NAVIGATION_STATE
    return rightSidebar ? { ...base, rightSidebar } : base
  }, [focusedRoute, rightSidebar])

  // =========================================================================
  // BROWSER HISTORY TRACKING
  // =========================================================================

  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)

  // Sequence numbers stored in history.state for tracking position
  const {
    prevSidebarTypeRef,
    suppressPushRef,
    initialRouteRestoredRef,
    maybePushHistoryForSemanticChange,
    panelStack,
    suppressAutoSelectRef,
    pendingNavigationRef,
    historySeqRef,
    updateCanGoBackForward,
    isPopstateSwitchRef,
    lastSemanticHistoryKeyRef,
    getSemanticHistoryKey,
    nextHistorySeqRef,
    historyMaxSeqRef,
  } = useNavigationHistory({
    setCanGoBack,
    setCanGoForward,
    store,
    rightSidebarRef,
    workspaceSlug,
    rightSidebar,
  })
  useEffect(() => {
    if (rightSidebar?.type === prevSidebarTypeRef.current) return
    prevSidebarTypeRef.current = rightSidebar?.type
    if (suppressPushRef.current) return
    if (!initialRouteRestoredRef.current) return
    maybePushHistoryForSemanticChange()
  }, [rightSidebar, maybePushHistoryForSemanticChange, initialRouteRestoredRef, prevSidebarTypeRef, suppressPushRef])

  // =========================================================================
  // RECONCILE PANELS FROM URL PARAMS
  // =========================================================================

  /**
   * Parse URL search params and reconcile the panel stack + sidebar.
   * Uses reconcilePanelStackAtom for smart matching (preserves React keys).
   */
  const reconcileFromUrlParams = (params: URLSearchParams) => {
      const initialRoute = params.get('route')
      const sidebarParam = params.get('sidebar') || undefined
      const panelsParam = params.get('panels')
      const focusedIndexParam = params.get('fi')

      // Restore right sidebar
      if (sidebarParam) {
        const parsed = parseRouteToNavigationState('allSessions', sidebarParam)
        if (parsed?.rightSidebar) {
          setRightSidebar(parsed.rightSidebar)
        } else {
          setRightSidebar(undefined)
        }
      } else {
        setRightSidebar(undefined)
      }

      // Parse panel entries from URL
      let entries: { route: ViewRoute; proportion: number }[] = []
      let focusedIndex = 0

      if (panelsParam) {
        // Canonical format: ?panels= contains ALL panels, ?fi= is focused index.
        // We intentionally no longer support older mixed route/panels formats.
        entries = panelsParam.split(',').filter(Boolean).map(entry => {
          const colonIdx = entry.lastIndexOf(':')
          if (colonIdx > 0) {
            const proportion = parseFloat(entry.slice(colonIdx + 1))
            if (!isNaN(proportion) && proportion > 0 && proportion < 1) {
              const rawRoute = entry.slice(0, colonIdx) as ViewRoute
              const route = normalizePanelRouteForReconcile(rawRoute, (state) => resolveAutoSelectionRef.current(state))
              return { route, proportion }
            }
          }
          const rawRoute = entry as ViewRoute
          const route = normalizePanelRouteForReconcile(rawRoute, (state) => resolveAutoSelectionRef.current(state))
          return { route, proportion: 0 }
        })

        const hasProportions = entries.some(e => e.proportion > 0)
        if (!hasProportions) {
          const equal = 1 / entries.length
          entries.forEach(e => { e.proportion = equal })
        } else {
          const total = entries.reduce((s, e) => s + e.proportion, 0)
          if (total > 0 && Math.abs(total - 1) > 0.001) {
            entries.forEach(e => { e.proportion = e.proportion / total })
          }
        }

        focusedIndex = focusedIndexParam != null ? (parseInt(focusedIndexParam, 10) || 0) : 0
      } else if (initialRoute) {
        // Single panel from ?route=
        const navState = parseRouteToNavigationState(initialRoute)
        if (navState) {
          const finalRoute = ('details' in navState && navState.details)
            ? (initialRoute as ViewRoute)
            : (buildRouteFromNavigationState(resolveAutoSelectionRef.current(navState)) as ViewRoute)
          entries = [{ route: finalRoute, proportion: 1 }]
        }
      }

      if (entries.length > 0) {
        const visible = filterUserFacingSessionPanels(entries, focusedIndex, store.get(sessionMetaMapAtom))
        entries = visible.entries
        focusedIndex = visible.focusedIndex
        if (entries.length === 0) {
          const route = normalizePanelRouteForReconcile('allSessions', (state) => resolveAutoSelectionRef.current(state))
          entries = [{ route, proportion: 1 }]
        }
        store.set(reconcilePanelStackAtom, { entries, focusedIndex })
      }
    }

  // Keep ref fresh for use in event handlers / effects that capture stale closures
  const reconcileFromUrlParamsRef = useRef(reconcileFromUrlParams)
  useEffect(() => { reconcileFromUrlParamsRef.current = reconcileFromUrlParams })

  // =========================================================================
  // EMPTY SESSION CLEANUP (reactive — covers navigate, close tab, etc.)
  // =========================================================================

  // Track which session IDs are visible across all panels. When a session ID
  // disappears (navigate away, close tab, Cmd+W), check if it was empty and
  // auto-delete it. This is the single codepath for all navigate-away cleanup.
  const {
    getLastSelectedSessionId,
    getFirstSessionId,
    autoDeleteEligibleSessionIdsRef,
  } = useNavigationSessionSelection({
    panelStack,
    onAutoDeleteEmptySession,
    store,
    getDraft,
    navigationState,
    setSession,
    workspaceId,
    sessionMetas,
    remoteWorkspaceId,
    labelConfigs,
  })

  const {
    resolveAutoSelectionRef,
    resolveAutoSelection,
  } = useNavigationAutoSelection({
    sources,
    skills,
    store,
    workspaceId,
    remoteWorkspaceId,
    getLastSelectedSessionId,
    getFirstSessionId,
  })
  useEffect(() => { resolveAutoSelectionRef.current = resolveAutoSelection }, [resolveAutoSelection, resolveAutoSelectionRef])

  // =========================================================================
  // ACTION NAVIGATION
  // =========================================================================

  const {
    navigate,
    handleActionNavigation,
  } = useNavigationActions({
    workspaceId,
    onCreateSession,
    autoDeleteEligibleSessionIdsRef,
    updateSessionMeta,
    pushPanel,
    store,
    onInputChange,
    suppressAutoSelectRef,
    isReady,
    pendingNavigationRef,
    resolveAutoSelection,
  })

  // =========================================================================
  // BACK / FORWARD (browser history)
  // =========================================================================

  const goBack = useCallback(() => {
    history.back()
  }, [])

  const goForward = useCallback(() => {
    history.forward()
  }, [])

  // =========================================================================
  // POPSTATE HANDLER (browser back/forward)
  // =========================================================================

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      // Update sequence tracking
      const state: unknown = event.state
      const eventSeq = isJsonObject(state) && typeof state['seq'] === 'number' && Number.isFinite(state['seq']) ? state['seq'] : 0
      historySeqRef.current = eventSeq
      updateCanGoBackForward()

      // Read state from URL (the browser already navigated to it)
      const params = new URLSearchParams(window.location.search)
      const wsSlug = params.get('ws')

      // Check if workspace changed
      if (wsSlug && wsSlug !== workspaceSlug && onSwitchWorkspaceBySlug) {
        // Workspace boundary crossed — trigger workspace switch
        // The workspace switch effect will handle reconciliation
        isPopstateSwitchRef.current = true
        onSwitchWorkspaceBySlug(wsSlug)
        return
      }

      if (!isSessionsReady) {
        // Session metadata is not initialized yet; initial restore will reconcile
        // current URL state once metadata is available.
        return
      }

      // Same workspace — reconcile panels from the URL
      suppressPushRef.current = true
      reconcileFromUrlParamsRef.current(params)
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
      requestAnimationFrame(() => {
        suppressPushRef.current = false
      })
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [workspaceSlug, onSwitchWorkspaceBySlug, updateCanGoBackForward, getSemanticHistoryKey, isSessionsReady, historySeqRef, isPopstateSwitchRef, lastSemanticHistoryKeyRef, suppressPushRef])

  // =========================================================================
  // WORKSPACE SWITCH
  // =========================================================================

  const {
    navigateToSession,
    updateRightSidebar,
    toggleRightSidebar,
    navigateToSource,
  } = useNavigationSynchronization({
    workspaceId,
    workspaceSlug,
    isSessionsReady,
    suppressPushRef,
    isPopstateSwitchRef,
    reconcileFromUrlParamsRef,
    lastSemanticHistoryKeyRef,
    getSemanticHistoryKey,
    nextHistorySeqRef,
    historySeqRef,
    historyMaxSeqRef,
    updateCanGoBackForward,
    initialRouteRestoredRef,
    store,
    isReady,
    navigate,
    pendingNavigationRef,
    handleActionNavigation,
    resolveAutoSelection,
    t,
    setRightSidebar,
    rightSidebarRef,
    navigationState,
  })

  // =========================================================================
  // AUTO-SELECT ON SESSION LOAD
  // =========================================================================

  useEffect(() => {
    if (suppressAutoSelectRef.current) return
    if (!isReady || !workspaceId) return
    // Don't auto-select when panel stack is empty (user closed all panels)
    if (store.get(panelStackAtom).length === 0) return
    // Scoped to sessions with no explicit detail. resolveAutoSelection owns the
    // selection decision (board skip, last/first fallback) so it lives in one
    // place; this effect just applies it when the session list loads after
    // navigation (workspace switch, lazy session load, etc.).
    if (!isSessionsNavigation(navigationState) || navigationState.details) return

    const resolved = resolveAutoSelection(navigationState)
    if (isSessionsNavigation(resolved) && resolved.details) {
      navigateToSession(resolved.details.sessionId)
    }
  }, [
    isReady,
    workspaceId,
    navigationState,
    resolveAutoSelection,
    navigateToSession, store, suppressAutoSelectRef,
  ])

  // =========================================================================
  // CONTEXT VALUE
  // =========================================================================

  return (
    <NavigationProviderContent
      navigate={navigate}
      isReady={isReady}
      navigationState={navigationState}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      goBack={goBack}
      goForward={goForward}
      updateRightSidebar={updateRightSidebar}
      toggleRightSidebar={toggleRightSidebar}
      navigateToSource={navigateToSource}
      navigateToSession={navigateToSession}
      children={children}
    />
  )
}
import { isJsonObject } from '@craft-agent/shared/utils/json';
