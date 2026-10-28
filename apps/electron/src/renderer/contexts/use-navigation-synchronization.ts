import { omitUndefined } from '@craft-agent/shared/utils/json';
import { useCallback, useEffect, useRef } from 'react';

import { toast } from 'sonner';

import { parseRouteToNavigationState, buildRouteFromNavigationState, type ParsedRoute } from '../../shared/route-parser';
import { routes, type Route, type ViewRoute } from '../../shared/routes';

import { NAVIGATE_EVENT, type NavigateOptions } from '../lib/navigate';

import { canRunInitialRestore } from './navigation-history';
import * as storage from '@/lib/local-storage';
import type { DeepLinkNavigation, NavigationState, RightSidebarPanel } from '../../shared/types';
import { isSessionsNavigation, isSourcesNavigation } from '../../shared/types';

import { updateFocusedPanelRouteAtom } from '@/atoms/panel-stack';

interface useNavigationSynchronizationInput {
  workspaceId: string | null
  workspaceSlug: string | null
  isSessionsReady: boolean
  suppressPushRef: import("react").RefObject<boolean>
  isPopstateSwitchRef: import("react").RefObject<boolean>
  reconcileFromUrlParamsRef: import("react").RefObject<(params: URLSearchParams) => void>
  lastSemanticHistoryKeyRef: import("react").RefObject<string>
  getSemanticHistoryKey: () => string
  nextHistorySeqRef: import("react").RefObject<number>
  historySeqRef: import("react").RefObject<number>
  historyMaxSeqRef: import("react").RefObject<number>
  updateCanGoBackForward: () => void
  initialRouteRestoredRef: import("react").RefObject<boolean>
  store: import("jotai").Store
  isReady: boolean
  navigate: (route: Route, options?: NavigateOptions) => Promise<void>
  pendingNavigationRef: import("react").RefObject<ParsedRoute | null>
  handleActionNavigation: (parsed: ParsedRoute, options?: { newPanel?: boolean; targetLaneId?: "main"; }) => Promise<void>
  resolveAutoSelection: (newState: NavigationState, options?: { skipAutoSelect?: boolean; }) => NavigationState
  t: import("i18next").TFunction<"translation", undefined>
  setRightSidebar: import("react").Dispatch<import("react").SetStateAction<RightSidebarPanel | undefined>>
  rightSidebarRef: import("react").RefObject<RightSidebarPanel | undefined>
  navigationState: NavigationState
}

export function useNavigationSynchronization({
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
}: useNavigationSynchronizationInput) {
const previousWorkspaceSlugRef = useRef<string | null>(null)

useEffect(() => {
    if (!workspaceId || !workspaceSlug || !isSessionsReady) return

    if (previousWorkspaceSlugRef.current === null) {
      // First mount — initial route restoration handles it
      previousWorkspaceSlugRef.current = workspaceSlug
      return
    }

    if (previousWorkspaceSlugRef.current === workspaceSlug) return
    previousWorkspaceSlugRef.current = workspaceSlug

    // Suppress pushState during reconciliation
    suppressPushRef.current = true

    if (isPopstateSwitchRef.current) {
      // Popstate-triggered: URL is already correct, just reconcile from it
      isPopstateSwitchRef.current = false
      reconcileFromUrlParamsRef.current(new URLSearchParams(window.location.search))
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    } else {
      // UI-triggered: load stored URL for the new workspace, push history entry
      const savedSearch = storage.get<string>(storage.KEYS.workspaceUrl, '', workspaceSlug)

      const url = new URL(window.location.href)
      if (savedSearch) {
        // Replace all params with the saved workspace's URL
        url.search = savedSearch
      } else {
        // No saved state — default to allSessions
        for (const key of [...url.searchParams.keys()]) {
          url.searchParams.delete(key)
        }
        url.searchParams.set('ws', workspaceSlug)
        url.searchParams.set('route', 'allSessions')
      }

      // Push a new history entry for the workspace switch
      const seq = nextHistorySeqRef.current++
      history.pushState({ seq }, '', url.toString())
      historySeqRef.current = seq
      historyMaxSeqRef.current = seq
      updateCanGoBackForward()

      // Reconcile panels from the new URL
      reconcileFromUrlParamsRef.current(new URLSearchParams(url.search))
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    }

    initialRouteRestoredRef.current = true

    requestAnimationFrame(() => {
      suppressPushRef.current = false
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    })
  }, [workspaceId, workspaceSlug, store, updateCanGoBackForward, getSemanticHistoryKey, isSessionsReady, historyMaxSeqRef, historySeqRef, initialRouteRestoredRef, isPopstateSwitchRef, lastSemanticHistoryKeyRef, nextHistorySeqRef, reconcileFromUrlParamsRef, suppressPushRef])

useEffect(() => {
    if (!canRunInitialRestore({
      isReady,
      isSessionsReady,
      workspaceId,
      initialRouteRestored: initialRouteRestoredRef.current,
    })) return
    initialRouteRestoredRef.current = true

    // Suppress pushState during initial restoration
    suppressPushRef.current = true

    const params = new URLSearchParams(window.location.search)

    // Reconcile panels + sidebar from current URL
    reconcileFromUrlParamsRef.current(params)
    lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()

    // If nothing was in the URL, navigate to default
    if (!params.get('route') && !params.get('panels')) {
      navigate(routes.view.allSessions())
    }

    // Initialize history with seq=0 (replaceState so we don't create an extra entry)
    history.replaceState({ seq: 0 }, '', window.location.href)
    historySeqRef.current = 0
    historyMaxSeqRef.current = 0

    requestAnimationFrame(() => {
      suppressPushRef.current = false
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    })
  }, [isReady, isSessionsReady, workspaceId, navigate, store, getSemanticHistoryKey, historyMaxSeqRef, historySeqRef, initialRouteRestoredRef, lastSemanticHistoryKeyRef, reconcileFromUrlParamsRef, suppressPushRef])

useEffect(() => {
    if (isReady && pendingNavigationRef.current) {
      const pending = pendingNavigationRef.current
      pendingNavigationRef.current = null

      if (pending.type === 'action') {
        handleActionNavigation(pending)
        return
      }

      const routeStr = `${pending.name}${pending.id ? `/${pending.id}` : ''}`
      const navState = parseRouteToNavigationState(routeStr)
      if (navState) {
        const resolved = resolveAutoSelection(navState)
        const finalRoute = buildRouteFromNavigationState(resolved) as ViewRoute
        store.set(updateFocusedPanelRouteAtom, finalRoute)
      }
    }
  }, [isReady, handleActionNavigation, resolveAutoSelection, store, pendingNavigationRef])

useEffect(() => {
    if (!workspaceId) return

    const cleanup = window.electronAPI.onDeepLinkNavigate((nav: DeepLinkNavigation) => {
      let route: string | null = null

      if (nav.view) {
        route = nav.view
      } else if (nav.action) {
        route = `action/${nav.action}`
        if (nav.actionParams?.["id"]) {
          route += `/${nav.actionParams["id"]}`
        }
        const otherParams = { ...nav.actionParams }
        delete otherParams["id"]
        if (Object.keys(otherParams).length > 0) {
          const params = new URLSearchParams(otherParams)
          route += `?${params.toString()}`
        }
      }

      if (route) {
        const navState = parseRouteToNavigationState(route)
        if (!navState && !route.startsWith('action/')) {
          toast.error(t('toast.invalidLink'), {
            description: t('toast.invalidLinkDesc'),
          })
          return
        }
        navigate(route as Route)
      }
    })

    return cleanup
  }, [workspaceId, navigate, t])

useEffect(() => {
    const handleNavigateEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ route: Route; newPanel?: boolean; targetLaneId?: 'main' }>
      if (customEvent.detail?.route) {
        const { route: r, newPanel, targetLaneId } = customEvent.detail
        navigate(r, newPanel ? omitUndefined({ newPanel, targetLaneId }) : undefined)
      }
    }

    window.addEventListener(NAVIGATE_EVENT, handleNavigateEvent)
    return () => {
      window.removeEventListener(NAVIGATE_EVENT, handleNavigateEvent)
    }
  }, [navigate])

const updateRightSidebar = useCallback((panel: RightSidebarPanel | undefined) => {
    setRightSidebar(panel)
    // pushState handled by the rightSidebar change effect
  }, [setRightSidebar])

const toggleRightSidebar = useCallback((panel?: RightSidebarPanel) => {
    const currentSidebar = rightSidebarRef.current
    const newPanel = panel || (currentSidebar && currentSidebar.type !== 'none'
      ? { type: 'none' as const }
      : { type: 'none' as const })
    updateRightSidebar(newPanel)
  }, [updateRightSidebar, rightSidebarRef])

const navigateToSource = useCallback((sourceSlug?: string) => {
    if (isSourcesNavigation(navigationState) && navigationState.filter?.kind === 'type') {
      switch (navigationState.filter.sourceType) {
        case 'api':
          navigate(routes.view.sourcesApi(sourceSlug))
          return
        case 'mcp':
          navigate(routes.view.sourcesMcp(sourceSlug))
          return
        case 'local':
          navigate(routes.view.sourcesLocal(sourceSlug))
          return
      }
    }
    navigate(routes.view.sources(sourceSlug ? { sourceSlug } : undefined))
  }, [navigationState, navigate])

const navigateToSession = useCallback((sessionId: string) => {
    if (!isSessionsNavigation(navigationState)) {
      navigate(routes.view.allSessions(sessionId))
      return
    }

    const filter = navigationState.filter
    switch (filter.kind) {
      case 'allSessions':
        navigate(routes.view.allSessions(sessionId))
        break
      case 'flagged':
        navigate(routes.view.flagged(sessionId))
        break
      case 'archived':
        navigate(routes.view.archived(sessionId))
        break
      case 'state':
        navigate(routes.view.state(filter.stateId, sessionId))
        break
      case 'label':
        navigate(routes.view.label(filter.labelId, sessionId))
        break
      case 'view':
        navigate(routes.view.view(filter.viewId, sessionId))
        break
      default:
        navigate(routes.view.allSessions(sessionId))
    }
  }, [navigationState, navigate])
return { navigateToSession, updateRightSidebar, toggleRightSidebar, navigateToSource }
}
