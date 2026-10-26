import * as React from "react";

import { useRef, useEffect, useCallback } from "react";
import { useAtomValue, useStore } from "jotai";

import { isWebUI } from "@/lib/platform";

import { useSession } from "@/hooks/useSession";

import { useEscapeInterrupt } from "@/context/EscapeInterruptContext";
import { useTheme } from "@/context/ThemeContext";

import { useActionLabel } from "@/actions";

import { useSetAtom } from "jotai";

import { panelStackAtom, panelCountAtom, focusedPanelIdAtom, focusedSessionIdAtom, parseSessionIdFromRoute } from "@/atoms/panel-stack";

import { useContainerWidth } from "@/hooks/useContainerWidth";

import * as storage from "@/lib/local-storage";

import { useNavigation, useNavigationState, isSessionsNavigation } from "@/contexts/NavigationContext";

interface useShellLayoutStateInput {
  defaultCollapsed: boolean
  isFocusedMode: boolean
}

export function useShellLayoutState({
  defaultCollapsed,
  isFocusedMode,
}: useShellLayoutStateInput) {
const newChatHotkey = useActionLabel('app.newChat').hotkey

const [isSidebarVisible, setIsSidebarVisible] = React.useState(() => {
    return storage.get(storage.KEYS.sidebarVisible, !defaultCollapsed)
  })

const [sidebarWidth, setSidebarWidth] = React.useState(() => {
    return storage.get(storage.KEYS.sidebarWidth, 220)
  })

const [sessionListWidth, setSessionListWidth] = React.useState(() => {
    return storage.get(storage.KEYS.sessionListWidth, 300)
  })

const [isSidebarAndNavigatorHidden, setIsSidebarAndNavigatorHidden] = React.useState(() => {
    return isFocusedMode || storage.get(storage.KEYS.focusModeEnabled, false)
  })

const shellRef = useRef<HTMLDivElement>(null)

const shellWidth = useContainerWidth(shellRef)

const MOBILE_THRESHOLD = isWebUI ? 1024 : 768

const isAutoCompact = shellWidth > 0 && shellWidth <= MOBILE_THRESHOLD

const effectiveSidebarAndNavigatorHidden = isSidebarAndNavigatorHidden || isAutoCompact

const [showWhatsNew, setShowWhatsNew] = React.useState(false)

const [releaseNotesContent, setReleaseNotesContent] = React.useState('')

const [hasUnseenReleaseNotes, setHasUnseenReleaseNotes] = React.useState(false)

useEffect(() => {
    window.electronAPI.getLatestReleaseVersion().then((latestVersion) => {
      if (!latestVersion) return
      const lastSeen = storage.get(storage.KEYS.whatsNewLastSeenVersion, '')
      setHasUnseenReleaseNotes(lastSeen !== latestVersion)
    })
  }, [])

const [isResizing, setIsResizing] = React.useState<'sidebar' | 'session-list' | null>(null)

const [sidebarHandleY, setSidebarHandleY] = React.useState<number | null>(null)

const [sessionListHandleY, setSessionListHandleY] = React.useState<number | null>(null)

const resizeHandleRef = React.useRef<HTMLDivElement>(null)

const sessionListHandleRef = React.useRef<HTMLDivElement>(null)

const [session, setSession] = useSession()

const { resolvedMode, isDark, setMode } = useTheme()

const { canGoBack, canGoForward, goBack, goForward, navigateToSource, navigateToSession } = useNavigation()

const { handleEscapePress } = useEscapeInterrupt()

const navState = useNavigationState()

const store = useStore()

const panelStack = useAtomValue(panelStackAtom)

const panelCount = useAtomValue(panelCountAtom)

const focusedSessionId = useAtomValue(focusedSessionIdAtom)

const setFocusedPanel = useSetAtom(focusedPanelIdAtom)

const navigateToSessionInPanel = useCallback((sessionId: string) => {
    // Check if the session is already open in any panel — focus it instead of navigating
    const stack = store.get(panelStackAtom)
    for (const entry of stack) {
      if (parseSessionIdFromRoute(entry.route) === sessionId) {
        setFocusedPanel(entry.id)
        return
      }
    }

    // Not open in any panel — navigate() updates the focused panel
    navigateToSession(sessionId)
  }, [store, setFocusedPanel, navigateToSession])

const sessionsContext = React.useMemo(() => {
    if (isSessionsNavigation(navState)) {
      return {
        filter: navState.filter,
        sessionId: navState.details?.sessionId ?? null,
      }
    }
    return null
  }, [navState])
return { sessionsContext, navState, isDark, navigateToSource, focusedSessionId, session, isSidebarAndNavigatorHidden, setIsSidebarAndNavigatorHidden, setIsSidebarVisible, panelCount, goBack, goForward, handleEscapePress, setMode, resolvedMode, isResizing, setSidebarWidth, resizeHandleRef, setSidebarHandleY, isSidebarVisible, sidebarWidth, setSessionListWidth, sessionListHandleRef, setSessionListHandleY, sessionListWidth, setIsResizing, setSession, setReleaseNotesContent, setShowWhatsNew, setHasUnseenReleaseNotes, isAutoCompact, canGoBack, canGoForward, shellRef, newChatHotkey, hasUnseenReleaseNotes, effectiveSidebarAndNavigatorHidden, navigateToSession, navigateToSessionInPanel, sidebarHandleY, sessionListHandleY, showWhatsNew, releaseNotesContent }
}
