/**
 * Web UI App — thin wrapper that:
 * 1. Fetches WS config from the server
 * 2. Creates the web API adapter + sets window.electronAPI
 * 3. Delegates to the Electron renderer's App component
 *
 * Mobile responsiveness is handled by container queries and isAutoCompact
 * in the shared renderer components — no webui-specific layout hacks needed.
 */

import React, { useCallback, useState, useEffect, useRef, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { LogOut, RefreshCw, ServerOff, ShieldCheck, WifiOff } from 'lucide-react'
import { createWebApi } from './adapter/web-api'
import type { WsRpcClient } from '../../electron/src/transport/client'
import { RemoteAccessScreen } from './components/RemoteAccessScreen'
import { RemoteConnectionBadge } from './components/RemoteConnectionBadge'

// Lazy-load the Electron App after window.electronAPI is set up.
// This prevents any Electron component from accessing window.electronAPI
// before the web adapter is ready.
const ElectronApp = lazy(() => import('@/App'))

type Phase = 'loading' | 'offline' | 'error' | 'ready'

interface WebuiConfig {
  wsUrl: string
  hostLabel: string
  session: {
    kind: 'owner' | 'remote-device'
    deviceId: string | null
    expiresAt: string
  }
}

function LoadingScreen() {
  const { t } = useTranslation()

  return (
    <main className="webui-state-page" aria-busy="true">
      <div className="webui-state-card" role="status" aria-live="polite">
        <div className="webui-state-icon text-accent">
          <RefreshCw className="h-7 w-7 animate-spin" />
        </div>
        <h1>{t('webui.connectingToServer')}</h1>
        <p>{t('webui.connectingDescription', 'Establishing a secure connection to your Robb host…')}</p>
      </div>
    </main>
  )
}

function ConnectionScreen({
  kind,
  message,
  onRetry,
}: {
  kind: 'offline' | 'error'
  message: string
  onRetry: () => void
}) {
  const { t } = useTranslation()
  const offline = kind === 'offline'
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutFailed, setLogoutFailed] = useState(false)

  const logOut = async () => {
    if (loggingOut || offline) return
    setLoggingOut(true)
    setLogoutFailed(false)
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error('Logout request failed')
      window.location.href = '/login'
    } catch {
      // A failed request leaves the HttpOnly session cookie valid. Keep the
      // user on this screen instead of presenting a false successful logout.
      setLogoutFailed(true)
      setLoggingOut(false)
    }
  }

  return (
    <main className="webui-state-page">
      <section className="webui-state-card" aria-labelledby="webui-connection-title">
        <div className={`webui-state-icon ${offline ? 'text-amber-600 dark:text-amber-300' : 'text-destructive'}`}>
          {offline ? <WifiOff className="h-7 w-7" /> : <ServerOff className="h-7 w-7" />}
        </div>
        <h1 id="webui-connection-title">
          {offline
            ? t('webui.offlineTitle', 'You are offline')
            : t('webui.hostUnavailableTitle', 'Your Robb host is unavailable')}
        </h1>
        <p>{offline
          ? t('webui.offlineDescription', 'Reconnect this device to the internet. Robb Agents will resume automatically when your host is reachable.')
          : t('webui.hostUnavailableDescription', 'The internet is available, but the host did not respond. Check that Robb Agents and Remote are running on your computer.')}
        </p>
        {message && <p className="webui-state-detail">{message}</p>}
        <div className="webui-state-actions">
          <button
            onClick={onRetry}
            className="webui-state-primary"
          >
            <RefreshCw className="h-4 w-4" />
            {t('common.retry')}
          </button>
          {!offline && (
            <button
              onClick={() => void logOut()}
              className="webui-state-secondary"
              disabled={loggingOut}
              aria-busy={loggingOut}
            >
              {loggingOut
                ? <RefreshCw className="h-4 w-4 animate-spin" />
                : <LogOut className="h-4 w-4" />}
              {t('webui.logOut')}
            </button>
          )}
        </div>
        {logoutFailed && (
          <p className="webui-state-detail" role="alert">
            {t('webui.logOutFailed', 'Sign-out failed. Your session is still active.')}
          </p>
        )}
        <div className="webui-state-privacy">
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-500" />
          <span>{t('webui.offlinePrivacy', 'Conversations, files, and credentials are never stored in the offline cache.')}</span>
        </div>
      </section>
    </main>
  )
}

export default function App() {
  const { t } = useTranslation()
  const translateRef = useRef(t)
  translateRef.current = t
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState('')
  const [config, setConfig] = useState<WebuiConfig | null>(null)
  const clientRef = useRef<WsRpcClient | null>(null)
  const initRef = useRef(false)
  const initializationInFlightRef = useRef(false)
  const wasOfflineRef = useRef(!navigator.onLine)
  const isRemotePairing = window.location.pathname === '/remote' || window.location.pathname === '/remote/'
  const isRemoteSetup = window.location.pathname === '/remote/setup' || window.location.pathname === '/remote/setup/'

  const initialize = useCallback(async () => {
    if (!navigator.onLine) {
      wasOfflineRef.current = true
      setError('')
      setPhase('offline')
      return
    }
    if (initializationInFlightRef.current) return
    initializationInFlightRef.current = true

    setPhase('loading')
    setError('')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 12_000)

    try {
      // 1. Fetch WS URL from the server (cookie auth)
      const configRes = await fetch('/api/config', {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      })
      if (!configRes.ok) {
        if (configRes.status === 401) {
          // Session expired — redirect to login
          window.location.href = '/login'
          return
        }
        throw new Error(`Failed to fetch config: ${configRes.status}`)
      }

      const nextConfig = await configRes.json() as WebuiConfig
      if (!nextConfig.wsUrl) throw new Error('Server did not return a WebSocket URL')
      setConfig(nextConfig)

      // 2. Determine workspace — check URL params first
      const params = new URLSearchParams(window.location.search)
      let workspaceId = params.get('workspace') ?? undefined

      // If no workspace in URL, fetch the default from the server
      // so we can include it in the WebSocket handshake
      if (!workspaceId) {
        try {
          const wsRes = await fetch('/api/config/workspaces', {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
          })
          if (wsRes.ok) {
            const { defaultWorkspaceId } = await wsRes.json() as { defaultWorkspaceId?: string }
            if (defaultWorkspaceId) workspaceId = defaultWorkspaceId
          }
        } catch {
          // Non-fatal — workspace will be set via switchWorkspace later
        }
      }

      // 3. Create web API adapter
      // Destroy previous client on retry
      if (clientRef.current) {
        clientRef.current.destroy()
      }

      const { api, client } = createWebApi({ serverUrl: nextConfig.wsUrl, workspaceId })
      clientRef.current = client

      // 4. Set window.electronAPI — must happen before any Electron component mounts
      window.electronAPI = api

      // 5. Connect the WebSocket client
      client.connect()

      setPhase('ready')
    } catch (err) {
      if (!navigator.onLine) {
        setError('')
        setPhase('offline')
        return
      }
      const msg = err instanceof DOMException && err.name === 'AbortError'
        ? translateRef.current('webui.connectionTimedOut', 'The connection timed out.')
        : err instanceof Error ? err.message : String(err)
      setError(msg)
      setPhase('error')
    } finally {
      window.clearTimeout(timeout)
      initializationInFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    if (isRemotePairing || isRemoteSetup) return
    if (!initRef.current) {
      initRef.current = true
      void initialize()
    }

    return () => {
      // Cleanup on unmount
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
      if (document.visibilityState === 'visible' && navigator.onLine) retryConnection()
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

  if (isRemotePairing) return <RemoteAccessScreen mode="pair" />
  if (isRemoteSetup) return <RemoteAccessScreen mode="setup" />

  if (phase === 'loading') return <LoadingScreen />
  if (phase === 'offline') return <ConnectionScreen kind="offline" message={error} onRetry={() => void initialize()} />
  if (phase === 'error') return <ConnectionScreen kind="error" message={error} onRetry={() => void initialize()} />

  return (
    <>
      {config?.session.kind === 'remote-device' && clientRef.current && (
        <RemoteConnectionBadge client={clientRef.current} hostLabel={config.hostLabel} />
      )}
      <Suspense fallback={<LoadingScreen />}>
        <ElectronApp />
      </Suspense>
    </>
  )
}
