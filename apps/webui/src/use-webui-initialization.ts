import type { WebApiOptions } from './adapter/web-api.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import React, { useCallback, useEffect } from 'react';

import { createWebApi } from './adapter/web-api';
import type { WsRpcClient } from '../../electron/src/transport/client';

import { OfflineCoordinator } from './offline-coordinator';
import { isOfflineVaultEnabled, type OfflineSessionAnchor, type OfflineVaultScope } from './offline-vault';

import { isTerminalRemoteAuthState } from './remote-auth-state';

import { type Phase, type WebuiConfig } from "./components/webui-shell-screens";

interface useWebuiInitializationInput {
  initializationInFlightRef: React.RefObject<boolean>
  setPhase: React.Dispatch<React.SetStateAction<Phase>>
  setError: React.Dispatch<React.SetStateAction<string>>
  purgeAllLocalPrivateData: () => Promise<void>
  setOfflineStorageError: React.Dispatch<React.SetStateAction<string>>
  setConfig: React.Dispatch<React.SetStateAction<WebuiConfig | null>>
  transportCleanupRef: React.RefObject<(() => void) | null>
  clientRef: React.RefObject<WsRpcClient | null>
  offlineSyncRef: React.RefObject<(() => Promise<void>) | null>
  terminalAuthHandledRef: React.RefObject<boolean>
  offlineVault: import("./offline-vault").OfflineVault
  cancelOfflineDraftTimers: () => void
  setOfflineDraftEdits: React.Dispatch<React.SetStateAction<Record<string, string>>>
  setReviewedOutbox: React.Dispatch<React.SetStateAction<Record<string, { canSend: boolean; contextChanged: boolean; reviewedAnchor?: OfflineSessionAnchor; sending?: boolean; detail?: string; }>>>
  setOfflineScope: React.Dispatch<React.SetStateAction<OfflineVaultScope | null>>
  offlineCoordinator: OfflineCoordinator
  setTransportConnected: React.Dispatch<React.SetStateAction<boolean>>
  setOfflinePanelOpen: React.Dispatch<React.SetStateAction<boolean>>
  offlineSyncFailedMessage: () => string
  translateRef: React.RefObject<import("i18next").TFunction<"translation", undefined>>
  isRemotePairing: boolean
  isRemoteSetup: boolean
  initRef: React.RefObject<boolean>
  wasOfflineRef: React.RefObject<boolean>
  phase: Phase
  offlinePanelOpen: boolean
  transportConnected: boolean
  offlineReturnFocusRef: React.RefObject<HTMLElement | null>
}

export function useWebuiInitialization({
  initializationInFlightRef,
  setPhase,
  setError,
  purgeAllLocalPrivateData,
  setOfflineStorageError,
  setConfig,
  transportCleanupRef,
  clientRef,
  offlineSyncRef,
  terminalAuthHandledRef,
  offlineVault,
  cancelOfflineDraftTimers,
  setOfflineDraftEdits,
  setReviewedOutbox,
  setOfflineScope,
  offlineCoordinator,
  setTransportConnected,
  setOfflinePanelOpen,
  offlineSyncFailedMessage,
  translateRef,
  isRemotePairing,
  isRemoteSetup,
  initRef,
  wasOfflineRef,
  phase,
  offlinePanelOpen,
  transportConnected,
  offlineReturnFocusRef,
}: useWebuiInitializationInput) {
const initialize = useCallback(async () => {
    if (initializationInFlightRef.current) return
    initializationInFlightRef.current = true

    setPhase((current) => current === 'offline' ? 'offline' : 'loading')
    setError('')
    const controller = new AbortController()
    const timeout = window.setTimeout(
      () => controller.abort(),
      navigator.onLine ? 12_000 : 4_000,
    )

    try {
      // 1. Fetch WS URL from the server (cookie auth). Do not short-circuit on
      // navigator.onLine: browsers can report "offline" while a same-origin
      // Robb host is still reachable over the LAN.
      const configRes = await fetch('/api/config', {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!configRes.ok) {
        if (configRes.status === 401) {
          // Session expired or this paired device was revoked. Fail closed by
          // removing its encrypted local workspace before returning to login.
          setPhase('loading')
          try {
            await purgeAllLocalPrivateData()
            window.location.replace('/login')
          } catch (purgeError) {
            const message = purgeError instanceof Error ? purgeError.message : String(purgeError)
            setOfflineStorageError(message)
            setError(message)
            setPhase('error')
          }
          return
        }
        throw new Error(`Failed to fetch config: ${configRes.status}`)
      }

      const nextConfig = await configRes.json() as WebuiConfig
      if (!nextConfig.wsUrl) throw new Error('Server did not return a WebSocket URL')
      setConfig(nextConfig)

      // 2. Start only with the authenticated server default. An untrusted
      // ?workspace= value is validated through the live allowed-workspace RPC
      // before it can re-scope (and clear) encrypted local data.
      const params = new URLSearchParams(window.location.search)
      const requestedWorkspace = params.get('workspace')
      const requestedWorkspaceId = requestedWorkspace
        && requestedWorkspace.length <= 256
        && !/[\u0000-\u001f\u007f]/.test(requestedWorkspace)
        ? requestedWorkspace
        : undefined
      let workspaceId: string | undefined
      const wsRes = await fetch('/api/config/workspaces', {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      })
      if (wsRes.ok) {
        const { defaultWorkspaceId } = await wsRes.json() as { defaultWorkspaceId?: string }
        if (defaultWorkspaceId) workspaceId = defaultWorkspaceId
      }

      // 3. Create web API adapter
      // Destroy previous client on retry
      transportCleanupRef.current?.()
      transportCleanupRef.current = null
      if (clientRef.current) {
        clientRef.current.destroy()
      }
      offlineSyncRef.current = null
      terminalAuthHandledRef.current = false

      const applyValidatedWorkspaceScope = async (validatedWorkspaceId: string) => {
        const currentToken = offlineVault.getScopeToken()
        if (currentToken && currentToken.workspaceId !== validatedWorkspaceId) {
          cancelOfflineDraftTimers()
          setOfflineDraftEdits({})
          setReviewedOutbox({})
        }
        const nextOfflineScope = {
          deviceId: nextConfig.session.deviceId ?? 'owner-session',
          workspaceId: validatedWorkspaceId,
          expiresAt: nextConfig.session.expiresAt,
          hostLabel: nextConfig.hostLabel,
        } satisfies OfflineVaultScope
        setOfflineScope(nextOfflineScope)
        if (!isOfflineVaultEnabled()) return
        try {
          await offlineCoordinator.configureScope(nextOfflineScope)
        } catch (scopeError) {
          try {
            await purgeAllLocalPrivateData()
          } catch {
            // The original scope error is more useful; both paths have already
            // emptied the in-memory private surface.
          }
          setOfflineStorageError(scopeError instanceof Error ? scopeError.message : String(scopeError))
        }
      }

      const { api, client, syncOfflineData } = createWebApi(omitUndefined<WebApiOptions>({
        serverUrl: nextConfig.wsUrl,
        workspaceId,
        offlineCoordinator,
        onWorkspaceChanged: applyValidatedWorkspaceScope,
      }))
      clientRef.current = client
      offlineSyncRef.current = syncOfflineData
      transportCleanupRef.current = client.onConnectionStateChanged((state) => {
        setTransportConnected(state.status === 'connected')
        const terminalAuth = isTerminalRemoteAuthState(state)
        if (!terminalAuth || terminalAuthHandledRef.current) return
        terminalAuthHandledRef.current = true
        setPhase('loading')
        setOfflinePanelOpen(false)
        transportCleanupRef.current?.()
        transportCleanupRef.current = null
        client.destroy()
        void purgeAllLocalPrivateData()
          .then(() => window.location.replace('/login'))
          .catch((purgeError: unknown) => {
            const message = purgeError instanceof Error ? purgeError.message : String(purgeError)
            setOfflineStorageError(message)
            setError(message)
            setPhase('error')
          })
      })

      // 4. Set window.electronAPI — must happen before any Electron component mounts
      window.electronAPI = api

      // 5. Connect the WebSocket client
      client.connect()

      // Await one authenticated RPC before trusting an effective workspace.
      const workspaces = await api.getWorkspaces()
      const knownWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id))
      if (!workspaceId || !knownWorkspaceIds.has(workspaceId)) {
        workspaceId = workspaces[0]?.id
      }
      if (!workspaceId) throw new Error('No accessible workspace is available')
      const effectiveWorkspaceId = requestedWorkspaceId && knownWorkspaceIds.has(requestedWorkspaceId)
        ? requestedWorkspaceId
        : workspaceId
      if (effectiveWorkspaceId !== workspaceId) {
        await api.switchWorkspace(effectiveWorkspaceId)
      } else {
        await applyValidatedWorkspaceScope(effectiveWorkspaceId)
      }

      if (isOfflineVaultEnabled()) {
        void syncOfflineData().catch(() => {
          setOfflineStorageError(offlineSyncFailedMessage())
        })
      }

      setPhase('ready')
    } catch (err) {
      if (terminalAuthHandledRef.current) return
      if (!navigator.onLine) {
        setError('')
        setPhase('offline')
        return
      }
      console.warn('[webui] Host initialization failed', err instanceof Error ? err.name : 'UnknownError')
      const msg = err instanceof DOMException && err.name === 'AbortError'
        ? translateRef.current('webui.connectionTimedOut', 'The connection timed out.')
        : translateRef.current(
          'webui.hostUnavailableDescription',
          'The internet is available, but the host did not respond. Check that Robb Agents and Remote are running on your computer.',
        )
      setError(msg)
      setPhase('error')
    } finally {
      window.clearTimeout(timeout)
      initializationInFlightRef.current = false
    }
  }, [cancelOfflineDraftTimers, offlineSyncFailedMessage, purgeAllLocalPrivateData])

useEffect(() => {
    if (isRemotePairing || isRemoteSetup) return
    if (!initRef.current) {
      initRef.current = true
      void initialize()
    }

    return () => {
      // Cleanup on unmount
      transportCleanupRef.current?.()
      transportCleanupRef.current = null
      offlineSyncRef.current = null
      clientRef.current?.destroy()
    }
  }, [initialize, isRemotePairing, isRemoteSetup])

useEffect(() => {
    if (isRemotePairing || isRemoteSetup) return

    const retryConnection = () => {
      const recoveredFromOffline = wasOfflineRef.current
      wasOfflineRef.current = false
      if (phase !== 'ready') {
        void initialize()
        return
      }

      const client = clientRef.current
      const status = client?.getConnectionState().status
      if (client && (recoveredFromOffline || (status !== 'connected' && status !== 'connecting'))) {
        client.reconnectNow()
      }
    }
    const handleOffline = () => {
      wasOfflineRef.current = true
      if (phase !== 'ready') {
        setError('')
        setPhase('offline')
      }
    }
    const handleVisibility = () => {
      // A local HTTPS origin may remain reachable even when the browser's
      // coarse online signal is false, so visibility is also a safe retry.
      if (document.visibilityState === 'visible') retryConnection()
    }

    window.addEventListener('online', retryConnection)
    window.addEventListener('offline', handleOffline)
    window.addEventListener('pageshow', retryConnection)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('online', retryConnection)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('pageshow', retryConnection)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [initialize, isRemotePairing, isRemoteSetup, phase])

useEffect(() => {
    if (!offlinePanelOpen || !transportConnected || !isOfflineVaultEnabled()) return
    void offlineSyncRef.current?.().catch(() => {
      setOfflineStorageError(offlineSyncFailedMessage())
    })
  }, [offlinePanelOpen, offlineSyncFailedMessage, transportConnected])

const openOfflineWorkspace = useCallback(() => {
    const activeElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    offlineReturnFocusRef.current = activeElement?.closest('#remote-mobile-status-menu')
      ? document.querySelector<HTMLElement>('[data-testid="remote-mobile-menu"]')
      : activeElement
    setOfflinePanelOpen(true)
  }, [])
return { initialize, openOfflineWorkspace }
}
