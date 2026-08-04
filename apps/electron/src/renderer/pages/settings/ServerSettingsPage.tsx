/**
 * ServerSettingsPage
 *
 * Configure the Electron app to act as a remote server,
 * accessible from other machines on the network.
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Eye, EyeOff, AlertTriangle, RotateCw, ShieldCheck, Smartphone, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { QRCodeSVG } from 'qrcode.react'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Spinner } from '@craft-agent/ui'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { ServerConfig, ServerStatus } from '@craft-agent/shared/config/server-config'
import type { RemoteDeviceInfo, RemotePairingDetails } from '@craft-agent/shared/config/server-config'

import {
  SettingsSection,
  SettingsCard,
  SettingsCardFooter,
  SettingsRow,
  SettingsToggle,
  SettingsInputRow,
} from '@/components/settings'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'server',
}

interface ServerFormState {
  enabled: boolean
  port: string
  tlsCertPath: string
  tlsKeyPath: string
  token: string
}

function configToForm(config: ServerConfig): ServerFormState {
  return {
    enabled: config.enabled,
    port: String(config.port),
    tlsCertPath: config.tlsCertPath ?? '',
    tlsKeyPath: config.tlsKeyPath ?? '',
    token: config.token ?? '',
  }
}

function formToConfig(form: ServerFormState): ServerConfig {
  return {
    enabled: form.enabled,
    port: parseInt(form.port, 10) || 9100,
    tlsCertPath: form.tlsCertPath.trim() || undefined,
    tlsKeyPath: form.tlsKeyPath.trim() || undefined,
    token: form.token || undefined,
  }
}

export default function ServerSettingsPage() {
  const { t } = useTranslation()

  const [form, setForm] = useState<ServerFormState>({
    enabled: false,
    port: '9100',
    tlsCertPath: '',
    tlsKeyPath: '',
    token: '',
  })
  const [savedForm, setSavedForm] = useState<ServerFormState>(form)
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [tokenVisible, setTokenVisible] = useState(false)
  const [error, setError] = useState<string>()
  const [pairing, setPairing] = useState<RemotePairingDetails | null>(null)
  const [remoteDevices, setRemoteDevices] = useState<RemoteDeviceInfo[]>([])
  const [isCreatingPairing, setIsCreatingPairing] = useState(false)

  const isDirty = JSON.stringify(form) !== JSON.stringify(savedForm)

  const loadSettings = useCallback(async () => {
    try {
      const [config, serverStatus] = await Promise.all([
        window.electronAPI.getServerConfig(),
        window.electronAPI.getServerStatus(),
      ])
      const formState = configToForm(config)
      setForm(formState)
      setSavedForm(formState)
      setStatus(serverStatus)
      if (serverStatus.webUrl) {
        setRemoteDevices(await window.electronAPI.listRemoteDevices())
      }
    } catch (err) {
      console.error('Failed to load server settings:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  const handleSave = async () => {
    setError(undefined)
    const port = parseInt(form.port, 10)
    if (isNaN(port) || port < 1024 || port > 65535) {
      setError(t('settings.server.portValidation'))
      return
    }
    if (form.tlsCertPath && !form.tlsKeyPath) {
      setError(t('settings.server.privateKeyRequired'))
      return
    }
    if (form.tlsKeyPath && !form.tlsCertPath) {
      setError(t('settings.server.certificateRequired'))
      return
    }

    setIsSaving(true)
    try {
      await window.electronAPI.setServerConfig(formToConfig(form))
      setSavedForm(form)
      const newStatus = await window.electronAPI.getServerStatus()
      setStatus(newStatus)
      toast.success(t('settings.server.saved'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      toast.error(t('settings.server.failedToSave', { message: msg }))
    } finally {
      setIsSaving(false)
    }
  }

  const handleReset = () => {
    setForm(savedForm)
    setError(undefined)
  }

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    toast.success(t('settings.server.copiedToClipboard', { label }))
  }

  const handleBrowseCert = async () => {
    const paths = await window.electronAPI.openFileDialog()
    if (paths.length > 0) {
      setForm(f => ({ ...f, tlsCertPath: paths[0]! }))
    }
  }

  const handleBrowseKey = async () => {
    const paths = await window.electronAPI.openFileDialog()
    if (paths.length > 0) {
      setForm(f => ({ ...f, tlsKeyPath: paths[0]! }))
    }
  }

  const handleCreatePairing = async () => {
    setIsCreatingPairing(true)
    setError(undefined)
    try {
      setPairing(await window.electronAPI.createRemotePairing())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(t('settings.server.mobilePairingFailed'))
    } finally {
      setIsCreatingPairing(false)
    }
  }

  const handleRevokeDevice = async (deviceId: string) => {
    if (!await window.electronAPI.revokeRemoteDevice(deviceId)) return
    setRemoteDevices((devices) => devices.map((device) => (
      device.id === deviceId ? { ...device, revokedAt: new Date().toISOString() } : device
    )))
    toast.success(t('settings.server.mobileDeviceRevoked'))
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    )
  }

  const hasTls = !!(form.tlsCertPath && form.tlsKeyPath)
  const needsRestart = status?.needsRestart ?? false
  const showServerDetails = form.enabled || savedForm.enabled

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title={t("settings.server.title")} />
      <ScrollArea className="flex-1">
        <div className="px-5 py-7 max-w-3xl mx-auto space-y-5">

          {/* Enable toggle + restart banner */}
          <SettingsSection title={t("settings.server.remoteAccess")}>
            <SettingsCard>
              <SettingsToggle
                label={t("settings.server.enableServerMode")}
                description={t("settings.server.allowRemoteConnections")}
                checked={form.enabled}
                onCheckedChange={(enabled) => setForm(f => ({ ...f, enabled }))}
              />
            </SettingsCard>

            {needsRestart && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-warning/10 border border-warning/20 text-xs text-warning">
                <RotateCw className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1">{t("settings.server.restartRequired")}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-[11px] px-2"
                  onClick={() => window.electronAPI.relaunchApp()}
                >
                  {t("settings.server.restartNow")}
                </Button>
              </div>
            )}
          </SettingsSection>

          {/* Connection + TLS — only visible when server mode is relevant */}
          {showServerDetails && (
            <SettingsSection title={t("settings.server.connectionSection")}>
              <SettingsCard>
                <SettingsInputRow
                  label={t("settings.server.port")}
                  value={form.port}
                  onChange={(port) => setForm(f => ({ ...f, port }))}
                  placeholder="9100"
                />

                {status && form.enabled && (
                  <>
                    <SettingsRow label={t("common.url")}>
                      <div className="flex items-center gap-1.5">
                        <code className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded">
                          {status.url}
                        </code>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => handleCopy(status.url, 'URL')}>
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </SettingsRow>

                    <SettingsRow label={t("settings.server.token")}>
                      <div className="flex items-center gap-1.5">
                        <code className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded max-w-[180px] truncate">
                          {tokenVisible ? status.token : '••••••••••••••••'}
                        </code>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setTokenVisible(v => !v)}>
                          {tokenVisible ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => handleCopy(status.token, 'Token')}>
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </SettingsRow>
                  </>
                )}

                <SettingsRow label={t("settings.server.certificate")}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                      {form.tlsCertPath || 'Not configured'}
                    </span>
                    <Button variant="outline" size="sm" className="h-6 text-[11px] px-2 shrink-0" onClick={handleBrowseCert}>
                      Browse
                    </Button>
                  </div>
                </SettingsRow>

                <SettingsRow label={t("settings.server.privateKey")}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                      {form.tlsKeyPath || 'Not configured'}
                    </span>
                    <Button variant="outline" size="sm" className="h-6 text-[11px] px-2 shrink-0" onClick={handleBrowseKey}>
                      Browse
                    </Button>
                  </div>
                </SettingsRow>
              </SettingsCard>

              {form.enabled && !hasTls && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-warning/10 border border-warning/20 text-xs text-warning">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>
                    {status?.insecureWarning
                      ? t("settings.server.insecureWarning")
                      : t("settings.server.noTlsWarning")}
                  </span>
                </div>
              )}
            </SettingsSection>
          )}

          {status?.webUrl && form.enabled && !needsRestart && (
            <SettingsSection title={t("settings.server.mobileApp")}>
              <SettingsCard>
                <div className="p-5" data-testid="remote-mobile-setup">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent">
                        <Smartphone className="h-5 w-5" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{t("settings.server.mobilePairTitle")}</p>
                        <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                          {t("settings.server.mobilePairDescription")}
                        </p>
                      </div>
                    </div>
                    {!pairing && (
                      <Button size="sm" onClick={handleCreatePairing} disabled={isCreatingPairing}>
                        {isCreatingPairing ? <Spinner className="mr-1.5" /> : null}
                        {t("settings.server.mobileGenerateQr")}
                      </Button>
                    )}
                  </div>

                  {pairing && (
                    <div className="mt-5 grid gap-5 rounded-2xl border border-border/70 bg-muted/20 p-5 sm:grid-cols-[184px_1fr]" data-testid="remote-pairing-qr">
                      <div className="rounded-2xl bg-white p-3 shadow-sm">
                        <QRCodeSVG value={pairing.pairingUrl} size={160} level="M" title={t("settings.server.mobileQrAlt")} />
                      </div>
                      <div className="flex min-w-0 flex-col justify-center">
                        <div className="flex items-center gap-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                          <ShieldCheck className="h-4 w-4" />
                          {t("settings.server.mobileSecureTicket")}
                        </div>
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">
                          {t("settings.server.mobileInstallHint")}
                        </p>
                        <button
                          type="button"
                          className="mt-3 w-fit rounded-lg border border-border bg-background px-3 py-1.5 font-mono text-sm font-semibold tracking-[0.12em]"
                          onClick={() => handleCopy(pairing.code, t("settings.server.mobilePairCode"))}
                        >
                          {pairing.code}
                        </button>
                        <Button variant="ghost" size="sm" className="mt-3 w-fit" onClick={handleCreatePairing} disabled={isCreatingPairing}>
                          <RotateCw className="mr-1.5 h-3.5 w-3.5" />
                          {t("settings.server.mobileNewQr")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                {remoteDevices.filter((device) => !device.revokedAt && Date.parse(device.expiresAt) > Date.now()).map((device) => (
                  <SettingsRow key={device.id} label={device.name}>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{t("settings.server.mobilePairedDevice")}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-destructive"
                        onClick={() => handleRevokeDevice(device.id)}
                        aria-label={t("settings.server.mobileRevokeDevice", { name: device.name })}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </SettingsRow>
                ))}
              </SettingsCard>
            </SettingsSection>
          )}

          {/* Save/Reset */}
          {error && (
            <p className="text-xs text-destructive px-1">{error}</p>
          )}
          {(isDirty || error) && (
            <SettingsCardFooter>
              <Button variant="outline" size="sm" onClick={handleReset} disabled={isSaving}>
                Reset
              </Button>
              <Button size="sm" onClick={handleSave} disabled={isSaving}>
                {isSaving ? <Spinner className="mr-1.5" /> : null}
                Save
              </Button>
            </SettingsCardFooter>
          )}

        </div>
      </ScrollArea>
    </div>
  )
}
