import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LogOut, RefreshCw, ServerOff, ShieldCheck, WifiOff } from 'lucide-react';

export type Phase = 'loading' | 'offline' | 'error' | 'ready'

export interface WebuiConfig {
  wsUrl: string
  hostLabel: string
  session: {
    kind: 'owner' | 'remote-device'
    deviceId: string | null
    expiresAt: string
  }
}

export function LoadingScreen() {
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

export function ConnectionScreen({
  kind,
  message,
  onRetry,
  onLogOut,
}: {
  kind: 'offline' | 'error'
  message: string
  onRetry: () => void
  onLogOut?: (() => Promise<void>) | undefined
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
