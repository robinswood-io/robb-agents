import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'
import {
  ArrowLeft,
  Check,
  Copy,
  KeyRound,
  Laptop,
  Link2,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  WifiOff,
} from 'lucide-react'

type ScreenMode = 'pair' | 'setup'
type PairingPhase = 'idle' | 'connecting' | 'success' | 'error'

interface PairingDetails {
  pairingUrl: string
  code: string
  expiresAt: string
  hostLabel: string
}

interface PairingResult {
  ok: true
  deviceId: string
  hostLabel: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPairingDetails(value: unknown): value is PairingDetails {
  return isRecord(value)
    && typeof value.pairingUrl === 'string'
    && typeof value.code === 'string'
    && typeof value.expiresAt === 'string'
    && typeof value.hostLabel === 'string'
}

function isPairingResult(value: unknown): value is PairingResult {
  return isRecord(value)
    && value.ok === true
    && typeof value.deviceId === 'string'
    && typeof value.hostLabel === 'string'
}

function getErrorMessage(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.error === 'string' ? value.error : fallback
}

function inferDeviceName(): string {
  const userAgent = navigator.userAgent
  if (/iPhone/i.test(userAgent)) return 'iPhone'
  if (/iPad/i.test(userAgent)) return 'iPad'
  if (/Android/i.test(userAgent)) return 'Android device'
  return 'Mobile browser'
}

function formatRemainingTime(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000))
  const minutes = Math.floor(seconds / 60)
  const remainder = String(seconds % 60).padStart(2, '0')
  return `${minutes}:${remainder}`
}

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const handleOnline = () => setOnline(true)
    const handleOffline = () => setOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])
  return online
}

function useVisualViewportHeight(): number | null {
  const [height, setHeight] = useState<number | null>(() => window.visualViewport?.height ?? null)
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const update = () => setHeight(viewport.height)
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [])
  return height
}

function readAndScrubPairingCredentials(): { ticket?: string; code: string } {
  const searchParams = new URLSearchParams(window.location.search)
  const fragmentParams = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const ticket = fragmentParams.get('pairing') ?? searchParams.get('pairing') ?? undefined
  const code = fragmentParams.get('code') ?? searchParams.get('code') ?? ''

  if (ticket || code) {
    // Fragments never reach the HTTP server. Remove both new fragment-based
    // secrets and legacy query-string credentials before the exchange so they
    // do not remain visible in browser history, screenshots, or copied URLs.
    searchParams.delete('pairing')
    searchParams.delete('code')
    const remainingSearch = searchParams.toString()
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${remainingSearch ? `?${remainingSearch}` : ''}`,
    )
  }

  return { ticket, code }
}

function RemoteShell({ children }: { children: React.ReactNode }) {
  const visualViewportHeight = useVisualViewportHeight()
  return (
    <main
      className="remote-access-page h-[100dvh] min-h-0 w-full overflow-y-auto overscroll-y-contain bg-background text-foreground"
      style={visualViewportHeight ? { height: `${visualViewportHeight}px` } : undefined}
    >
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -left-24 -top-20 h-72 w-72 rounded-full bg-accent/15 blur-3xl" />
        <div className="absolute -right-24 top-1/3 h-80 w-80 rounded-full bg-primary/10 blur-3xl" />
      </div>
      <div className="relative mx-auto flex min-h-full w-full max-w-5xl flex-col px-5 pb-[calc(24px+env(safe-area-inset-bottom))] pt-[calc(16px+env(safe-area-inset-top))] sm:px-7 lg:px-10">
        {children}
      </div>
    </main>
  )
}

function BrandHeader({ onBack }: { onBack?: () => void }) {
  const { t } = useTranslation()
  return (
    <header className="flex items-center justify-between py-2">
      <button
        type="button"
        onClick={onBack}
        className={`flex h-11 w-11 items-center justify-center rounded-full border border-border/70 bg-card/80 text-foreground/70 shadow-sm backdrop-blur ${onBack ? '' : 'invisible'}`}
        aria-label={t('common.back', 'Back')}
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <div className="flex items-center gap-2 text-sm font-semibold tracking-tight">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-accent-foreground shadow-sm">
          <Link2 className="h-4 w-4" />
        </div>
        Robb Agents Remote
      </div>
      <div className="h-11 w-11" />
    </header>
  )
}

function TrustGrid({ className = '' }: { className?: string }) {
  const { t } = useTranslation()
  return (
    <div className={`grid grid-cols-2 gap-3 text-xs text-foreground/70 ${className}`}>
      <div className="rounded-2xl border border-border/70 bg-card/65 p-3.5">
        <ShieldCheck className="mb-2 h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        {t('webui.remoteEncrypted', 'Encrypted connection')}
      </div>
      <div className="rounded-2xl border border-border/70 bg-card/65 p-3.5">
        <Laptop className="mb-2 h-4 w-4 text-accent" />
        {t('webui.remoteHostOnline', 'Host stays in control')}
      </div>
    </div>
  )
}

function OfflineNotice() {
  const { t } = useTranslation()
  return (
    <div className="mb-4 flex items-start gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200" role="status">
      <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{t('webui.remoteRequiresInternet', 'Pairing requires an internet connection to your Robb host.')}</span>
    </div>
  )
}

function PairDeviceScreen() {
  const { t } = useTranslation()
  const online = useOnlineStatus()
  const initialCredentials = useMemo(readAndScrubPairingCredentials, [])
  const ticket = initialCredentials.ticket
  const [code, setCode] = useState(initialCredentials.code)
  const [phase, setPhase] = useState<PairingPhase>(ticket && navigator.onLine ? 'connecting' : 'idle')
  const [error, setError] = useState('')
  const [hostLabel, setHostLabel] = useState('')
  const automaticPairingStarted = useRef(false)

  const pair = useCallback(async (credentials: { ticket?: string; code?: string }) => {
    if (!navigator.onLine) {
      setPhase('error')
      setError(t('webui.remoteRequiresInternet', 'Pairing requires an internet connection to your Robb host.'))
      return
    }
    setPhase('connecting')
    setError('')

    try {
      const response = await fetch('/api/remote/pair', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...credentials, deviceName: inferDeviceName() }),
      })
      const payload: unknown = await response.json().catch(() => null)
      if (!response.ok || !isPairingResult(payload)) {
        throw new Error(getErrorMessage(payload, t('webui.remotePairingFailed', 'Unable to pair this device.')))
      }

      setHostLabel(payload.hostLabel)
      setPhase('success')
      window.setTimeout(() => window.location.replace('/'), 1_800)
    } catch (pairingError) {
      if (!navigator.onLine) automaticPairingStarted.current = false
      setError(pairingError instanceof Error ? pairingError.message : String(pairingError))
      setPhase('error')
    }
  }, [t])

  useEffect(() => {
    if (!ticket || !online || automaticPairingStarted.current) return
    automaticPairingStarted.current = true
    void pair({ ticket })
  }, [online, pair, ticket])

  const formattedCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  const canSubmit = online && formattedCode.length === 8 && phase !== 'connecting'

  if (phase === 'success') {
    return (
      <RemoteShell>
        <BrandHeader />
        <section className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center pb-16 text-center" data-testid="remote-pairing-success" role="status" aria-live="polite">
          <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-[28px] bg-emerald-500/12 text-emerald-500 ring-1 ring-emerald-500/20">
            <Check className="h-9 w-9" strokeWidth={2.2} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('webui.remoteConnected', 'Remote connected')}</h1>
          <p className="mt-3 max-w-xs text-sm leading-6 text-muted-foreground">
            {t('webui.remoteConnectedTo', 'This device is securely paired with {{host}}.', { host: hostLabel })}
          </p>
          <div className="mt-7 flex items-center gap-2 rounded-full border border-border/70 bg-card/80 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
            {t('webui.remoteFilesStayLocal', 'Files and credentials stay on the host')}
          </div>
        </section>
      </RemoteShell>
    )
  }

  return (
    <RemoteShell>
      <BrandHeader onBack={() => window.location.assign('/login')} />
      <section className="remote-pairing-content flex flex-1 flex-col justify-center md:grid md:grid-cols-[minmax(0,1fr)_minmax(340px,420px)] md:items-center md:gap-12 lg:gap-16" data-testid="remote-pairing-screen">
        <div>
          <div className="mb-7 md:mb-8">
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/12 text-accent ring-1 ring-accent/15">
              <Smartphone className="h-6 w-6" />
            </div>
            <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.025em]">
              {t('webui.remotePairTitle', 'Connect to your Robb host')}
            </h1>
            <p className="mt-3 max-w-md text-sm leading-6 text-foreground/65">
              {ticket
                ? t('webui.remotePairAutomatic', 'Confirming the secure pairing from your QR code…')
                : t('webui.remotePairDescription', 'Scan the QR code shown by Robb Agents on your computer, or enter its one-time code.')}
            </p>
          </div>

          <TrustGrid className="hidden md:grid" />
        </div>

        <div className="w-full">
          {!online && <OfflineNotice />}

        {!ticket && (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (canSubmit) void pair({ code: formattedCode })
            }}
            className="rounded-3xl border border-border/70 bg-card/80 p-5 shadow-xl shadow-black/5 backdrop-blur-xl"
          >
            <label htmlFor="remote-pairing-code" className="mb-2 block text-xs font-medium text-foreground/65">
              {t('webui.remotePairCode', 'One-time pairing code')}
            </label>
            <div className="relative">
              <KeyRound className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                id="remote-pairing-code"
                value={formattedCode}
                onChange={(event) => setCode(event.target.value)}
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="one-time-code"
                spellCheck={false}
                placeholder="ABCD-EFGH"
                className="h-13 w-full rounded-xl border border-border bg-background/80 pl-10 pr-3 font-mono text-lg font-semibold tracking-[0.16em] outline-none transition placeholder:text-foreground/45 focus:border-accent focus:ring-4 focus:ring-accent/10"
                aria-describedby={error ? 'remote-pairing-error' : undefined}
              />
            </div>
            <button
              type="submit"
              disabled={!canSubmit}
              className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-foreground shadow-lg shadow-accent/20 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {phase === 'connecting' && <RefreshCw className="h-4 w-4 animate-spin" />}
              {phase === 'connecting'
                ? t('webui.remoteConnecting', 'Connecting…')
                : t('webui.remoteConnect', 'Connect securely')}
            </button>
          </form>
        )}

        {ticket && phase === 'connecting' && (
          <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card/80 p-4 text-sm text-foreground/65 shadow-sm backdrop-blur" role="status" aria-live="polite">
            <RefreshCw className="h-5 w-5 animate-spin text-accent" />
            {t('webui.remoteVerifyingHost', 'Verifying your Robb host…')}
          </div>
        )}

        {phase === 'error' && (
          <div id="remote-pairing-error" role="alert" className="mt-4 rounded-2xl border border-destructive/25 bg-destructive/8 p-4 text-sm text-destructive">
            <p className="font-medium">{t('webui.remotePairingExpiredTitle', 'Pairing could not be completed')}</p>
            <p className="mt-1 text-xs leading-5 opacity-80">{error}</p>
            {ticket && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!online}
                  onClick={() => void pair({ ticket })}
                  className="inline-flex min-h-11 items-center rounded-xl bg-destructive px-4 text-xs font-semibold text-destructive-foreground disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {t('common.retry')}
                </button>
                <button
                  type="button"
                  onClick={() => window.location.assign('/remote')}
                  className="inline-flex min-h-11 items-center rounded-xl px-4 text-xs font-semibold underline underline-offset-4"
                >
                  {t('webui.remoteEnterCodeInstead', 'Enter a code instead')}
                </button>
              </div>
            )}
          </div>
        )}

          <TrustGrid className="mt-6 md:hidden" />
        </div>
      </section>
    </RemoteShell>
  )
}

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
