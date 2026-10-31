import { createContext, useContext, type ReactNode } from 'react';

import { type Route } from '../../shared/routes';

import { type NavigateOptions } from '../lib/navigate';

import type { Session, NavigationState, RightSidebarPanel } from '../../shared/types';

export interface NavigationContextValue {
  /** Navigate to a route */
  navigate: (route: Route, options?: NavigateOptions) => void | Promise<void>
  /** Check if navigation is ready */
  isReady: boolean
  /** Unified navigation state — derived from focused panel + right sidebar */
  navigationState: NavigationState
  /** Whether we can go back in history */
  canGoBack: boolean
  /** Whether we can go forward in history */
  canGoForward: boolean
  /** Go back in history */
  goBack: () => void
  /** Go forward in history */
  goForward: () => void
  /** Update right sidebar panel */
  updateRightSidebar: (panel: RightSidebarPanel | undefined) => void
  /** Toggle right sidebar (with optional panel) */
  toggleRightSidebar: (panel?: RightSidebarPanel) => void
  /** Navigate to a source (or source list if no slug), preserving the current filter type */
  navigateToSource: (sourceSlug?: string) => void
  /** Navigate to a session, preserving the current filter type */
  navigateToSession: (sessionId: string) => void
}

export const NavigationContext = createContext<NavigationContextValue | null>(null)

export interface NavigationProviderProps {
  children: ReactNode
  /** Current workspace ID */
  workspaceId: string | null
  /** Current workspace slug (used for URL ?ws= param and localStorage) */
  workspaceSlug: string | null
  /** Switch to a workspace by slug (called on popstate when ?ws= changes) */
  onSwitchWorkspaceBySlug?: ((slug: string) => void) | undefined
  /** Session creation handler */
  onCreateSession: (workspaceId: string, options?: import('../../shared/types').CreateSessionOptions) => Promise<Session>
  /** Input change handler for pre-filling chat input */
  onInputChange?: ((sessionId: string, value: string) => void) | undefined
  /** Get draft input text for a session (reads from ref, no re-render) */
  getDraft?: ((sessionId: string) => string) | undefined
  /** Auto-delete an empty session (no confirmation needed) */
  onAutoDeleteEmptySession?: ((sessionId: string) => void) | undefined
  /** Whether the app is ready to navigate */
  isReady?: boolean | undefined
  /** Whether session metadata has been initialized (required for deterministic route restoration) */
  isSessionsReady?: boolean | undefined
  /** Remote workspace ID — when set, sessions with this ID are also considered part of the workspace */
  remoteWorkspaceId?: string | null | undefined
}

export function useNavigation() {
  const context = useContext(NavigationContext)
  if (!context) {
    throw new Error('useNavigation must be used within NavigationProvider')
  }
  return context
}

export function useNavigationState(): NavigationState {
  const { navigationState } = useNavigation()
  return navigationState
}
