/**
 * MobileAccessSettingsPage
 *
 * Exposes the first-party Robb Agents web app as the only remote messaging
 * surface. Pairing uses the server's short-lived, single-use ticket flow so
 * the long-lived server token is never embedded in a QR code or shared link.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  MonitorSmartphone,
  RotateCw,
  ShieldCheck,
  Smartphone,
  Trash2,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { toast } from 'sonner'
import { Spinner } from '@craft-agent/ui'
import type {
  RemoteDeviceInfo,
  RemotePairingDetails,
  ServerConfig,
  ServerStatus,
} from '@craft-agent/shared/config/server-config'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { SettingsCard, SettingsSection, SettingsToggle } from '@/components/settings'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { navigate, routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import {
  getActiveRemoteDevices,
  hasNewActiveRemoteDevice,
} from '@/utils/remote-devices'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'messaging',
}

export default function MessagingSettingsPage() {
  const { t, i18n } = useTranslation()
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [pairing, setPairing] = useState<RemotePairingDetails | null>(null)
  const [remoteDevices, setRemoteDevices] = useState<RemoteDeviceInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isCreatingPairing, setIsCreatingPairing] = useState(false)
  const [isRefreshingDevices, setIsRefreshingDevices] = useState(false)
  const [error, setError] = useState<string>()
  const pairingKnownDeviceIdsRef = useRef<Set<string>>(new Set())

  const loadRemoteDevices = useCallback(async (
    serverStatus: ServerStatus,
    silent = false,
  ): Promise<RemoteDeviceInfo[] | null> => {
    if (!serverStatus.webUrl || serverStatus.needsRestart) {
      setRemoteDevices([])
      return []
    }
    try {
      const devices = await window.electronAPI.listRemoteDevices()
      setRemoteDevices(devices)
      return devices
    } catch (err) {
      if (!silent) throw err
      return null
    }
  }, [])

  const loadSettings = useCallback(async () => {
    setError(undefined)
    try {
      const [serverConfig, serverStatus] = await Promise.all([
        window.electronAPI.getServerConfig(),
        window.electronAPI.getServerStatus(),
      ])
      setConfig(serverConfig)
      setStatus(serverStatus)
      if (serverConfig.enabled) await loadRemoteDevices(serverStatus)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }, [loadRemoteDevices])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  useEffect(() => {
    if (!config?.enabled || !status?.webUrl || status.needsRestart) return

    const timer = window.setInterval(() => {
      void loadRemoteDevices(status, true)
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [config?.enabled, loadRemoteDevices, status])

  useEffect(() => {
    if (!pairing || !hasNewActiveRemoteDevice(remoteDevices, pairingKnownDeviceIdsRef.current)) return
    setPairing(null)
    toast.success(t('settings.server.deviceConnected'))
  }, [pairing, remoteDevices, t])

  const handleEnabledChange = async (enabled: boolean) => {
    if (!config) return
    setIsSaving(true)
    setError(undefined)
    try {
      const nextConfig = { ...config, enabled }
      await window.electronAPI.setServerConfig(nextConfig)
      const nextStatus = await window.electronAPI.getServerStatus()
      setConfig(nextConfig)
      setStatus(nextStatus)
      setPairing(null)
      if (enabled) await loadRemoteDevices(nextStatus)
      else setRemoteDevices([])
      toast.success(t('settings.server.saved'))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(t('settings.server.failedToSave', { message }))
    } finally {
      setIsSaving(false)
    }
  }

  const handleCreatePairing = async () => {
    setIsCreatingPairing(true)
    setError(undefined)
    try {
      pairingKnownDeviceIdsRef.current = new Set(
        getActiveRemoteDevices(remoteDevices).map((device) => device.id),
      )
      const nextPairing = await window.electronAPI.createRemotePairing()
      setPairing(nextPairing)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(t('settings.server.mobilePairingFailed'))
    } finally {
      setIsCreatingPairing(false)
    }
  }

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t('settings.server.copiedToClipboard', { label }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRevokeDevice = async (deviceId: string) => {
    setError(undefined)
    try {
      if (!await window.electronAPI.revokeRemoteDevice(deviceId)) {
        if (status) await loadRemoteDevices(status, true)
        return
      }
      setRemoteDevices((devices) => devices.map((device) => (
        device.id === deviceId ? { ...device, revokedAt: new Date().toISOString() } : device
      )))
      toast.success(t('settings.server.mobileDeviceRevoked'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRefreshDevices = async () => {
    if (!status) return
    setIsRefreshingDevices(true)
    setError(undefined)
    try {
      await loadRemoteDevices(status)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsRefreshingDevices(false)
    }
  }

  const activeDevices = useMemo(
    () => getActiveRemoteDevices(remoteDevices),
    [remoteDevices],
  )
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(
    i18n.resolvedLanguage || undefined,
    { dateStyle: 'medium', timeStyle: 'short' },
  ), [i18n.resolvedLanguage])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }

  const enabled = config?.enabled ?? false
  const needsRestart = status?.needsRestart ?? false
  const serverReady = enabled && !needsRestart && Boolean(status?.webUrl)
  const canPairSecurely = serverReady && status?.tls === true

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={t('settings.messaging.title')} />
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-3xl space-y-5 px-5 py-7">
          <SettingsSection
            title={t('settings.messaging.webApp.section')}
            description={t('settings.messaging.description')}
          >
            <SettingsCard>
              <SettingsToggle
                label={t('settings.messaging.webApp.enable')}
                description={t('settings.messaging.webApp.enableDescription')}
                checked={enabled}
                onCheckedChange={(next) => void handleEnabledChange(next)}
                disabled={isSaving || !config}
              />
            </SettingsCard>

            {needsRestart && (
              <div className="flex items-center gap-2 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
                <RotateCw className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1">{t('settings.server.restartRequired')}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => window.electronAPI.relaunchApp()}
                >
                  {t('settings.server.restartNow')}
                </Button>
              </div>
            )}

            {serverReady && (
              <SettingsCard>
                <div className="p-5" data-testid="remote-mobile-setup">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent">
                        <Smartphone className="h-5 w-5" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{t('settings.server.mobilePairTitle')}</p>
                        <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                          {t('settings.server.mobilePairDescription')}
                        </p>
                      </div>
                    </div>
                    {!pairing && (
                      <Button
                        size="sm"
                        onClick={handleCreatePairing}
                        disabled={isCreatingPairing || !canPairSecurely}
                      >
                        {isCreatingPairing ? <Spinner className="mr-1.5" /> : null}
                        {t('settings.server.mobileGenerateQr')}
                      </Button>
                    )}
                  </div>

                  {pairing && (
                    <div
                      className="mt-5 grid gap-5 rounded-2xl border border-border/70 bg-muted/20 p-5 sm:grid-cols-[184px_1fr]"
                      data-testid="remote-pairing-qr"
                    >
                      <div className="rounded-2xl bg-white p-3 shadow-xs">
                        <QRCodeSVG
                          value={pairing.pairingUrl}
                          size={160}
                          level="M"
                          title={t('settings.server.mobileQrAlt')}
                        />
                      </div>
                      <div className="flex min-w-0 flex-col justify-center">
                        <div className="flex items-center gap-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                          <ShieldCheck className="h-4 w-4" />
                          {t('settings.server.mobileSecureTicket')}
                        </div>
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">
                          {t('settings.server.mobileInstallHint')}
                        </p>
                        <button
                          type="button"
                          className="mt-3 w-fit rounded-lg border border-border bg-background px-3 py-1.5 font-mono text-sm font-semibold tracking-[0.12em]"
                          onClick={() => void handleCopy(pairing.code, t('settings.server.mobilePairCode'))}
                        >
                          {pairing.code}
                        </button>
                        <div className="mt-3 rounded-lg border border-border/70 bg-background p-2.5">
                          <div className="text-[11px] font-medium text-muted-foreground">
                            {t('settings.messaging.webApp.link')}
                          </div>
                          <div className="mt-1 break-all font-mono text-[11px] text-foreground/80">
                            {pairing.pairingUrl}
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleCopy(pairing.pairingUrl, t('settings.messaging.webApp.link'))}
                          >
                            <Copy className="h-3.5 w-3.5" />
                            {t('common.copy')}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => window.electronAPI.openUrl(pairing.pairingUrl)}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            {t('common.openLink')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleCreatePairing}
                            disabled={isCreatingPairing}
                          >
                            <RotateCw className="h-3.5 w-3.5" />
                            {t('settings.server.mobileNewQr')}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="border-t border-border/70 p-5" data-testid="remote-device-management">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                        <MonitorSmartphone className="h-4.5 w-4.5" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{t('settings.server.devicesTitle')}</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {t('settings.server.devicesDescription')}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="rounded-full bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground">
                        {t('settings.server.devicesCount', { count: activeDevices.length })}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => void handleRefreshDevices()}
                        disabled={isRefreshingDevices}
                        aria-label={t('common.refresh')}
                      >
                        <RotateCw className={`h-3.5 w-3.5 ${isRefreshingDevices ? 'animate-spin' : ''}`} />
                      </Button>
                    </div>
                  </div>

                  {activeDevices.length === 0 ? (
                    <div className="mt-4 rounded-xl border border-dashed border-border px-4 py-5 text-center text-xs text-muted-foreground">
                      {t('settings.server.devicesEmpty')}
                    </div>
                  ) : (
                    <div className="mt-4 divide-y divide-border/70 overflow-hidden rounded-xl border border-border/70" data-testid="remote-device-list">
                      {activeDevices.map((device) => (
                        <div key={device.id} className="flex items-center gap-3 bg-background px-3 py-3">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                            <MonitorSmartphone className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="truncate text-sm font-medium">{device.name}</p>
                              <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                                {t('settings.server.deviceActive')}
                              </span>
                            </div>
                            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                              {t('settings.server.devicePairedAt', { date: dateFormatter.format(new Date(device.pairedAt)) })}
                              <span aria-hidden="true"> · </span>
                              {t('settings.server.deviceExpiresAt', { date: dateFormatter.format(new Date(device.expiresAt)) })}
                              <span aria-hidden="true"> · </span>
                              {t('settings.server.deviceWorkspaces', { count: device.allowedWorkspaceIds.length })}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 shrink-0 px-2 text-destructive"
                            onClick={() => void handleRevokeDevice(device.id)}
                            aria-label={t('settings.server.mobileRevokeDevice', { name: device.name })}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">{t('common.disconnect')}</span>
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </SettingsCard>
            )}

            {serverReady && !canPairSecurely && (
              <div className="flex items-start gap-3 rounded-lg border border-warning/20 bg-warning/10 px-3 py-3 text-xs text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{t('settings.messaging.webApp.tlsRequired')}</p>
                  <p className="mt-1 leading-5">{t('settings.messaging.webApp.tlsRequiredDescription')}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-[11px]"
                  onClick={() => navigate(routes.view.settings('server'))}
                >
                  {t('settings.messaging.webApp.configureTls')}
                </Button>
              </div>
            )}
          </SettingsSection>

          {error && <p className="px-1 text-xs text-destructive">{error}</p>}
        </div>
      </ScrollArea>
    </div>
  )
}
