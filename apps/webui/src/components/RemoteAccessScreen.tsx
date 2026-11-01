import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { Check, Copy, RefreshCw } from 'lucide-react';

import { type ScreenMode, type PairingDetails, isPairingDetails, getErrorMessage, formatRemainingTime, useOnlineStatus, RemoteShell, BrandHeader, OfflineNotice, PairDeviceScreen } from "./remote-pair-device";





function SetupRemoteScreen() {
  const { t } = useTranslation()
  const online = useOnlineStatus()
  const [details, setDetails] = useState<PairingDetails | null>(null)
  const [qrCodeUrl, setQrCodeUrl] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())

  const createPairing = useCallback(async () => {
    if (!navigator.onLine) {
      setLoading(false)
      setError(t('webui.remoteRequiresInternet', 'Pairing requires an internet connection to your Robb host.'))
      return
    }
    setLoading(true)
    setError('')
    setCopied(false)
    try {
      const response = await fetch('/api/remote/pairing', {
        method: 'POST',
        credentials: 'same-origin',
      })
      if (response.status === 401) {
        const next = encodeURIComponent('/remote/setup')
        window.location.replace(`/login?next=${next}`)
        return
      }
      const payload: unknown = await response.json().catch(() => null)
      if (!response.ok || !isPairingDetails(payload)) {
        throw new Error(getErrorMessage(payload, t('webui.remotePairingCreateFailed', 'Unable to create a pairing code.')))
      }
      const imageUrl = await QRCode.toDataURL(payload.pairingUrl, {
        width: 320,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#17151c', light: '#ffffff' },
      })
      setDetails(payload)
      setQrCodeUrl(imageUrl)
      setNow(Date.now())
    } catch (setupError) {
      setError(setupError instanceof Error ? setupError.message : String(setupError))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void createPairing()
  }, [createPairing])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const isExpired = details ? Date.parse(details.expiresAt) <= now : false

  return (
    <RemoteShell>
      <BrandHeader onBack={() => window.location.assign('/')} />
      <section className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-8" data-testid="remote-setup-screen">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{t('webui.remoteSetupTitle', 'Pair your phone')}</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-foreground/65">
            {t('webui.remoteSetupDescription', 'Scan this code with your phone. Robb Agents keeps running on this computer while you work remotely.')}
          </p>
        </div>

        {!online && <OfflineNotice />}

        <div className="rounded-[28px] border border-border/70 bg-card/85 p-5 shadow-2xl shadow-black/8 backdrop-blur-xl">
          {loading && (
            <div className="flex aspect-square items-center justify-center rounded-2xl bg-muted/50">
              <RefreshCw className="h-6 w-6 animate-spin text-accent" />
            </div>
          )}

          {!loading && details && qrCodeUrl && (
            <>
              <div className={`relative mx-auto aspect-square max-w-[280px] overflow-hidden rounded-2xl bg-white p-3 transition ${isExpired ? 'opacity-25 grayscale' : ''}`}>
                <img src={qrCodeUrl} alt={t('webui.remoteQrAlt', 'Remote pairing QR code')} className="h-full w-full" />
                {isExpired && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="rounded-full bg-background px-3 py-1.5 text-xs font-semibold text-foreground shadow-lg">
                      {t('webui.remoteExpired', 'Expired')}
                    </span>
                  </div>
                )}
              </div>

              <div className="mt-5 text-center">
                <p className="text-xs text-muted-foreground">{t('webui.remoteManualCode', 'Or enter this one-time code')}</p>
                <button
                  type="button"
                  disabled={isExpired}
                  onClick={async () => {
                    if (isExpired) return
                    await navigator.clipboard.writeText(details.code)
                    setCopied(true)
                    window.setTimeout(() => setCopied(false), 1_500)
                  }}
                  className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-background/70 px-4 py-2 font-mono text-lg font-semibold tracking-[0.18em] transition hover:border-accent/50 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {details.code}
                  {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4 text-muted-foreground" />}
                </button>
                <p className="mt-3 text-xs text-muted-foreground">
                  {isExpired
                    ? t('webui.remoteCodeExpired', 'This code has expired.')
                    : t('webui.remoteExpiresIn', 'Expires in {{time}}', { time: formatRemainingTime(details.expiresAt, now) })}
                </p>
              </div>
            </>
          )}

          {error && (
            <div role="alert" className="rounded-2xl border border-destructive/25 bg-destructive/8 p-4 text-sm text-destructive">
              {error}
            </div>
          )}

          {(error || isExpired) && (
            <button
              type="button"
              disabled={!online}
              onClick={() => void createPairing()}
              className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent text-sm font-semibold text-accent-foreground disabled:cursor-not-allowed disabled:opacity-45"
            >
              <RefreshCw className="h-4 w-4" />
              {t('webui.remoteNewCode', 'Generate a new code')}
            </button>
          )}
        </div>

        {details && !isExpired && (
          <div className="mt-5 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            {t('webui.remoteHostReady', '{{host}} is ready for Remote', { host: details.hostLabel })}
          </div>
        )}
      </section>
    </RemoteShell>
  )
}

export function RemoteAccessScreen({ mode }: { mode: ScreenMode }) {
  return mode === 'setup' ? <SetupRemoteScreen /> : <PairDeviceScreen />
}
