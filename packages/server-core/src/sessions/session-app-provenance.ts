import type { PlatformServices } from '../runtime/platform'
import type {
  DispatchMode,
  SessionAppProvenance,
  SessionHeader,
} from '@craft-agent/shared/sessions'
import type { RoutingMeta } from '@craft-agent/core/types'

/** Build a compact, serializable session provenance record from the host runtime. */
export function getPlatformSessionAppProvenance(
  platform: PlatformServices | null,
): SessionAppProvenance | undefined {
  const appVersion = platform?.appVersion.trim()
  if (!platform || !appVersion) return undefined

  const buildCommit = platform.buildCommit?.trim() || undefined
  const buildChannel = platform.buildChannel?.trim() || undefined
  return {
    appVersion,
    ...(buildCommit ? { buildCommit } : {}),
    ...(buildChannel ? { buildChannel } : {}),
    ...(platform.buildDirty !== undefined ? { buildDirty: platform.buildDirty } : {}),
    isPackaged: platform.isPackaged,
  }
}

/** Flatten session build provenance onto per-response routing audit metadata. */
export function toRoutingMetaAppProvenance(
  provenance: SessionAppProvenance | undefined,
): Pick<RoutingMeta, 'appVersion' | 'buildCommit' | 'buildChannel' | 'buildDirty' | 'isPackaged'> {
  if (!provenance) return {}
  return {
    appVersion: provenance.appVersion,
    ...(provenance.buildCommit ? { buildCommit: provenance.buildCommit } : {}),
    ...(provenance.buildChannel ? { buildChannel: provenance.buildChannel } : {}),
    ...(provenance.buildDirty !== undefined ? { buildDirty: provenance.buildDirty } : {}),
    isPackaged: provenance.isPackaged,
  }
}

/**
 * A move keeps the original session identity; a fork creates a new identity on
 * this host. In both cases, the importing build becomes the last user.
 */
export function resolveImportedSessionAppProvenance(
  mode: DispatchMode,
  sourceHeader: Pick<SessionHeader, 'createdByApp' | 'lastUsedByApp'>,
  currentApp: SessionAppProvenance | undefined,
): Pick<SessionHeader, 'createdByApp' | 'lastUsedByApp'> {
  return {
    createdByApp: mode === 'fork'
      ? (currentApp ?? sourceHeader.createdByApp)
      : sourceHeader.createdByApp,
    lastUsedByApp: currentApp ?? sourceHeader.lastUsedByApp,
  }
}
