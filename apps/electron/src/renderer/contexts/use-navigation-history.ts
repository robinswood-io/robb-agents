import { useCallback, useEffect, useRef } from 'react';

import { useAtomValue } from 'jotai';

import { buildRightSidebarParam, type ParsedRoute } from '../../shared/route-parser';

import { buildSemanticHistoryKey } from './navigation-history';
import * as storage from '@/lib/local-storage';
import type { RightSidebarPanel } from '../../shared/types';

import { panelStackAtom, focusedPanelIdAtom, focusedPanelIndexAtom } from '@/atoms/panel-stack';

interface useNavigationHistoryInput {
  setCanGoBack: import("react").Dispatch<import("react").SetStateAction<boolean>>
  setCanGoForward: import("react").Dispatch<import("react").SetStateAction<boolean>>
  store: import("jotai").Store
  rightSidebarRef: import("react").RefObject<RightSidebarPanel | undefined>
  workspaceSlug: string | null
  rightSidebar: RightSidebarPanel | undefined
}

export function useNavigationHistory({
  setCanGoBack,
  setCanGoForward,
  store,
  rightSidebarRef,
  workspaceSlug,
  rightSidebar,
}: useNavigationHistoryInput) {
const historySeqRef = useRef(0)

const historyMaxSeqRef = useRef(0)

const nextHistorySeqRef = useRef(1)

const suppressPushRef = useRef(false)

const pendingPushRef = useRef(false)

const isPopstateSwitchRef = useRef(false)

const pendingNavigationRef = useRef<ParsedRoute | null>(null)

const suppressAutoSelectRef = useRef(false)

const initialRouteRestoredRef = useRef(false)

const lastSemanticHistoryKeyRef = useRef('')

const updateCanGoBackForward = useCallback(() => {
    setCanGoBack(historySeqRef.current > 0)
    setCanGoForward(historySeqRef.current < historyMaxSeqRef.current)
  }, [setCanGoBack, setCanGoForward])

const getSemanticHistoryKey = useCallback(() => {
    const panels = store.get(panelStackAtom)
    const focusedIdx = store.get(focusedPanelIndexAtom)
    const sidebarKey = buildRightSidebarParam(rightSidebarRef.current) ?? ''
    return buildSemanticHistoryKey({
      workspaceSlug,
      panelRoutes: panels.map(p => p.route),
      focusedPanelIndex: focusedIdx,
      sidebarParam: sidebarKey,
    })
  }, [store, workspaceSlug, rightSidebarRef])

const syncUrl = useCallback((push: boolean = false) => {
    const panels = store.get(panelStackAtom)
    const focusedIdx = store.get(focusedPanelIndexAtom)
    if (panels.length === 0) return

    const focusedPanel = panels[focusedIdx] ?? panels[0]
    if (!focusedPanel) return
    const url = new URL(window.location.href)

    // ?ws= workspace slug
    if (workspaceSlug) {
      url.searchParams.set('ws', workspaceSlug)
    }

    // ?route= is the focused panel's route
    url.searchParams.set('route', focusedPanel.route)

    // ?panels= encodes ALL panels in stack order
    if (panels.length > 1) {
      const encoded = panels.map(p => `${p.route}:${p.proportion.toFixed(4)}`).join(',')
      url.searchParams.set('panels', encoded)
    } else {
      url.searchParams.delete('panels')
    }

    // ?fi= is focused panel index (for multi-panel layouts)
    if (panels.length > 1) {
      url.searchParams.set('fi', String(focusedIdx))
    } else {
      url.searchParams.delete('fi')
    }

    // ?sidebar=
    const sidebarParam = buildRightSidebarParam(rightSidebarRef.current)
    if (sidebarParam) {
      url.searchParams.set('sidebar', sidebarParam)
    } else {
      url.searchParams.delete('sidebar')
    }

    const urlStr = url.toString()

    if (push) {
      const seq = nextHistorySeqRef.current++
      history.pushState({ seq }, '', urlStr)
      historySeqRef.current = seq
      historyMaxSeqRef.current = seq // Forward history discarded by browser
      updateCanGoBackForward()
    } else {
      history.replaceState({ ...history.state, seq: historySeqRef.current }, '', urlStr)
    }

    // Persist per-workspace URL for workspace switch restoration
    if (workspaceSlug) {
      storage.set(storage.KEYS.workspaceUrl, url.search, workspaceSlug)
    }
  }, [store, workspaceSlug, updateCanGoBackForward, rightSidebarRef])

const syncUrlRef = useRef(syncUrl)

useEffect(() => { syncUrlRef.current = syncUrl }, [syncUrl])

const maybePushHistoryForSemanticChange = useCallback(() => {
    const currentSemanticKey = getSemanticHistoryKey()
    if (currentSemanticKey === lastSemanticHistoryKeyRef.current) return

    syncUrlRef.current?.(true)
    lastSemanticHistoryKeyRef.current = currentSemanticKey
  }, [getSemanticHistoryKey])

const panelStack = useAtomValue(panelStackAtom)

const focusedPanelId = useAtomValue(focusedPanelIdAtom)

useEffect(() => {
    if (!initialRouteRestoredRef.current) return
    syncUrlRef.current(false)
  }, [panelStack, focusedPanelId, rightSidebar])

useEffect(() => {
    let prevRoutes = store.get(panelStackAtom).map(p => p.route)
    const unsub = store.sub(panelStackAtom, () => {
      if (suppressPushRef.current || !initialRouteRestoredRef.current) return
      const currRoutes = store.get(panelStackAtom).map(p => p.route)
      if (currRoutes.length !== prevRoutes.length || !currRoutes.every((r, i) => r === prevRoutes[i])) {
        if (!pendingPushRef.current) {
          pendingPushRef.current = true
          queueMicrotask(() => { pendingPushRef.current = false; maybePushHistoryForSemanticChange() })
        }
      }
      prevRoutes = currRoutes
    })
    return unsub
  }, [store, maybePushHistoryForSemanticChange])

useEffect(() => {
    let prevFocusId = store.get(focusedPanelIdAtom)
    const unsub = store.sub(focusedPanelIdAtom, () => {
      if (suppressPushRef.current || !initialRouteRestoredRef.current) return
      const newFocusId = store.get(focusedPanelIdAtom)
      if (newFocusId !== prevFocusId) {
        if (!pendingPushRef.current) {
          pendingPushRef.current = true
          queueMicrotask(() => { pendingPushRef.current = false; maybePushHistoryForSemanticChange() })
        }
        prevFocusId = newFocusId
      }
    })
    return unsub
  }, [store, maybePushHistoryForSemanticChange])

const prevSidebarTypeRef = useRef(rightSidebar?.type)
return { prevSidebarTypeRef, suppressPushRef, initialRouteRestoredRef, maybePushHistoryForSemanticChange, panelStack, suppressAutoSelectRef, pendingNavigationRef, historySeqRef, updateCanGoBackForward, isPopstateSwitchRef, lastSemanticHistoryKeyRef, getSemanticHistoryKey, nextHistorySeqRef, historyMaxSeqRef }
}
