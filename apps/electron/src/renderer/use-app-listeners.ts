import { useEffectEvent } from 'react';
import React, { useEffect } from 'react';

import { navigate, routes } from './lib/navigate';

import { getSessionsToRefreshAfterStaleReconnect } from './lib/reconnect-recovery';

import { sessionAtomFamily, sessionMetaMapAtom, forceSessionMessagesReloadAtom, type SessionMeta } from '@/atoms/sessions';

import { type SessionListRefreshOptions } from "./app-runtime-helpers";

interface useAppListenersInput {
  refreshSessionListMetadataFromServer: (options?: SessionListRefreshOptions) => Promise<Map<string, SessionMeta> | null>
  sessionSelection: { selected: string | null; }
  store: import("jotai").Store
  refreshSessionFromServer: (sessionId: string) => Promise<"refreshed" | "preserved_stale_messages" | "failed">
  setMenuNewChatTrigger: React.Dispatch<React.SetStateAction<number>>
  handleOpenSettings: () => void
}

export function useAppListeners({
  refreshSessionListMetadataFromServer,
  sessionSelection,
  store,
  refreshSessionFromServer,
  setMenuNewChatTrigger,
  handleOpenSettings,
}: useAppListenersInput) {
useEffect(() => {
    const cleanup = window.electronAPI.onReconnected(async (isStale: boolean) => {
      if (!isStale) {
        // Server replayed buffered events — we're caught up, nothing to do
        console.info('[App] Reconnected with event replay — no refresh needed')
        return
      }

      console.warn('[App] Stale reconnect — refreshing session metadata and active/processing sessions')

      const refreshedMetaMap = await refreshSessionListMetadataFromServer({
        removeMissing: false,
        reason: 'stale-reconnect',
        selectedSessionId: sessionSelection.selected,
      })
      const metaMap = refreshedMetaMap ?? store.get(sessionMetaMapAtom)
      const refreshIds = getSessionsToRefreshAfterStaleReconnect(metaMap, sessionSelection.selected)

      console.info(`[App] Stale reconnect — refreshing ${refreshIds.length} session(s):`, refreshIds)

      // Refresh full message content only for the active session plus any
      // session still marked processing after the metadata refresh.
      for (const sessionId of refreshIds) {
        let refreshResult = await refreshSessionFromServer(sessionId)
        if (refreshResult !== 'refreshed') {
          // Server may need time to restart session subprocess after reconnect,
          // or it may still be lazily loading session messages.
          for (const delay of [2000, 4000]) {
            console.warn(`[App] Retrying session refresh for ${sessionId} after ${delay}ms (${refreshResult})`)
            await new Promise(r => setTimeout(r, delay))
            refreshResult = await refreshSessionFromServer(sessionId)
            if (refreshResult === 'refreshed') break
          }
        }
      }

      // Final fallback: if the active session is still empty, force a reload
      // even when the session is already marked loaded.
      if (sessionSelection.selected) {
        const session = store.get(sessionAtomFamily(sessionSelection.selected))
        if (session && (!session.messages || session.messages.length === 0)) {
          console.warn('[App] Active session still has no messages after stale reconnect refresh — forcing message reload')
          await store.set(forceSessionMessagesReloadAtom, sessionSelection.selected)
        } else if (session) {
          console.info(`[App] Stale reconnect recovery complete — active session has ${session.messages?.length ?? 0} messages`)
        }
      }

    })

    return cleanup
  }, [store, sessionSelection.selected, refreshSessionFromServer, refreshSessionListMetadataFromServer])

const openSettingsFromMenu = useEffectEvent(handleOpenSettings);
useEffect(() => {
    const unsubNewChat = window.electronAPI.onMenuNewChat(() => {
      setMenuNewChatTrigger(n => n + 1)
    })
    const unsubSettings = window.electronAPI.onMenuOpenSettings(() => {
      openSettingsFromMenu()
    })
    const unsubShortcuts = window.electronAPI.onMenuKeyboardShortcuts(() => {
      navigate(routes.view.settings('shortcuts'))
    })
    return () => {
      unsubNewChat()
      unsubSettings()
      unsubShortcuts()
    }
  // The settings callback is declared later in App and is invoked only by the
  // installed menu listener; resubscribing on every render would lose events.
  }, [setMenuNewChatTrigger])
return {  }
}
