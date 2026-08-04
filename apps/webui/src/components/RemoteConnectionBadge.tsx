import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import type { WsRpcClient, TransportConnectionState } from '../../../electron/src/transport/client'

export interface RemoteConnectionBadgeProps {
  client: WsRpcClient
  hostLabel: string
}

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function statusTone(status: TransportConnectionState['status']): string {
  if (status === 'connected') return 'border-emerald-500/20 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
  if (status === 'failed' || status === 'disconnected') return 'border-destructive/20 bg-destructive/10 text-destructive'
  return 'border-amber-500/20 bg-amber-500/12 text-amber-700 dark:text-amber-300'
}

export function RemoteConnectionBadge({ client, hostLabel }: RemoteConnectionBadgeProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<TransportConnectionState>(() => client.getConnectionState())
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)

  useEffect(() => client.onConnectionStateChanged(setState), [client])
  useEffect(() => {
    const onInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as InstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onInstallPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onInstallPrompt)
  }, [])

  const connected = state.status === 'connected'
  const retrying = state.status === 'connecting' || state.status === 'reconnecting'
  const label = connected
    ? t('webui.remoteLive', 'Remote · {{host}}', { host: hostLabel })
    : retrying
      ? t('webui.remoteReconnecting', 'Reconnecting to {{host}}…', { host: hostLabel })
      : t('webui.remoteOffline', 'Remote offline')

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(8px+env(safe-area-inset-top))] z-[100] flex justify-center gap-2 px-3 md:hidden">
      <button
        type="button"
        onClick={() => {
          if (!connected) client.reconnectNow()
        }}
        disabled={connected}
        className={`pointer-events-auto flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium shadow-lg shadow-black/8 backdrop-blur-xl ${statusTone(state.status)}`}
        aria-live="polite"
      >
        {connected ? <Wifi className="h-3.5 w-3.5" /> : retrying ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <WifiOff className="h-3.5 w-3.5" />}
        <span className="truncate">{label}</span>
      </button>
      {installPrompt && (
        <button
          type="button"
          className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent px-3 py-1.5 text-[11px] font-semibold text-accent-foreground shadow-lg"
          onClick={async () => {
            await installPrompt.prompt()
            await installPrompt.userChoice
            setInstallPrompt(null)
          }}
        >
          <Download className="h-3.5 w-3.5" />
          {t('webui.remoteInstall', 'Install')}
        </button>
      )}
    </div>
  )
}
