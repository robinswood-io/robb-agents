import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Database, Download, LogOut, RefreshCw, Sparkles, Wifi, WifiOff, X } from 'lucide-react'
import type { WsRpcClient, TransportConnectionState } from '../../../electron/src/transport/client'
import {
  clearInstallPrompt,
  getInstallPrompt,
  isAppleMobileDevice,
  isRunningAsInstalledApp,
  subscribeToInstallPrompt,
  type BeforeInstallPromptEvent,
} from '../pwa-install'
import {
  activatePwaUpdate,
  subscribeToPwaUpdate,
} from '../pwa-registration'

export interface RemoteConnectionBadgeProps {
  client: WsRpcClient
  hostLabel: string
  offlineItemCount?: number
  onOpenOfflineWorkspace?: () => void
  onSignOut?: () => Promise<void>
}

const dialogFocusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function handleDialogKeyDown(
  event: KeyboardEvent,
  dialog: HTMLElement | null,
  closeDialog: () => void,
) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeDialog()
    return
  }

  if (event.key !== 'Tab' || !dialog) return

  const focusableElements = Array.from(
    dialog.querySelectorAll<HTMLElement>(dialogFocusableSelector),
  ).filter((element) => element.getClientRects().length > 0)

  if (focusableElements.length === 0) {
    event.preventDefault()
    dialog.focus()
    return
  }

  const firstElement = focusableElements[0]
  const lastElement = focusableElements[focusableElements.length - 1]
  const activeElement = document.activeElement
  if (!dialog.contains(activeElement) || activeElement === dialog) {
    event.preventDefault()
    if (event.shiftKey) lastElement.focus()
    else firstElement.focus()
  } else if (event.shiftKey && activeElement === firstElement) {
    event.preventDefault()
    lastElement.focus()
  } else if (!event.shiftKey && activeElement === lastElement) {
    event.preventDefault()
    firstElement.focus()
  }
}

function dialogReturnTarget(fallback: HTMLElement | null): HTMLElement | null {
  const activeElement = document.activeElement
  return activeElement instanceof HTMLElement && activeElement !== document.body
    ? activeElement
    : fallback
}

function statusTone(status: TransportConnectionState['status']): string {
  if (status === 'connected') return 'border-emerald-500/20 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
  if (status === 'failed' || status === 'disconnected') return 'border-destructive/20 bg-destructive/10 text-destructive'
  return 'border-amber-500/20 bg-amber-500/12 text-amber-700 dark:text-amber-300'
}

export function RemoteConnectionBadge({
  client,
  hostLabel,
  offlineItemCount = 0,
  onOpenOfflineWorkspace,
  onSignOut,
}: RemoteConnectionBadgeProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<TransportConnectionState>(() => client.getConnectionState())
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(() => getInstallPrompt())
  const [showInstallHelp, setShowInstallHelp] = useState(false)
  const [installed, setInstalled] = useState(() => isRunningAsInstalledApp())
  const [menuOpen, setMenuOpen] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState(false)
  const controlsRef = useRef<HTMLDivElement>(null)
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null)
  const mobileMenuDialogRef = useRef<HTMLElement>(null)
  const mobileMenuCloseRef = useRef<HTMLButtonElement>(null)
  const mobileMenuReturnFocusRef = useRef<HTMLElement | null>(null)
  const installHelpDialogRef = useRef<HTMLDivElement>(null)
  const installHelpCloseRef = useRef<HTMLButtonElement>(null)
  const installHelpReturnFocusRef = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const controls = controlsRef.current
    if (!controls) return
    const root = document.documentElement
    const updateReservedWidth = () => {
      root.style.setProperty(
        '--webui-remote-controls-width',
        `${Math.ceil(controls.getBoundingClientRect().width)}px`,
      )
    }
    root.classList.add('webui-remote-controls-active')
    updateReservedWidth()
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateReservedWidth)
    observer?.observe(controls)
    return () => {
      observer?.disconnect()
      root.classList.remove('webui-remote-controls-active')
      root.style.removeProperty('--webui-remote-controls-width')
    }
  }, [])

  useEffect(() => client.onConnectionStateChanged(setState), [client])
  useEffect(() => subscribeToInstallPrompt(setInstallPrompt), [])
  useEffect(() => subscribeToPwaUpdate((registration) => setUpdateAvailable(Boolean(registration?.waiting))), [])
  useEffect(() => {
    const onInstalled = () => {
      setInstalled(true)
      setShowInstallHelp(false)
    }
    window.addEventListener('appinstalled', onInstalled)
    return () => window.removeEventListener('appinstalled', onInstalled)
  }, [])
  useEffect(() => {
    if (!menuOpen) return

    mobileMenuReturnFocusRef.current = dialogReturnTarget(mobileMenuButtonRef.current)
    const focusFrame = window.requestAnimationFrame(() => mobileMenuCloseRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      handleDialogKeyDown(event, mobileMenuDialogRef.current, () => setMenuOpen(false))
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', onKeyDown)
      const returnTarget = mobileMenuReturnFocusRef.current
      window.requestAnimationFrame(() => {
        if (returnTarget?.isConnected) returnTarget.focus()
        else mobileMenuButtonRef.current?.focus()
      })
    }
  }, [menuOpen])
  useEffect(() => {
    if (!menuOpen) return
    const desktopStatusControls = window.matchMedia('(min-width: 640px)')
    const closeMobileMenu = () => {
      if (desktopStatusControls.matches) setMenuOpen(false)
    }
    closeMobileMenu()
    desktopStatusControls.addEventListener('change', closeMobileMenu)
    return () => desktopStatusControls.removeEventListener('change', closeMobileMenu)
  }, [menuOpen])
  useEffect(() => {
    if (!showInstallHelp) return

    installHelpReturnFocusRef.current = dialogReturnTarget(mobileMenuButtonRef.current)
    const focusFrame = window.requestAnimationFrame(() => installHelpCloseRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      handleDialogKeyDown(event, installHelpDialogRef.current, () => setShowInstallHelp(false))
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', onKeyDown)
      const returnTarget = installHelpReturnFocusRef.current
      window.requestAnimationFrame(() => {
        if (returnTarget?.isConnected) returnTarget.focus()
        else mobileMenuButtonRef.current?.focus()
      })
    }
  }, [showInstallHelp])

  const connected = state.status === 'connected'
  const retrying = state.status === 'connecting' || state.status === 'reconnecting'
  const label = connected
    ? t('webui.remoteLive', 'Remote · {{host}}', { host: hostLabel })
    : retrying
      ? t('webui.remoteReconnecting', 'Reconnecting to {{host}}…', { host: hostLabel })
      : t('webui.remoteOffline', 'Remote offline')

  const installApp = async () => {
    if (!installPrompt) {
      setMenuOpen(false)
      setShowInstallHelp(true)
      return
    }
    await installPrompt.prompt()
    const choice = await installPrompt.userChoice
    clearInstallPrompt()
    if (choice.outcome === 'accepted') {
      setInstalled(true)
      setMenuOpen(false)
    }
  }

  const signOut = async () => {
    if (!onSignOut || signingOut) return
    if (!window.confirm(t('dialog.logoutConfirmation'))) return
    setSigningOut(true)
    setSignOutError(false)
    try {
      await onSignOut()
    } catch {
      setSignOutError(true)
      setSigningOut(false)
    }
  }

  const statusIcon = connected
    ? <Wifi className="h-4 w-4" />
    : retrying
      ? <RefreshCw className="h-4 w-4 animate-spin" />
      : <WifiOff className="h-4 w-4" />

  return (
    <div ref={controlsRef} className="remote-connection-controls pointer-events-none fixed right-2 top-[calc(6px+env(safe-area-inset-top))] z-[100] flex items-center gap-1.5 sm:right-3">
      <button
        ref={mobileMenuButtonRef}
        type="button"
        data-testid="remote-mobile-menu"
        onClick={() => {
          setShowInstallHelp(false)
          setMenuOpen((open) => !open)
        }}
        className={`pointer-events-auto relative flex h-11 w-11 items-center justify-center rounded-xl border text-[11px] font-medium shadow-sm backdrop-blur-xl sm:hidden ${statusTone(state.status)}`}
        aria-label={t('webui.remoteMenu', 'Remote status and PWA options')}
        aria-expanded={menuOpen}
        aria-controls="remote-mobile-status-menu"
      >
        {statusIcon}
        {updateAvailable && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-accent ring-2 ring-background" />}
      </button>

      <div className="hidden items-center gap-1.5 sm:flex">
      <button
        type="button"
        onClick={() => {
          if (!connected) client.reconnectNow()
        }}
        disabled={connected}
        className={`pointer-events-auto flex h-11 max-w-[240px] items-center justify-center gap-2 rounded-xl border px-3 text-[11px] font-medium shadow-sm backdrop-blur-xl ${statusTone(state.status)}`}
        aria-live="polite"
        aria-label={label}
        title={label}
      >
        {statusIcon}
        <span className="truncate">{label}</span>
      </button>
      {!installed && (
        <button
          type="button"
          data-testid="remote-install-app"
          aria-label={t('webui.remoteInstall', 'Install')}
          title={t('webui.remoteInstall', 'Install')}
          className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-xl border border-accent/25 bg-accent text-[11px] font-semibold text-accent-foreground shadow-sm lg:w-auto lg:gap-1.5 lg:px-3"
          onClick={() => void installApp()}
        >
          <Download className="h-4 w-4" />
          <span className="hidden lg:inline">{t('webui.remoteInstall', 'Install')}</span>
        </button>
      )}
      {updateAvailable && (
        <button
          type="button"
          data-testid="remote-update-app"
          className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-xl border border-accent/25 bg-card/95 text-[11px] font-semibold text-foreground shadow-sm lg:w-auto lg:gap-1.5 lg:px-3"
          onClick={() => activatePwaUpdate()}
          aria-label={t('webui.updateNow', 'Update now')}
          title={t('webui.updateNow', 'Update now')}
        >
          <Sparkles className="h-4 w-4 text-accent" />
          <span className="hidden lg:inline">{t('webui.updateNow', 'Update now')}</span>
        </button>
      )}
      {onOpenOfflineWorkspace && (
        <button
          type="button"
          data-testid="remote-offline-workspace"
          className="pointer-events-auto relative flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-card/95 text-foreground shadow-sm lg:w-auto lg:gap-1.5 lg:px-3"
          onClick={onOpenOfflineWorkspace}
          aria-label={t('webui.offlineOpen', 'Offline workspace')}
          title={t('webui.offlineOpen', 'Offline workspace')}
        >
          <Database className="h-4 w-4 text-accent" />
          <span className="hidden lg:inline">{t('webui.offlineShort', 'Offline')}</span>
          {offlineItemCount > 0 && (
            <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-accent px-1 text-center text-[10px] font-bold leading-5 text-accent-foreground lg:static lg:ml-0.5">
              {Math.min(99, offlineItemCount)}
            </span>
          )}
        </button>
      )}
      {onSignOut && (
        <button
          type="button"
          className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-card/95 text-foreground shadow-sm"
          onClick={() => void signOut()}
          disabled={signingOut}
          aria-label={t('webui.logOut')}
          title={t('webui.logOut')}
        >
          {signingOut
            ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
            : <LogOut className="h-4 w-4" aria-hidden="true" />}
        </button>
      )}
      </div>

      {signOutError && !menuOpen && (
        <p
          className="pointer-events-auto fixed right-3 top-[calc(62px+env(safe-area-inset-top))] max-w-[calc(100vw-1.5rem)] rounded-xl border border-destructive/40 bg-destructive px-3 py-2 text-xs font-medium text-destructive-foreground shadow-lg"
          role="alert"
        >
          {t('webui.logOutFailed')}
        </p>
      )}

      {menuOpen && (
        <div
          className="pointer-events-auto fixed inset-0 bg-foreground/20 sm:hidden"
          onPointerDown={() => setMenuOpen(false)}
        >
          <section
            ref={mobileMenuDialogRef}
            id="remote-mobile-status-menu"
            data-testid="remote-mobile-status-menu"
            className="fixed left-3 right-3 top-[calc(62px+env(safe-area-inset-top))] rounded-2xl border border-border/70 bg-card/95 p-4 text-sm text-foreground shadow-2xl backdrop-blur-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remote-mobile-status-title"
            tabIndex={-1}
            onPointerDown={(event) => event.stopPropagation()}
          >
          <button
            ref={mobileMenuCloseRef}
            type="button"
            className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/5"
            onClick={() => setMenuOpen(false)}
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-3 pr-10">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${statusTone(state.status)}`}>
              {statusIcon}
            </div>
            <div className="min-w-0">
              <p id="remote-mobile-status-title" className="truncate font-semibold">{label}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{hostLabel}</p>
            </div>
          </div>
          <div className="mt-4 grid gap-2">
            {onOpenOfflineWorkspace && (
              <button
                type="button"
                className="relative flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-background/70 px-4 font-semibold"
                onClick={() => {
                  setMenuOpen(false)
                  onOpenOfflineWorkspace()
                }}
              >
                <Database className="h-4 w-4 text-accent" />
                {t('webui.offlineOpen', 'Offline workspace')}
                {offlineItemCount > 0 && (
                  <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] text-accent-foreground">
                    {Math.min(99, offlineItemCount)}
                  </span>
                )}
              </button>
            )}
            {!connected && (
              <button
                type="button"
                className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent px-4 font-semibold text-accent-foreground"
                onClick={() => {
                  client.reconnectNow()
                  setMenuOpen(false)
                }}
              >
                <RefreshCw className="h-4 w-4" />
                {t('common.retry')}
              </button>
            )}
            {!installed && (
              <button
                type="button"
                className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-background/70 px-4 font-semibold"
                onClick={() => void installApp()}
              >
                <Download className="h-4 w-4" />
                {t('webui.remoteInstall', 'Install')}
              </button>
            )}
            {updateAvailable && (
              <button
                type="button"
                className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-accent/25 bg-accent/10 px-4 font-semibold text-accent"
                onClick={() => activatePwaUpdate()}
              >
                <Sparkles className="h-4 w-4" />
                {t('webui.updateNow', 'Update now')}
              </button>
            )}
            {onSignOut && (
              <button
                type="button"
                className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-destructive/25 bg-background/70 px-4 font-semibold text-destructive"
                disabled={signingOut}
                onClick={() => void signOut()}
              >
                {signingOut
                  ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                  : <LogOut className="h-4 w-4" aria-hidden="true" />}
                {t('webui.logOut')}
              </button>
            )}
            {signOutError && (
              <p className="rounded-xl border border-destructive/40 bg-destructive p-3 text-xs font-medium text-destructive-foreground" role="alert">
                {t('webui.logOutFailed')}
              </p>
            )}
          </div>
          </section>
        </div>
      )}

      {showInstallHelp && (
        <div
          className="pointer-events-auto fixed inset-0 bg-foreground/20"
          onPointerDown={() => setShowInstallHelp(false)}
        >
          <div
            ref={installHelpDialogRef}
            data-testid="remote-install-help"
            className="fixed left-3 right-3 top-[calc(62px+env(safe-area-inset-top))] mx-auto max-w-sm rounded-2xl border border-border/70 bg-card/95 p-4 text-sm text-foreground shadow-2xl backdrop-blur-xl sm:left-auto sm:right-3"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remote-install-help-title"
            tabIndex={-1}
            onPointerDown={(event) => event.stopPropagation()}
          >
          <button
            ref={installHelpCloseRef}
            type="button"
            className="absolute right-2 top-2 flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/5"
            onClick={() => setShowInstallHelp(false)}
            aria-label={t('webui.remoteInstallDismiss')}
          >
            <X className="h-4 w-4" />
          </button>
          <p id="remote-install-help-title" className="pr-10 font-semibold">{t('webui.remoteInstallTitle')}</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {isAppleMobileDevice()
              ? t('webui.remoteInstallIosInstructions')
              : t('webui.remoteInstallBrowserInstructions')}
          </p>
          </div>
        </div>
      )}
    </div>
  )
}
