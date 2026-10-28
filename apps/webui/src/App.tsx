import { useCallback, useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import "lucide-react";
import "./adapter/web-api";
import { RemoteAccessScreen } from './components/RemoteAccessScreen';
import { RemoteConnectionBadge } from './components/RemoteConnectionBadge';
import "./components/OfflineWorkspace";
import { OfflineCoordinator } from './offline-coordinator';
import { getOfflineVault, isOfflineVaultEnabled, nextOfflineRetentionDeadline, type OfflineSessionAnchor, type OfflineVaultScope, type OfflineVaultState } from './offline-vault';
import { purgeSensitiveWebStorage, subscribeWebSessionInvalidation } from './private-storage';
import "./remote-auth-state";
import "./pwa-file-system";

import { useWebuiSessionActions } from "./use-webui-session-actions";












import { useWebuiOfflineActions } from "./use-webui-offline-actions";

import { useWebuiOfflineViews } from "./use-webui-offline-views";

import { useWebuiInitialization } from "./use-webui-initialization";

import { type Phase, type WebuiConfig, LoadingScreen, ConnectionScreen } from "./components/webui-shell-screens";
/**
 * Web UI App — thin wrapper that:
 * 1. Fetches WS config from the server
 * 2. Creates the web API adapter + sets window.electronAPI
 * 3. Delegates to the Electron renderer's App component
 *
 * Mobile responsiveness is handled by container queries and isAutoCompact
 * in the shared renderer components — no webui-specific layout hacks needed.
 */

import type { WsRpcClient } from '../../electron/src/transport/client';

if (typeof document !== 'undefined') {
  document.documentElement.dataset["robbRuntime"] = 'web'
}

// Lazy-load the Electron App after window.electronAPI is set up.
// This prevents any Electron component from accessing window.electronAPI
// before the web adapter is ready.
const ElectronApp = lazy(() => import('@/App'))

const offlineVault = getOfflineVault()
const offlineCoordinator = new OfflineCoordinator(offlineVault)

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
      .catch((loadError: unknown) => {
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
      .catch((purgeError: unknown) => {
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
      void purgeAllLocalPrivateData().catch((purgeError: unknown) => {
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
      void offlineVault.pruneExpired().catch((pruneError: unknown) => {
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
      if (!first || !last) return
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

  const {
    initialize,
    openOfflineWorkspace,
  } = useWebuiInitialization({
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
  })

  const {
    offlineSnapshots,
    offlinePins,
    offlineDrafts,
    offlineOutbox,
  } = useWebuiOfflineViews({
    offlineState,
    translateRef,
    offlineDraftEdits,
    reviewedOutbox,
  })

  const {
    enableOfflineWorkspace,
    toggleOfflinePin,
    removeOfflinePin,
    updateOfflineDraft,
    addDraftToOutbox,
    reviewOutboxItem,
  } = useWebuiOfflineActions({
    offlineStorageReady,
    offlineScope,
    transportConnected,
    offlineSyncRef,
    translateRef,
    setOfflineEnablePending,
    setOfflineStorageError,
    offlineCoordinator,
    offlineSyncFailedMessage,
    setOfflineDraftEdits,
    offlineVault,
    offlineDraftTimersRef,
    offlineState,
    setReviewedOutbox,
  })

  const {
    renderOfflineWorkspace,
    signOutWebSession,
  } = useWebuiSessionActions({
    offlineState,
    reviewedOutbox,
    setReviewedOutbox,
    offlineCoordinator,
    translateRef,
    purgeAllLocalPrivateData,
    transportConnected,
    offlineSyncRef,
    initialize,
    setOfflineStorageError,
    offlineSyncFailedMessage,
    terminalAuthHandledRef,
    setPhase,
    setOfflinePanelOpen,
    transportCleanupRef,
    clientRef,
    setError,
    offlineEnablePending,
    offlineSnapshots,
    offlinePins,
    offlineDrafts,
    offlineOutbox,
    offlineVault,
    offlineStorageError,
    offlineStorageReady,
    offlineScope,
    enableOfflineWorkspace,
    toggleOfflinePin,
    removeOfflinePin,
    updateOfflineDraft,
    addDraftToOutbox,
    reviewOutboxItem,
  })

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
