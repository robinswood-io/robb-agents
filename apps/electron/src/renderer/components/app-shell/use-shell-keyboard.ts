import * as React from "react";

import { useCallback } from "react";

import type { ChatDisplayHandle } from "./ChatDisplay";

import { ensureSessionMessagesLoadedAtom } from "@/atoms/sessions";
import { type AppShellContextType } from "@/context/AppShellContext";

import { useAction } from "@/actions";
import { useFocusZone } from "@/hooks/keyboard";
import { useFocusContext } from "@/context/FocusContext";

import { useSetAtom } from "jotai";
import type { LoadedSource,LoadedSkill,PermissionMode } from "../../../shared/types";

import { focusNextPanelAtom,focusPrevPanelAtom } from "@/atoms/panel-stack";

import { navigate,routes } from "@/lib/navigate";
import { isAutomationsNavigation,type NavigationState } from "@/contexts/NavigationContext";

import { dispatchFocusInputEvent } from "./input/focus-input-events";

interface useShellKeyboardInput {
  activeWorkspaceId: string | null
  navigateToSource: (sourceSlug?: string) => void
  navState: NavigationState
  focusedSessionId: string | null
  session: { selected: string | null; }
  contextValue: AppShellContextType
  enabledModes: PermissionMode[]
  isSidebarAndNavigatorHidden: boolean
  setIsSidebarAndNavigatorHidden: React.Dispatch<React.SetStateAction<boolean>>
  setIsSidebarVisible: React.Dispatch<React.SetStateAction<boolean>>
  panelCount: number
  handleNewChat: (newPanel?: boolean) => void
  onOpenSettings: () => void
  onOpenKeyboardShortcuts: () => void
  goBack: () => void
  goForward: () => void
  chatDisplayRef: React.RefObject<ChatDisplayHandle | null>
  searchActive: boolean
  chatMatchInfo: { sessionId: string | null; count: number; index: number; isHighlighting?: boolean; }
}

export function useShellKeyboard({
  activeWorkspaceId,
  navigateToSource,
  navState,
  focusedSessionId,
  session,
  contextValue,
  enabledModes,
  isSidebarAndNavigatorHidden,
  setIsSidebarAndNavigatorHidden,
  setIsSidebarVisible,
  panelCount,
  handleNewChat,
  onOpenSettings,
  onOpenKeyboardShortcuts,
  goBack,
  goForward,
  chatDisplayRef,
  searchActive,
  chatMatchInfo,
}: useShellKeyboardInput) {
const ensureMessagesLoaded = useSetAtom(ensureSessionMessagesLoadedAtom)

const handleSourceSelect = React.useCallback((source: LoadedSource) => {
    if (!activeWorkspaceId) return
    navigateToSource(source.config.slug)
  }, [activeWorkspaceId, navigateToSource])

const handleSkillSelect = React.useCallback((skill: LoadedSkill) => {
    if (!activeWorkspaceId) return
    navigate(routes.view.skills(skill.slug))
  }, [activeWorkspaceId])

const handleAutomationSelect = React.useCallback((automationId: string) => {
    // Preserve current automation filter when selecting an automation
    const type = isAutomationsNavigation(navState) ? navState.filter?.automationType : undefined
    navigate(routes.view.automations({ automationId, ...(type !== undefined ? { type } : {}) }))
  }, [navState])

const { focusZone, focusNextZone } = useFocusContext()

const { zoneRef: sidebarRef, isFocused: sidebarFocused } = useFocusZone({ zoneId: 'sidebar' })

useAction('nav.focusSidebar', () => focusZone('sidebar', { intent: 'keyboard' }))

useAction('nav.focusNavigator', () => focusZone('navigator', { intent: 'keyboard' }))

useAction('nav.focusChat', () => focusZone('chat', { intent: 'keyboard' }))

useAction('nav.nextZone', () => {
    focusNextZone()
  }, { enabled: () => !document.querySelector('[role="dialog"]') })

const effectiveSessionId = focusedSessionId ?? session.selected

const focusChatInputForSession = useCallback((targetSessionId?: string | null) => {
    if (!targetSessionId) return
    dispatchFocusInputEvent({ sessionId: targetSessionId })
  }, [])

useAction('chat.cyclePermissionMode', () => {
    if (effectiveSessionId) {
      const currentOptions = contextValue.sessionOptions.get(effectiveSessionId)
      const currentMode = currentOptions?.permissionMode ?? 'ask'
      // Cycle through enabled permission modes
      const modes = enabledModes.length >= 2 ? enabledModes : ['safe', 'ask', 'allow-all'] as PermissionMode[]
      const currentIndex = modes.indexOf(currentMode)
      // If current mode not in enabled list, jump to first enabled mode
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % modes.length
      const nextMode = modes[nextIndex]
      if (nextMode) contextValue.onSessionOptionsChange(effectiveSessionId, { permissionMode: nextMode })
    }
  })

const handleToggleSidebar = useCallback(() => {
    if (isSidebarAndNavigatorHidden) {
      setIsSidebarAndNavigatorHidden(false)
      return
    }
    setIsSidebarVisible(v => !v)
  }, [isSidebarAndNavigatorHidden, setIsSidebarAndNavigatorHidden, setIsSidebarVisible])

useAction('view.toggleSidebar', handleToggleSidebar)

useAction('view.toggleFocusMode', () => setIsSidebarAndNavigatorHidden(v => !v))

const focusNextPanel = useSetAtom(focusNextPanelAtom)

const focusPrevPanel = useSetAtom(focusPrevPanelAtom)

useAction('panel.focusNext', focusNextPanel, { enabled: () => panelCount > 1 })

useAction('panel.focusPrev', focusPrevPanel, { enabled: () => panelCount > 1 })

useAction('app.newChat', () => handleNewChat())

useAction('app.newChatInPanel', () => handleNewChat(true))

useAction('app.settings', onOpenSettings)

useAction('app.keyboardShortcuts', onOpenKeyboardShortcuts)

useAction('app.newWindow', () => window.electronAPI.menuNewWindow())

useAction('app.quit', () => window.electronAPI.menuQuit())

useAction('nav.goBack', goBack)

useAction('nav.goForward', goForward)

useAction('nav.goBackAlt', goBack)

useAction('nav.goForwardAlt', goForward)

useAction('chat.nextSearchMatch', () => chatDisplayRef.current?.goToNextMatch(), {
    enabled: () => searchActive && (chatMatchInfo.count ?? 0) > 0
  })

useAction('chat.prevSearchMatch', () => chatDisplayRef.current?.goToPrevMatch(), {
    enabled: () => searchActive && (chatMatchInfo.count ?? 0) > 0
  })
return { effectiveSessionId, ensureMessagesLoaded, handleToggleSidebar, focusZone, sidebarFocused, sidebarRef, handleSourceSelect, handleSkillSelect, handleAutomationSelect, focusChatInputForSession }
}
