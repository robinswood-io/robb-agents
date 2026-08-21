const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

export function resolveSecureRemoteHost(
  requestedHost: string,
  tlsAvailable: boolean,
): { host: string; networkBindRejected: boolean } {
  if (tlsAvailable || isLoopbackHost(requestedHost)) {
    return { host: requestedHost, networkBindRejected: false }
  }
  return { host: '127.0.0.1', networkBindRejected: true }
}

export interface RunningRemoteServerState {
  enabled: boolean
  host: string
  port: number
  tls: boolean
  tlsCertPath?: string
  tlsKeyPath?: string
  token: string
  publicWebuiUrl?: string
  publicWsUrl?: string
  tunnelProvider?: string
  remoteAuthMode?: string
}

export interface SavedRemoteServerState {
  enabled: boolean
  port: number
  tlsCertPath?: string
  tlsKeyPath?: string
  token?: string
  publicWebuiUrl?: string
  publicWsUrl?: string
  tunnelProvider?: string
  remoteAuthMode?: string
}

/** Resolve only browser-facing URLs; local bind details remain available separately. */
export function resolveRemoteServerUrls(
  running: RunningRemoteServerState,
  displayHost: string,
  webuiAvailable: boolean,
): { url: string; webUrl?: string } {
  const wsProtocol = running.tls ? 'wss' : 'ws'
  const webProtocol = running.tls ? 'https' : 'http'
  return {
    url: running.publicWsUrl ?? `${wsProtocol}://${displayHost}:${running.port}`,
    webUrl: webuiAvailable
      ? (running.publicWebuiUrl ?? `${webProtocol}://${displayHost}:${running.port}`)
      : undefined,
  }
}

/** Compare saved settings against the exact configuration captured at startup. */
export function remoteServerNeedsRestart(
  saved: SavedRemoteServerState,
  running: RunningRemoteServerState,
): boolean {
  if (saved.enabled !== running.enabled) return true
  if (!saved.enabled && !running.enabled) return false

  return saved.port !== running.port
    || (saved.tlsCertPath ?? '') !== (running.tlsCertPath ?? '')
    || (saved.tlsKeyPath ?? '') !== (running.tlsKeyPath ?? '')
    || (saved.token ?? '') !== running.token
    || comparablePublicUrl(saved.publicWebuiUrl) !== comparablePublicUrl(running.publicWebuiUrl)
    || comparablePublicUrl(saved.publicWsUrl) !== comparablePublicUrl(running.publicWsUrl)
    || (saved.tunnelProvider ?? 'manual') !== (running.tunnelProvider ?? 'manual')
    || (saved.remoteAuthMode ?? 'pairing-code') !== (running.remoteAuthMode ?? 'pairing-code')
}

function comparablePublicUrl(value: string | undefined): string {
  const raw = value?.trim()
  if (!raw) return ''
  try {
    return new URL(raw).toString()
  } catch {
    // Invalid persisted values are disabled during startup. Keep their raw
    // value distinct here so status continues to require a corrective restart.
    return raw
  }
}

/** Trust only the public HTTPS origin explicitly validated in ServerConfig. */
export function resolveAllowedSessionCookieOrigins(
  publicWebuiUrl: string | undefined,
): readonly string[] | undefined {
  return publicWebuiUrl ? [new URL(publicWebuiUrl).origin] : undefined
}
