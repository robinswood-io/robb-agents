import { type ReactNode } from 'react';

import { type Route } from '../../shared/routes';

import { type NavigateOptions } from '../lib/navigate';

import type { NavigationState, RightSidebarPanel } from '../../shared/types';

import { NavigationContext } from "./navigation-context-state";

interface NavigationProviderContentProps {
  navigate: (route: Route, options?: NavigateOptions) => Promise<void>
  isReady: boolean
  navigationState: NavigationState
  canGoBack: boolean
  canGoForward: boolean
  goBack: () => void
  goForward: () => void
  updateRightSidebar: (panel: RightSidebarPanel | undefined) => void
  toggleRightSidebar: (panel?: RightSidebarPanel) => void
  navigateToSource: (sourceSlug?: string) => void
  navigateToSession: (sessionId: string) => void
  children: ReactNode
}

export function NavigationProviderContent({
  navigate,
  isReady,
  navigationState,
  canGoBack,
  canGoForward,
  goBack,
  goForward,
  updateRightSidebar,
  toggleRightSidebar,
  navigateToSource,
  navigateToSession,
  children,
}: NavigationProviderContentProps) {

  return (
    <NavigationContext.Provider
      value={{
        navigate,
        isReady,
        navigationState,
        canGoBack,
        canGoForward,
        goBack,
        goForward,
        updateRightSidebar,
        toggleRightSidebar,
        navigateToSource,
        navigateToSession,
      }}
    >
      {children}
    </NavigationContext.Provider>
  )
}
