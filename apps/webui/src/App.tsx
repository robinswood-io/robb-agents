/**
 * Web UI App — thin wrapper that:
 * 1. Fetches WS config from the server
 * 2. Creates the web API adapter + sets window.electronAPI
 * 3. Delegates to the Electron renderer's App component
 *
 * Mobile responsiveness is handled by container queries and isAutoCompact
 * in the shared renderer components — no webui-specific layout hacks needed.
 */

import React, { useCallback, useState, useEffect, useRef, useMemo, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { LogOut, RefreshCw, ServerOff, ShieldCheck, WifiOff } from 'lucide-react'
import { createWebApi } from './adapter/web-api'
import type { WsRpcClient } from '../../electron/src/transport/client'
import { RemoteAccessScreen } from './components/RemoteAccessScreen'
import { RemoteConnectionBadge } from './components/RemoteConnectionBadge'
import {
  OfflineWorkspace,
  type OfflineDraftView,
  type OfflineOutboxItemView,
  type OfflinePinnedTextCandidate,
  type OfflinePinnedTextView,
  type OfflineSessionSnapshotView,
} from './components/OfflineWorkspace'
import { OfflineCoordinator } from './offline-coordinator'
import {
  OFFLINE_VAULT_MAX_DRAFT_CHARS,
  OFFLINE_VAULT_MAX_OUTBOX_ITEMS,
  OFFLINE_VAULT_RETENTION_MS,
  getOfflineVault,
  isOfflineVaultEnabled,
  nextOfflineRetentionDeadline,
  type OfflineSessionAnchor,
  type OfflineVaultScope,
  type OfflineVaultState,
} from './offline-vault'
import {
  broadcastWebSessionInvalidation,
  purgeSensitiveWebStorage,
  subscribeWebSessionInvalidation,
} from './private-storage'
import { isTerminalRemoteAuthState } from './remote-auth-state'
import { saveJsonFile } from './pwa-file-system'

if (typeof document !== 'undefined') {
  document.documentElement.dataset.robbRuntime = 'web'
}

// Lazy-load the Electron App after window.electronAPI is set up.
// This prevents any Electron component from accessing window.electronAPI
// before the web adapter is ready.
const ElectronApp = lazy(() => import('@/App'))

const offlineVault = getOfflineVault()
const offlineCoordinator = new OfflineCoordinator(offlineVault)

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
  onLogOut,
}: {
  kind: 'offline' | 'error'
  message: string
  onRetry: () => void
  onLogOut?: () => Promise<void>
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
      await onLogOut?.()
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
          <span>{t('webui.offlinePrivacy', 'The public app cache contains no private data. Opt-in free text is encrypted separately; structured file, credential, tool, and authentication fields stay excluded, but saved text can itself be sensitive.')}</span>
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
  const [offlineState, setOfflineState] = useState<OfflineVaultState>(() => offlineVault.getSnapshot())
  const [offlineStorageReady, setOfflineStorageReady] = useState(false)
  const [offlineStorageError, setOfflineStorageError] = useState('')
  const [offlinePanelOpen, setOfflinePanelOpen] = useState(false)
  const [offlineEnablePending, setOfflineEnablePending] = useState(false)
  const [offlineScope, setOfflineScope] = useState<OfflineVaultScope | null>(null)
  const [offlineDraftEdits, setOfflineDraftEdits] = useState<Record<string, string>>({})
  const [reviewedOutbox, setReviewedOutbox] = useState<Record<string, {
    canSend: boolean
    contextChanged: boolean
    reviewedAnchor?: OfflineSessionAnchor
    sending?: boolean
    detail?: string
  }>>({})
  const [transportConnected, setTransportConnected] = useState(false)
  const clientRef = useRef<WsRpcClient | null>(null)
  const transportCleanupRef = useRef<(() => void) | null>(null)
  const offlineSyncRef = useRef<(() => Promise<void>) | null>(null)
  const offlineDraftTimersRef = useRef<Map<string, number>>(new Map())
  const rendererSurfaceRef = useRef<HTMLDivElement>(null)
  const offlineDialogRef = useRef<HTMLDivElement>(null)
  const offlineReturnFocusRef = useRef<HTMLElement | null>(null)
  const initRef = useRef(false)
  const initializationInFlightRef = useRef(false)
  const terminalAuthHandledRef = useRef(false)
  const wasOfflineRef = useRef(!navigator.onLine)
  const isRemotePairing = window.location.pathname === '/remote' || window.location.pathname === '/remote/'
  const isRemoteSetup = window.location.pathname === '/remote/setup' || window.location.pathname === '/remote/setup/'

  const offlineSyncFailedMessage = useCallback(() => translateRef.current(
    'webui.offlineSyncFailed',
    'The offline copy could not be synchronized. Your saved local work was not sent or deleted.',
  ), [])

  const cancelOfflineDraftTimers = useCallback(() => {
    for (const timeout of offlineDraftTimersRef.current.values()) window.clearTimeout(timeout)
    offlineDraftTimersRef.current.clear()
  }, [])

  const purgeAllLocalPrivateData = useCallback(async () => {
    cancelOfflineDraftTimers()
    setOfflineDraftEdits({})
    setReviewedOutbox({})
    const failures: unknown[] = []
    try {
      await offlineCoordinator.purge()
    } catch (error) {
      failures.push(error)
    }
    try {
      purgeSensitiveWebStorage()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length > 0) {
      throw new Error('Private offline data could not be fully erased from this browser')
    }
  }, [cancelOfflineDraftTimers])

  useEffect(() => {
    const unsubscribe = offlineVault.subscribe(setOfflineState)
    try {
      purgeSensitiveWebStorage()
    } catch (storageError) {
      setOfflineStorageError(storageError instanceof Error ? storageError.message : String(storageError))
    }
    void offlineCoordinator.load()
      .catch((loadError) => {
        setOfflineStorageError(loadError instanceof Error ? loadError.message : String(loadError))
      })
      .finally(() => setOfflineStorageReady(true))
    return unsubscribe
  }, [])

  useEffect(() => () => cancelOfflineDraftTimers(), [cancelOfflineDraftTimers])

  useEffect(() => subscribeWebSessionInvalidation(() => {
    if (terminalAuthHandledRef.current) return
    terminalAuthHandledRef.current = true
    setPhase('loading')
    setOfflinePanelOpen(false)
    transportCleanupRef.current?.()
    transportCleanupRef.current = null
    clientRef.current?.destroy()
    void purgeAllLocalPrivateData()
      .then(() => window.location.replace('/login'))
      .catch((purgeError) => {
        const message = purgeError instanceof Error ? purgeError.message : String(purgeError)
        setOfflineStorageError(message)
        setError(message)
        setPhase('error')
      })
  }), [purgeAllLocalPrivateData])

  useEffect(() => {
    const expiresAt = offlineState.scope ? Date.parse(offlineState.scope.expiresAt) : Number.NaN
    if (!Number.isFinite(expiresAt)) return
    let timeout: number | undefined
    const expireWhenDue = () => {
      const remaining = expiresAt - Date.now()
      if (remaining > 0) {
        timeout = window.setTimeout(expireWhenDue, Math.min(remaining, 2_147_000_000))
        return
      }
      void purgeAllLocalPrivateData().catch((purgeError) => {
        setOfflineStorageError(purgeError instanceof Error ? purgeError.message : String(purgeError))
      })
    }
    expireWhenDue()
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }, [offlineState.scope?.expiresAt, purgeAllLocalPrivateData])

  useEffect(() => {
    const deadline = nextOfflineRetentionDeadline(offlineState)
    if (deadline === null || !offlineState.scope) return
    let timeout: number | undefined
    const pruneWhenDue = () => {
      const remaining = deadline - Date.now()
      if (remaining > 0) {
        timeout = window.setTimeout(pruneWhenDue, Math.min(remaining, 2_147_000_000))
        return
      }
      void offlineVault.pruneExpired().catch((pruneError) => {
        setOfflineStorageError(pruneError instanceof Error ? pruneError.message : String(pruneError))
      })
    }
    pruneWhenDue()
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }, [offlineState.updatedAt, offlineState.scope])

  useEffect(() => {
    if (offlineStorageReady && !navigator.onLine && phase === 'loading') {
      // Show the local workspace immediately while the same-origin LAN probe
      // continues in the background. A successful probe still transitions to
      // the live renderer.
      setPhase('offline')
    }
  }, [offlineStorageReady, phase])

  useEffect(() => {
    const surface = rendererSurfaceRef.current
    if (!surface) return
    surface.inert = offlinePanelOpen
    if (offlinePanelOpen) surface.setAttribute('aria-hidden', 'true')
    else surface.removeAttribute('aria-hidden')

    if (!offlinePanelOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOfflinePanelOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const dialog = offlineDialogRef.current
      if (!dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>([
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])',
      ].join(','))).filter((element) => element.getClientRects().length > 0)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!focusable.includes(document.activeElement as HTMLElement)) {
        event.preventDefault()
        if (event.shiftKey) last.focus()
        else first.focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      surface.inert = false
      surface.removeAttribute('aria-hidden')
      const target = offlineReturnFocusRef.current
      window.requestAnimationFrame(() => {
        if (target?.isConnected) {
          target.focus()
          return
        }
        document.querySelector<HTMLElement>(
          '[data-testid="remote-mobile-menu"], [data-testid="remote-offline-workspace"]',
        )?.focus()
      })
    }
  }, [offlinePanelOpen])

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

      const { api, client, syncOfflineData } = createWebApi({
        serverUrl: nextConfig.wsUrl,
        workspaceId,
        offlineCoordinator,
        onWorkspaceChanged: applyValidatedWorkspaceScope,
      })
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
          .catch((purgeError) => {
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

  const offlineSnapshots = useMemo<OfflineSessionSnapshotView[]>(() => (
    offlineState.sessions.map((snapshot) => ({
      id: snapshot.id,
      title: snapshot.name,
      workspaceName: offlineState.scope?.hostLabel,
      lastMessageAt: snapshot.lastMessageAt,
      syncedAt: snapshot.capturedAt,
      messageCount: snapshot.anchor.messageCount,
      messages: snapshot.messages,
    }))
  ), [offlineState.scope?.hostLabel, offlineState.sessions])

  const offlinePins = useMemo<OfflinePinnedTextView[]>(() => {
    const titles = new Map(offlineState.sessions.map((snapshot) => [snapshot.id, snapshot.name]))
    return offlineState.pins.map((pin) => ({
      id: pin.id,
      sessionId: pin.sessionId,
      sessionTitle: titles.get(pin.sessionId) ?? translateRef.current('chat.newChat', 'New chat'),
      messageId: pin.messageId,
      role: pin.role,
      content: pin.text,
      pinnedAt: pin.createdAt,
    }))
  }, [offlineState.pins, offlineState.sessions])

  const offlineDrafts = useMemo<OfflineDraftView[]>(() => {
    const titles = new Map(offlineState.sessions.map((snapshot) => [snapshot.id, snapshot.name]))
    const sessionIds = new Set([
      ...Object.keys(offlineState.drafts),
      ...Object.keys(offlineDraftEdits),
    ])
    return [...sessionIds].map((sessionId) => ({
      sessionId,
      sessionTitle: titles.get(sessionId) ?? translateRef.current('chat.newChat', 'New chat'),
      text: offlineDraftEdits[sessionId] ?? offlineState.drafts[sessionId]?.text ?? '',
      updatedAt: offlineState.drafts[sessionId]?.updatedAt,
      dirty: offlineState.drafts[sessionId]?.dirty ?? Object.hasOwn(offlineDraftEdits, sessionId),
    }))
  }, [offlineDraftEdits, offlineState.drafts])

  const offlineOutbox = useMemo<OfflineOutboxItemView[]>(() => (
    offlineState.outbox.map((item) => {
      const review = reviewedOutbox[item.id]
      const uncertain = item.status === 'uncertain'
      return {
        id: item.id,
        sessionId: item.sessionId,
        sessionTitle: item.sessionName,
        text: item.text,
        createdAt: item.createdAt,
        status: review?.sending
          ? 'sending'
          : uncertain
            ? 'uncertain'
            : review?.canSend
              ? 'ready'
              : 'pending-review',
        canSend: !uncertain && review?.canSend === true,
        contextChanged: review?.contextChanged || item.failureKind === 'context-changed',
        detail: review?.detail,
      }
    })
  ), [offlineState.outbox, reviewedOutbox])

  const enableOfflineWorkspace = useCallback(async () => {
    if (!offlineStorageReady || !offlineScope || !transportConnected || !offlineSyncRef.current) {
      throw new Error(translateRef.current('webui.offlineEnableRequiresConnection', 'Connect to the host before enabling offline storage.'))
    }
    setOfflineEnablePending(true)
    setOfflineStorageError('')
    let vaultEnabled = false
    try {
      await offlineCoordinator.enable(offlineScope)
      vaultEnabled = true
      // The opt-in click is also the appropriate moment to ask the browser to
      // protect IndexedDB from routine storage eviction. Denial is non-fatal.
      void navigator.storage?.persist?.().catch(() => false)
      await offlineSyncRef.current()
    } catch {
      const message = vaultEnabled
        ? offlineSyncFailedMessage()
        : translateRef.current('webui.offlineActionFailed', 'The action could not be completed. Review the current local state before trying again.')
      setOfflineStorageError(message)
      throw new Error(message)
    } finally {
      setOfflineEnablePending(false)
    }
  }, [offlineScope, offlineStorageReady, offlineSyncFailedMessage, transportConnected])

  const updateOfflineDraft = useCallback((sessionId: string, text: string) => {
    if (text.length > OFFLINE_VAULT_MAX_DRAFT_CHARS) return
    setOfflineDraftEdits((current) => ({ ...current, [sessionId]: text }))
    const scopeToken = offlineVault.getScopeToken()
    if (!scopeToken) return
    const existing = offlineDraftTimersRef.current.get(sessionId)
    if (existing) window.clearTimeout(existing)
    const timeout = window.setTimeout(() => {
      offlineDraftTimersRef.current.delete(sessionId)
      void offlineVault.storeDraft(sessionId, text, true, scopeToken)
        .then(() => {
          setOfflineDraftEdits((current) => {
            if (current[sessionId] !== text) return current
            const next = { ...current }
            delete next[sessionId]
            return next
          })
        })
        .catch((draftError) => {
          setOfflineStorageError(draftError instanceof Error ? draftError.message : String(draftError))
        })
    }, 350)
    offlineDraftTimersRef.current.set(sessionId, timeout)
  }, [])

  const addDraftToOutbox = useCallback(async (sessionId: string, text: string) => {
    const scopeToken = offlineVault.getScopeToken()
    if (!scopeToken) throw new Error('The offline workspace is no longer available')
    const snapshot = offlineState.sessions.find((entry) => entry.id === sessionId)
    let sessionName = snapshot?.name
    let anchor = snapshot?.anchor
    if (!anchor && transportConnected && window.electronAPI) {
      const session = await window.electronAPI.getSessionMessages(sessionId)
      if (session) {
        sessionName = session.name || session.preview || translateRef.current('chat.newChat', 'New chat')
        anchor = {
          messageCount: session.messages.length,
          lastFinalMessageId: session.lastFinalMessageId ?? null,
          lastMessageAt: session.lastMessageAt,
        }
      }
    }
    if (!anchor) throw new Error('The saved conversation is no longer available')
    const pendingDraft = offlineDraftTimersRef.current.get(sessionId)
    if (pendingDraft) {
      window.clearTimeout(pendingDraft)
      offlineDraftTimersRef.current.delete(sessionId)
    }
    await offlineVault.enqueueMessage({
      sessionId,
      sessionName: sessionName ?? translateRef.current('chat.newChat', 'New chat'),
      text,
      anchor,
    }, scopeToken)
    setOfflineDraftEdits((current) => {
      const next = { ...current }
      delete next[sessionId]
      return next
    })
  }, [offlineState.sessions, transportConnected])

  const toggleOfflinePin = useCallback(async (candidate: OfflinePinnedTextCandidate) => {
    const scopeToken = offlineVault.getScopeToken()
    if (!scopeToken) throw new Error('The offline workspace is no longer available')
    await offlineVault.togglePin({
      sessionId: candidate.sessionId,
      messageId: candidate.messageId,
      role: candidate.role,
      text: candidate.content,
    }, scopeToken)
  }, [])

  const removeOfflinePin = useCallback(async (pinId: string) => {
    const scopeToken = offlineVault.getScopeToken()
    if (!scopeToken) throw new Error('The offline workspace is no longer available')
    const pin = offlineState.pins.find((entry) => entry.id === pinId)
    if (!pin) return
    await offlineVault.togglePin({
      sessionId: pin.sessionId,
      messageId: pin.messageId,
      role: pin.role,
      text: pin.text,
    }, scopeToken)
  }, [offlineState.pins])

  const reviewOutboxItem = useCallback(async (itemId: string) => {
    const item = offlineState.outbox.find((entry) => entry.id === itemId)
    if (!item || !window.electronAPI) return
    if (item.status === 'uncertain') {
      const workspaceId = offlineState.scope?.workspaceId
      if (workspaceId) {
        await window.electronAPI.openSessionInNewWindow(workspaceId, item.sessionId)
      }
      setReviewedOutbox((current) => ({
        ...current,
        [itemId]: {
          canSend: false,
          contextChanged: true,
          detail: translateRef.current('webui.offlineUncertainReviewDetail', 'Open the live conversation and verify delivery. This item cannot be retried automatically.'),
        },
      }))
      return
    }
    const result = await offlineCoordinator.reviewOutboxItem(item, window.electronAPI)
    if (result.status === 'ready') {
      setReviewedOutbox((current) => ({
        ...current,
        [itemId]: {
          canSend: true,
          contextChanged: result.contextChanged,
          reviewedAnchor: result.reviewedAnchor,
          detail: result.contextChanged
            ? translateRef.current('webui.offlineContextReviewRequired', 'The live conversation changed. Read it before confirming this send.')
            : undefined,
        },
      }))
      return
    }
    const detail = result.reason === 'session-busy'
      ? translateRef.current('webui.offlineSessionBusy', 'Wait for the agent to finish before reviewing this item.')
      : result.reason === 'session-missing'
        ? translateRef.current('webui.offlineSessionMissing', 'This conversation no longer exists on the host.')
        : translateRef.current('webui.offlineReconnectBeforeSend', 'Reconnect before sending')
    setReviewedOutbox((current) => ({
      ...current,
      [itemId]: { canSend: false, contextChanged: false, detail },
    }))
  }, [offlineState.outbox])

  const sendReviewedOutboxItem = useCallback(async (itemId: string) => {
    const item = offlineState.outbox.find((entry) => entry.id === itemId)
    const review = reviewedOutbox[itemId]
    if (!item || !review?.canSend || !review.reviewedAnchor || !window.electronAPI || item.status === 'uncertain') return
    setReviewedOutbox((current) => ({
      ...current,
      [itemId]: { ...review, sending: true },
    }))
    let result: Awaited<ReturnType<typeof offlineCoordinator.sendOutboxItem>>
    try {
      result = await offlineCoordinator.sendOutboxItem(
        item,
        window.electronAPI,
        review.reviewedAnchor,
      )
    } catch (sendError) {
      setReviewedOutbox((current) => ({
        ...current,
        [itemId]: {
          canSend: false,
          contextChanged: false,
          detail: translateRef.current('webui.offlineSendBlocked', 'The host is not ready to accept this message.'),
        },
      }))
      throw sendError
    }
    if (result.status === 'sent') {
      setReviewedOutbox((current) => {
        const next = { ...current }
        delete next[itemId]
        return next
      })
      return
    }
    if (result.status === 'uncertain') {
      setReviewedOutbox((current) => ({
        ...current,
        [itemId]: {
          canSend: false,
          contextChanged: true,
          detail: translateRef.current('webui.offlineUncertainReviewDetail', 'Open the live conversation and verify delivery. This item cannot be retried automatically.'),
        },
      }))
      return
    }
    setReviewedOutbox((current) => ({
      ...current,
      [itemId]: {
        canSend: false,
        contextChanged: result.status === 'needs-confirmation',
        detail: result.status === 'needs-confirmation'
          ? translateRef.current('webui.offlineContextReviewRequired', 'The live conversation changed. Review it again before sending.')
          : translateRef.current('webui.offlineSendBlocked', 'The host is not ready to accept this message.'),
      },
    }))
  }, [offlineState.outbox, reviewedOutbox])

  const clearOfflineData = useCallback(async () => {
    await purgeAllLocalPrivateData()
  }, [purgeAllLocalPrivateData])

  const exportOfflineData = useCallback(async () => {
    const exportedAt = new Date().toISOString()
    const host = (offlineState.scope?.hostLabel ?? 'robb-agents').toLocaleLowerCase().replace(/[^\w.-]+/g, '-')
    await saveJsonFile({
      exportedAt,
      source: 'Robb Agents Remote PWA',
      state: offlineState,
    }, `robb-agents-offline-${host}-${exportedAt.slice(0, 10)}.json`)
  }, [offlineState])

  const retryOfflineSync = useCallback(async () => {
    if (!transportConnected || !offlineSyncRef.current) {
      await initialize()
      return
    }
    setOfflineStorageError('')
    try {
      await offlineSyncRef.current()
    } catch {
      const message = offlineSyncFailedMessage()
      setOfflineStorageError(message)
      throw new Error(message)
    }
  }, [initialize, offlineSyncFailedMessage, transportConnected])

  const signOutWebSession = useCallback(async () => {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    })
    if (!response.ok) throw new Error('Logout request failed')

    terminalAuthHandledRef.current = true
    broadcastWebSessionInvalidation()
    setPhase('loading')
    setOfflinePanelOpen(false)
    transportCleanupRef.current?.()
    transportCleanupRef.current = null
    clientRef.current?.destroy()
    try {
      await purgeAllLocalPrivateData()
    } catch (purgeError) {
      const message = translateRef.current(
        'webui.localEraseFailedAfterLogout',
        'You are signed out, but this browser could not fully erase its local offline data.',
      )
      setOfflineStorageError(message)
      setError(message)
      setPhase('error')
      throw purgeError
    }
    window.location.replace('/login')
  }, [purgeAllLocalPrivateData])

  const renderOfflineWorkspace = (online: boolean, connectionError?: string) => (
    <OfflineWorkspace
      enabled={!offlineEnablePending && isOfflineVaultEnabled() && offlineState.scope !== null}
      online={online}
      snapshots={offlineSnapshots}
      pinnedTexts={offlinePins}
      drafts={offlineDrafts}
      outbox={offlineOutbox}
      retentionDays={Math.round(OFFLINE_VAULT_RETENTION_MS / (24 * 60 * 60 * 1_000))}
      retentionOptionsDays={[7]}
      lastSyncedAt={offlineState.lastSyncAt ?? undefined}
      storageBytes={offlineVault.estimatePlaintextBytes()}
      draftMaxChars={OFFLINE_VAULT_MAX_DRAFT_CHARS}
      maxOutboxItems={OFFLINE_VAULT_MAX_OUTBOX_ITEMS}
      enablePending={offlineEnablePending}
      errorMessage={offlineStorageError || connectionError || (!online && !isOfflineVaultEnabled()
        ? translateRef.current('webui.offlineEnableOnlineFirst', 'Reconnect once to enable encrypted offline access on this device.')
        : undefined)}
      onEnable={online && offlineStorageReady && offlineScope ? enableOfflineWorkspace : undefined}
      onRetry={!online ? () => initialize() : offlineStorageError ? retryOfflineSync : undefined}
      onClose={online ? () => setOfflinePanelOpen(false) : undefined}
      onPinText={toggleOfflinePin}
      onUnpinText={removeOfflinePin}
      onDraftChange={updateOfflineDraft}
      onAddToOutbox={addDraftToOutbox}
      onReviewOutbox={online ? reviewOutboxItem : undefined}
      onSendOutbox={online ? sendReviewedOutboxItem : undefined}
      onDeleteOutbox={async (itemId) => {
        const confirmed = window.confirm(translateRef.current('webui.offlineDeleteOutboxConfirm', 'Delete this unsent item from this device?'))
        const scopeToken = offlineVault.getScopeToken()
        if (confirmed && scopeToken) await offlineVault.removeOutbox(itemId, scopeToken)
      }}
      onExportOfflineData={exportOfflineData}
      onClearOfflineData={clearOfflineData}
    />
  )

  if (isRemotePairing) return <RemoteAccessScreen mode="pair" />
  if (isRemoteSetup) return <RemoteAccessScreen mode="setup" />

  if (phase === 'loading') return <LoadingScreen />
  if (phase === 'offline') {
    return offlineStorageReady ? renderOfflineWorkspace(false) : <LoadingScreen />
  }
  if (phase === 'error') return (
    offlineStorageReady && isOfflineVaultEnabled() && offlineState.scope
      ? renderOfflineWorkspace(false, error)
      : <ConnectionScreen
          kind="error"
          message={error}
          onRetry={() => void initialize()}
          onLogOut={signOutWebSession}
        />
  )

  return (
    <>
      <div ref={rendererSurfaceRef} className="h-full min-h-0">
        {config && clientRef.current && (
          <RemoteConnectionBadge
            client={clientRef.current}
            hostLabel={config.hostLabel}
            offlineItemCount={offlineState.outbox.length + Object.values(offlineState.drafts).filter((draft) => draft.dirty).length}
            onOpenOfflineWorkspace={offlineStorageReady ? openOfflineWorkspace : undefined}
            onSignOut={signOutWebSession}
          />
        )}
        <Suspense fallback={<LoadingScreen />}>
          <ElectronApp />
        </Suspense>
      </div>
      {offlinePanelOpen && (
        <div
          ref={offlineDialogRef}
          className="fixed inset-0 z-[220] bg-background"
          role="dialog"
          aria-modal="true"
          aria-label={translateRef.current('webui.offlineOpen', 'Offline workspace')}
          tabIndex={-1}
        >
          {renderOfflineWorkspace(transportConnected)}
        </div>
      )}
    </>
  )
}
