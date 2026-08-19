import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, RefreshCw, Wifi, WifiOff, X } from 'lucide-react'
import type { WsRpcClient, TransportConnectionState } from '../../../electron/src/transport/client'
import {
  clearInstallPrompt,
  getInstallPrompt,
  isAppleMobileDevice,
  isRunningAsInstalledApp,
  subscribeToInstallPrompt,
  type BeforeInstallPromptEvent,
} from '../pwa-install'

export interface RemoteConnectionBadgeProps {
  client: WsRpcClient
  hostLabel: string
}

function statusTone(status: TransportConnectionState['status']): string {
  if (status === 'connected') return 'border-emerald-500/20 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
  if (status === 'failed' || status === 'disconnected') return 'border-destructive/20 bg-destructive/10 text-destructive'
  return 'border-amber-500/20 bg-amber-500/12 text-amber-700 dark:text-amber-300'
}

export function RemoteConnectionBadge({ client, hostLabel }: RemoteConnectionBadgeProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<TransportConnectionState>(() => client.getConnectionState())
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(() => getInstallPrompt())
  const [showInstallHelp, setShowInstallHelp] = useState(false)
  const [installed, setInstalled] = useState(() => isRunningAsInstalledApp())

  useEffect(() => client.onConnectionStateChanged(setState), [client])
  useEffect(() => subscribeToInstallPrompt(setInstallPrompt), [])
  useEffect(() => {
    const onInstalled = () => {
      setInstalled(true)
      setShowInstallHelp(false)
    }
    window.addEventListener('appinstalled', onInstalled)
    return () => window.removeEventListener('appinstalled', onInstalled)
  }, [])

  const connected = state.status === 'connected'
  const retrying = state.status === 'connecting' || state.status === 'reconnecting'
  const label = connected
    ? t('webui.remoteLive', 'Remote · {{host}}', { host: hostLabel })
    : retrying
      ? t('webui.remoteReconnecting', 'Reconnecting to {{host}}…', { host: hostLabel })
      : t('webui.remoteOffline', 'Remote offline')

  return (
    <div className="pointer-events-none fixed right-2 top-[calc(10px+env(safe-area-inset-top))] z-[100] flex items-center gap-1.5 sm:right-3">
      <button
        type="button"
        onClick={() => {
          if (!connected) client.reconnectNow()
        }}
        disabled={connected}
        className={`pointer-events-auto flex h-9 w-9 items-center justify-center rounded-xl border text-[11px] font-medium shadow-sm backdrop-blur-xl sm:w-auto sm:max-w-[240px] sm:gap-2 sm:px-3 ${statusTone(state.status)}`}
        aria-live="polite"
        aria-label={label}
        title={label}
      >
        {connected ? <Wifi className="h-4 w-4" /> : retrying ? <RefreshCw className="h-4 w-4 animate-spin" /> : <WifiOff className="h-4 w-4" />}
        <span className="hidden truncate sm:inline">{label}</span>
      </button>
      {!installed && (
        <button
          type="button"
          data-testid="remote-install-app"
          aria-label={t('webui.remoteInstall', 'Install')}
          title={t('webui.remoteInstall', 'Install')}
          className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-xl border border-accent/25 bg-accent text-[11px] font-semibold text-accent-foreground shadow-sm sm:w-auto sm:gap-1.5 sm:px-3"
          onClick={async () => {
            if (!installPrompt) {
              setShowInstallHelp(true)
              return
            }
            await installPrompt.prompt()
            const choice = await installPrompt.userChoice
            clearInstallPrompt()
            if (choice.outcome === 'accepted') setInstalled(true)
          }}
        >
          <Download className="h-4 w-4" />
          <span className="hidden sm:inline">{t('webui.remoteInstall', 'Install')}</span>
        </button>
      )}
      {showInstallHelp && (
        <div
          data-testid="remote-install-help"
          className="pointer-events-auto fixed left-3 right-3 top-[calc(56px+env(safe-area-inset-top))] mx-auto max-w-sm rounded-2xl border border-border/70 bg-card/95 p-4 text-sm text-foreground shadow-2xl backdrop-blur-xl sm:left-auto sm:right-3"
          role="dialog"
          aria-label={t('webui.remoteInstallTitle')}
        >
          <button
            type="button"
            className="absolute right-3 top-3 rounded-full p-1 text-muted-foreground hover:bg-foreground/5"
            onClick={() => setShowInstallHelp(false)}
            aria-label={t('webui.remoteInstallDismiss')}
          >
            <X className="h-4 w-4" />
          </button>
          <p className="pr-7 font-semibold">{t('webui.remoteInstallTitle')}</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {isAppleMobileDevice()
              ? t('webui.remoteInstallIosInstructions')
              : t('webui.remoteInstallBrowserInstructions')}
          </p>
        </div>
      )}
    </div>
  )
}
