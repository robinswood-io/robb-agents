import { BellDot, Check, Cpu, Fingerprint, FolderOpen, MemoryStick, Minus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CapabilitySupport, PwaCapabilities } from '../pwa-capabilities'

interface PwaCapabilitiesPanelProps {
  capabilities: PwaCapabilities | null
}

function supportTone(supported: CapabilitySupport): string {
  if (supported === 'available') return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
  if (supported === 'partial') return 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300'
  return 'border-border bg-muted text-muted-foreground'
}

function supportIcon(supported: CapabilitySupport) {
  if (supported === 'available') return <Check className="h-3.5 w-3.5" aria-hidden="true" />
  if (supported === 'partial') return <Minus className="h-3.5 w-3.5" aria-hidden="true" />
  return <X className="h-3.5 w-3.5" aria-hidden="true" />
}

function boolSupport(value: boolean): CapabilitySupport {
  return value ? 'available' : 'unavailable'
}

export function PwaCapabilitiesPanel({ capabilities }: PwaCapabilitiesPanelProps) {
  const { t } = useTranslation()
  const passkeySupport = capabilities?.webAuthn.platformAuthenticator === true
    ? 'available'
    : capabilities?.webAuthn.api
      ? 'partial'
      : 'unavailable'
  const rows = [
    {
      key: 'passkeys',
      icon: <Fingerprint className="h-4 w-4 text-accent" aria-hidden="true" />,
      label: t('webui.pwaCapabilityPasskeys', 'Passkeys'),
      support: passkeySupport,
    },
    {
      key: 'filesystem',
      icon: <FolderOpen className="h-4 w-4 text-accent" aria-hidden="true" />,
      label: t('webui.pwaCapabilityFiles', 'Local files'),
      support: capabilities?.fileSystemAccess.support ?? 'unavailable',
    },
    {
      key: 'badging',
      icon: <BellDot className="h-4 w-4 text-accent" aria-hidden="true" />,
      label: t('webui.pwaCapabilityBadging', 'App badge'),
      support: boolSupport(capabilities?.badging.api === true),
    },
    {
      key: 'webgpu',
      icon: <Cpu className="h-4 w-4 text-accent" aria-hidden="true" />,
      label: t('webui.pwaCapabilityWebGpu', 'WebGPU'),
      support: boolSupport(capabilities?.webGpu.api === true),
    },
    {
      key: 'wasm64',
      icon: <MemoryStick className="h-4 w-4 text-accent" aria-hidden="true" />,
      label: t('webui.pwaCapabilityWasm64', 'WASM 64-bit'),
      support: boolSupport(capabilities?.webAssembly.memory64 === true),
    },
  ] satisfies Array<{
    key: string
    icon: JSX.Element
    label: string
    support: CapabilitySupport
  }>

  return (
    <section aria-labelledby="pwa-capabilities-title">
      <p id="pwa-capabilities-title" className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
        {t('webui.pwaCapabilities', 'PWA capabilities')}
      </p>
      <div className="mt-2 grid gap-1.5">
        {rows.map((row) => (
          <div key={row.key} className="flex min-h-10 items-center justify-between gap-3 rounded-xl border border-border/70 bg-background/60 px-3 py-2">
            <span className="flex min-w-0 items-center gap-2 text-xs font-medium">
              {row.icon}
              <span className="truncate">{row.label}</span>
            </span>
            <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${supportTone(row.support)}`}>
              {supportIcon(row.support)}
              {row.support === 'available'
                ? t('webui.pwaCapabilityAvailable', 'Available')
                : row.support === 'partial'
                  ? t('webui.pwaCapabilityPartial', 'Partial')
                  : t('webui.pwaCapabilityUnavailable', 'Unavailable')}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
