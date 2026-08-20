/**
 * Server mode configuration — controls whether the Electron app
 * accepts remote connections from other machines.
 *
 * When enabled, the app binds to 0.0.0.0 on a fixed port instead of
 * localhost on a random port, allowing thin clients to connect.
 */

export interface ServerConfig {
  /** Whether remote server mode is active (bind 0.0.0.0 vs 127.0.0.1) */
  enabled: boolean
  /** Fixed port to listen on (default 9100) */
  port: number
  /** Path to PEM certificate file (enables TLS / wss://) */
  tlsCertPath?: string
  /** Path to PEM private key file (required when cert is set) */
  tlsKeyPath?: string
  /** Stable auth token for remote clients (auto-generated on first enable) */
  token?: string
  /** Browser-facing HTTPS URL when a trusted reverse proxy exposes the WebUI. */
  publicWebuiUrl?: string
  /** Browser-facing WSS URL when a trusted reverse proxy exposes RPC. */
  publicWsUrl?: string
}

export interface ServerStatus {
  /** Whether the server is currently running */
  running: boolean
  /** Current bind address */
  host: string
  /** Current port */
  port: number
  /** Whether the browser-facing Remote transport is protected by TLS. */
  tls: boolean
  /** Full connection URL (ws:// or wss://) */
  url: string
  /** Browser/PWA URL served on the same port when Remote is available. */
  webUrl?: string
  /** Current auth token */
  token: string
  /** Whether saved config differs from running config (restart needed) */
  needsRestart: boolean
  /** True when server is bound to a network address without TLS */
  insecureWarning: boolean
}

export interface RemotePairingDetails {
  pairingUrl: string
  code: string
  expiresAt: string
  hostLabel: string
}

export interface RemoteDeviceInfo {
  id: string
  name: string
  allowedWorkspaceIds: readonly string[]
  pairedAt: string
  expiresAt: string
  revokedAt?: string
}

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  enabled: false,
  port: 9100,
}

type PublicRemoteUrlKind = 'webui' | 'websocket'

function normalizePublicRemoteUrl(
  value: string | undefined,
  kind: PublicRemoteUrlKind,
): string | undefined {
  const raw = value?.trim()
  if (!raw) return undefined

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`Invalid public ${kind === 'webui' ? 'Web UI' : 'WebSocket'} URL`)
  }

  const expectedProtocol = kind === 'webui' ? 'https:' : 'wss:'
  if (parsed.protocol !== expectedProtocol) {
    throw new Error(
      `Public ${kind === 'webui' ? 'Web UI' : 'WebSocket'} URL must use ${expectedProtocol.slice(0, -1).toUpperCase()}`,
    )
  }
  if (parsed.username || parsed.password) {
    throw new Error('Public Remote URLs must not contain credentials')
  }
  // Reject even empty query/fragment delimiters. They are unnecessary for
  // routing and are the most likely place for a durable token to leak.
  if (raw.includes('?') || raw.includes('#')) {
    throw new Error('Public Remote URLs must not contain a query or fragment')
  }
  if (kind === 'webui' && parsed.pathname !== '/') {
    throw new Error('Public Web UI URL must not contain a path')
  }

  return parsed.toString()
}

/**
 * Validate and canonicalize the public reverse-proxy endpoints as one atomic
 * pair. Keeping the two values coupled prevents an HTTPS page from silently
 * falling back to an internal or plaintext WebSocket endpoint.
 */
export function normalizeServerConfigPublicUrls(config: ServerConfig): ServerConfig {
  const publicWebuiUrl = normalizePublicRemoteUrl(config.publicWebuiUrl, 'webui')
  const publicWsUrl = normalizePublicRemoteUrl(config.publicWsUrl, 'websocket')

  if (Boolean(publicWebuiUrl) !== Boolean(publicWsUrl)) {
    throw new Error('Public Web UI and WebSocket URLs must be configured together')
  }

  if (publicWebuiUrl && publicWsUrl) {
    const webuiHostname = new URL(publicWebuiUrl).hostname
    const websocketHostname = new URL(publicWsUrl).hostname
    if (webuiHostname !== websocketHostname) {
      // Remote authentication uses a host-only session cookie. It cannot be
      // sent to a WebSocket endpoint on another hostname.
      throw new Error('Public Web UI and WebSocket URLs must use the same hostname')
    }
  }

  return {
    ...config,
    publicWebuiUrl,
    publicWsUrl,
  }
}
