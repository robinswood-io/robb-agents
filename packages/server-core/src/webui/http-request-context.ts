import { extname } from 'node:path';




import { RemoteDeviceRegistry } from "./remote-device-registry";


import type { PlatformServices } from "../runtime/platform";
import type { completeOAuthFlow } from "../handlers/rpc/oauth";

import type { RemoteAuthMode } from '@craft-agent/shared/config/server-config';


// ---------------------------------------------------------------------------
// MIME types for static file serving
// ---------------------------------------------------------------------------

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.map': 'application/json',
}


export const MAX_API_JSON_BODY_BYTES = 16 * 1024


export class ApiRequestBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 415,
  ) {
    super(message)
  }
}


export async function readApiJson<T>(req: Request): Promise<T> {
  const contentType = req.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('application/json')) {
    throw new ApiRequestBodyError('Content-Type must be application/json', 415)
  }

  const declaredLength = Number(req.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_API_JSON_BODY_BYTES) {
    throw new ApiRequestBodyError('Request body is too large', 413)
  }

  const reader = req.body?.getReader()
  if (!reader) throw new ApiRequestBodyError('Invalid request body', 400)

  const decoder = new TextDecoder()
  let text = ''
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > MAX_API_JSON_BODY_BYTES) {
      await reader.cancel()
      throw new ApiRequestBodyError('Request body is too large', 413)
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()

  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiRequestBodyError('Invalid request body', 400)
  }
}


export function getMimeType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}


export function getForwardedValue(req: Request, key: 'proto' | 'host'): string | null {
  const forwarded = req.headers.get('forwarded')
  if (!forwarded) return null

  const match = forwarded.match(new RegExp(`${key}="?([^;,"]+)"?`, 'i'))
  return match?.[1]?.trim() || null
}


export function sanitizeHostHeader(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 255 || /[\s/@?#"\\<>]/.test(trimmed)) return null
  try {
    const parsed = new URL(`http://${trimmed}`)
    if (
      parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== ''
    ) {
      return null
    }
    return trimmed
  } catch {
    return null
  }
}


export function getRequestHost(req: Request, allowForwardedHost = true): string | null {
  if (allowForwardedHost) {
    const forwardedHost = sanitizeHostHeader(
      req.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
        || getForwardedValue(req, 'host'),
    )
    if (forwardedHost) return forwardedHost
  }
  return sanitizeHostHeader(req.headers.get('host'))
}


export function formatHostWithPort(host: string, port: number): string {
  try {
    const parsed = new URL(`http://${host}`)
    const hostname = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname
    return `${hostname}:${port}`
  } catch {
    const withoutPort = host.replace(/:\d+$/, '')
    return `${withoutPort}:${port}`
  }
}


export function shouldUseSecureCookies(req: Request, secureCookies?: boolean): boolean {
  if (secureCookies != null) return secureCookies
  // Forwarded headers are attacker-controlled unless the immediate proxy is
  // authenticated. Reverse-proxy deployments must opt in explicitly instead.
  return new URL(req.url).protocol === 'https:'
}


export const BROWSER_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join('; '),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}


export function withBrowserSecurityHeaders(response: Response, noStore = false, isHttps = false): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(BROWSER_SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value)
  }
  if (isHttps && !headers.has('Strict-Transport-Security')) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  if ((noStore || headers.has('Set-Cookie')) && !headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'no-store')
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}


export interface ResolveWebSocketUrlOptions {
  publicWsUrl?: string
  wsProtocol: 'ws' | 'wss'
  wsPort: number
  trustedProxy?: boolean
}


export function resolveWebSocketUrl(
  req: Request,
  { publicWsUrl, wsProtocol, wsPort, trustedProxy = true }: ResolveWebSocketUrlOptions,
): string {
  if (publicWsUrl) return publicWsUrl

  const host = getRequestHost(req, trustedProxy)
  if (host) {
    return `${wsProtocol}://${formatHostWithPort(host, wsPort)}`
  }

  return `${wsProtocol}://127.0.0.1:${wsPort}`
}


// ---------------------------------------------------------------------------
// Handler options (shared between embedded and standalone modes)
// ---------------------------------------------------------------------------

export type CompleteOAuthFlowOptions = Parameters<typeof completeOAuthFlow>[0]


/** Dependencies for the /api/oauth/callback HTTP route (server-side OAuth completion). */
export type OAuthCallbackDeps = Pick<
  CompleteOAuthFlowOptions,
  'flowStore' | 'credManager' | 'sessionManager' | 'pushSourcesChanged'
>


export interface WebuiHandlerOptions {
  /** Path to built web UI dist/ directory. */
  webuiDir: string
  /** Secret used to sign JWTs — typically CRAFT_SERVER_TOKEN. */
  secret: string
  /** Optional separate web UI password. Falls back to `secret` for verification. */
  password?: string | undefined
  /** Explicit Secure-cookie override. When unset, infer from the request / proxy headers. */
  secureCookies?: boolean | undefined
  /**
   * Development/test escape hatch. Production pairing and cookie sessions are
   * rejected unless they use direct HTTPS or an explicitly configured HTTPS
   * reverse proxy with Secure cookies.
   */
  allowInsecureSessions?: boolean | undefined
  /** Optional browser-facing WebSocket URL override for reverse-proxy deployments. */
  publicWsUrl?: string | undefined
  /** Optional browser-facing Web UI URL used in Remote pairing links. */
  publicWebuiUrl?: string | undefined
  /** Gate applied before a browser can bootstrap the one-time pairing flow. */
  remoteAuthMode?: RemoteAuthMode | undefined
  /** Human-readable host label shown on paired mobile devices. */
  hostLabel?: string | undefined
  /** RPC WebSocket protocol used when building a browser-facing fallback URL. */
  wsProtocol: 'ws' | 'wss'
  /** RPC WebSocket port used when building a browser-facing fallback URL. */
  wsPort: number
  /** Health check function (injected from existing server handler). */
  getHealthCheck: () => { status: string }
  /** Logger. */
  logger: PlatformServices['logger']
  /** Durable authorization store for paired Remote devices. */
  remoteDeviceRegistry?: RemoteDeviceRegistry | undefined
  /** Workspace scope granted to a newly paired Remote device. */
  getRemoteWorkspaceIds?: (() => readonly string[]) | undefined
  /** Disconnects an active Remote transport immediately after host revocation. */
  onRemoteDeviceRevoked?: ((deviceId: string) => void) | undefined
  /** OAuth callback deps — when provided, enables /api/oauth/callback route. */
  oauthCallbackDeps?: OAuthCallbackDeps | undefined
  /**
   * Exact trusted proxy IP addresses. Forwarded client IP headers are accepted
   * only when the Node transport peer matches one of these addresses.
   */
  trustedProxies?: string[] | undefined
}


// ---------------------------------------------------------------------------
// Handler factory — the core request handler
// ---------------------------------------------------------------------------

export interface WebuiHandler {
  /** Web-standard fetch handler. */
  fetch: (req: Request) => Promise<Response>
  /** Call on shutdown to release timers. */
  dispose: () => void
  /** Inject OAuth callback deps after bootstrap (lazy wiring). */
  setOAuthCallbackDeps: (deps: OAuthCallbackDeps) => void
  /** Issue a short-lived one-time ticket for a trusted local owner UI. */
  createRemotePairing: (publicBaseUrl: string, hostLabel?: string) => RemotePairingDetails
  /** List durable device grants for the trusted local owner UI. */
  listRemoteDevices: () => ReturnType<RemoteDeviceRegistry['list']>
  /** Revoke a durable device grant from the trusted local owner UI. */
  revokeRemoteDevice: (deviceId: string) => boolean
}


export interface RemotePairingDetails {
  pairingUrl: string
  code: string
  expiresAt: string
  hostLabel: string
}
