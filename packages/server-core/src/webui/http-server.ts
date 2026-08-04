/**
 * Web UI HTTP handler and standalone server.
 *
 * The core logic lives in `createWebuiHandler()` which returns a web-standard
 * fetch handler `(Request) => Promise<Response>`. This handler can be:
 *
 * 1. **Embedded** — attached to the WsRpcServer's HTTPS server via the
 *    node-adapter so that HTTP and WSS share a single port.
 * 2. **Standalone** — wrapped in `Bun.serve()` via `startWebuiHttpServer()`
 *    for separate-port deployments or development.
 */

import { join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  RateLimiter,
  initPasswordHash,
  verifyPassword,
  createSessionToken,
  createRemoteSessionToken,
  REMOTE_SESSION_EXPIRY_SECONDS,
  validateSession,
  buildSessionCookie,
  buildLogoutCookie,
} from './auth'
import { RemotePairingManager, formatPairingCode } from './remote-pairing'
import { RemoteDeviceRegistry } from './remote-device-registry'
import { generateCallbackPage } from '@craft-agent/shared/auth'
import type { PlatformServices } from '../runtime/platform'
import type { completeOAuthFlow } from '../handlers/rpc/oauth'
import type { JwtPayload } from './auth'

// ---------------------------------------------------------------------------
// MIME types for static file serving
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
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

function getMimeType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function getForwardedValue(req: Request, key: 'proto' | 'host'): string | null {
  const forwarded = req.headers.get('forwarded')
  if (!forwarded) return null

  const match = forwarded.match(new RegExp(`${key}="?([^;,"]+)"?`, 'i'))
  return match?.[1]?.trim() || null
}

function getRequestProto(req: Request): string {
  return req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
    || getForwardedValue(req, 'proto')
    || new URL(req.url).protocol.replace(/:$/, '')
}

function getRequestHost(req: Request): string | null {
  return req.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    || getForwardedValue(req, 'host')
    || req.headers.get('host')
}

function formatHostWithPort(host: string, port: number): string {
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
  return getRequestProto(req) === 'https'
}

export interface ResolveWebSocketUrlOptions {
  publicWsUrl?: string
  wsProtocol: 'ws' | 'wss'
  wsPort: number
}

export function resolveWebSocketUrl(
  req: Request,
  { publicWsUrl, wsProtocol, wsPort }: ResolveWebSocketUrlOptions,
): string {
  if (publicWsUrl) return publicWsUrl

  const host = getRequestHost(req)
  if (host) {
    return `${wsProtocol}://${formatHostWithPort(host, wsPort)}`
  }

  return `${wsProtocol}://127.0.0.1:${wsPort}`
}

// ---------------------------------------------------------------------------
// Handler options (shared between embedded and standalone modes)
// ---------------------------------------------------------------------------

type CompleteOAuthFlowOptions = Parameters<typeof completeOAuthFlow>[0]

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
  password?: string
  /** Explicit Secure-cookie override. When unset, infer from the request / proxy headers. */
  secureCookies?: boolean
  /** Optional browser-facing WebSocket URL override for reverse-proxy deployments. */
  publicWsUrl?: string
  /** Optional browser-facing Web UI URL used in Remote pairing links. */
  publicWebuiUrl?: string
  /** Human-readable host label shown on paired mobile devices. */
  hostLabel?: string
  /** RPC WebSocket protocol used when building a browser-facing fallback URL. */
  wsProtocol: 'ws' | 'wss'
  /** RPC WebSocket port used when building a browser-facing fallback URL. */
  wsPort: number
  /** Health check function (injected from existing server handler). */
  getHealthCheck: () => { status: string }
  /** Logger. */
  logger: PlatformServices['logger']
  /** Durable authorization store for paired Remote devices. */
  remoteDeviceRegistry?: RemoteDeviceRegistry
  /** Workspace scope granted to a newly paired Remote device. */
  getRemoteWorkspaceIds?: () => readonly string[]
  /** Disconnects an active Remote transport immediately after host revocation. */
  onRemoteDeviceRevoked?: (deviceId: string) => void
  /** OAuth callback deps — when provided, enables /api/oauth/callback route. */
  oauthCallbackDeps?: OAuthCallbackDeps
  /**
   * Trusted proxy IPs/CIDRs. When set, proxy headers (x-forwarded-for, x-forwarded-proto)
   * are only trusted from these sources. When empty/unset, proxy headers are ignored
   * and 'direct' is used as the rate-limit key.
   */
  trustedProxies?: string[]
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

/**
 * Create a web-standard fetch handler for the WebUI.
 *
 * This handler can be used directly with `Bun.serve({ fetch })`,
 * or adapted for Node's HTTP server via `nodeHttpAdapter()`.
 */
export function createWebuiHandler(options: WebuiHandlerOptions): WebuiHandler {
  const {
    webuiDir,
    secret,
    password,
    secureCookies,
    publicWsUrl,
    publicWebuiUrl,
    hostLabel,
    wsProtocol,
    wsPort,
    getHealthCheck,
    logger,
    trustedProxies,
    getRemoteWorkspaceIds,
  } = options

  const rateLimiter = new RateLimiter(5, 60_000)
  const pairingRateLimiter = new RateLimiter(10, 60_000, 100)
  const pairingManager = new RemotePairingManager()
  const remoteDeviceRegistry = options.remoteDeviceRegistry ?? new RemoteDeviceRegistry()
  const cleanupTimer = setInterval(() => {
    rateLimiter.cleanup()
    pairingRateLimiter.cleanup()
    pairingManager.cleanup()
  }, 120_000)

  const loginPassword = password || secret
  const trustedProxySet = new Set(trustedProxies ?? [])

  async function validateAuthorizedSession(cookieHeader: string | null): Promise<JwtPayload | null> {
    const session = await validateSession(cookieHeader, secret)
    if (!session || session.kind === 'owner') return session
    if (!session.deviceId) return null
    const device = remoteDeviceRegistry.authorize(session.deviceId, session.authorizationGeneration)
    return device ? { ...session, allowedWorkspaceIds: device.allowedWorkspaceIds } : null
  }

  // Hash the login password at startup (async, but resolves before first auth attempt in practice)
  const passwordReady = initPasswordHash(loginPassword)

  /** Extract client IP — only trusts proxy headers when trustedProxies is configured. */
  function getClientIp(req: Request): string {
    if (trustedProxySet.size > 0) {
      return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        ?? req.headers.get('x-real-ip')
        ?? 'direct'
    }
    return 'direct'
  }

  function getPublicWebuiBaseUrl(req: Request): string {
    if (publicWebuiUrl) return publicWebuiUrl.replace(/\/$/, '')
    const requestHost = getRequestHost(req)
    if (requestHost) return `${getRequestProto(req)}://${requestHost}`
    return `${getRequestProto(req)}://127.0.0.1:${wsPort}`
  }

  function getHostLabel(req: Request): string {
    if (hostLabel?.trim()) return hostLabel.trim().slice(0, 80)
    const requestHost = getRequestHost(req)
    if (!requestHost) return 'Robb Agents host'
    try {
      return new URL(`http://${requestHost}`).hostname
    } catch {
      return requestHost.slice(0, 80)
    }
  }

  async function serveFile(path: string, headers: Record<string, string> = {}): Promise<Response | null> {
    try {
      const contents = await readFile(path)
      return new Response(contents, {
        headers: {
          ...headers,
        },
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async function serveSpaIndex(headers: Record<string, string> = {}): Promise<Response> {
    return await serveFile(join(webuiDir, 'index.html'), {
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    }) ?? new Response('Not Found', { status: 404 })
  }

  function issueRemotePairing(publicBaseUrl: string, displayHostLabel: string): RemotePairingDetails {
    const pairing = pairingManager.issue()
    const pairingUrl = new URL('/remote', publicBaseUrl)
    pairingUrl.searchParams.set('pairing', pairing.ticket)
    return {
      pairingUrl: pairingUrl.toString(),
      code: formatPairingCode(pairing.code),
      expiresAt: pairing.expiresAt,
      hostLabel: displayHostLabel,
    }
  }

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    const useSecureCookies = shouldUseSecureCookies(req, secureCookies)

    // ── Health endpoint (no auth) ──
    if (path === '/health') {
      const health = getHealthCheck()
      return Response.json(health, {
        status: health.status === 'ok' ? 200 : 503,
      })
    }

    // ── Login page (no auth) ──
    if (path === '/login' || path === '/login/') {
      return await serveFile(join(webuiDir, 'login.html'), {
        'Content-Type': 'text/html; charset=utf-8',
      }) ?? new Response('Login page not found', { status: 404 })
    }

    // ── Mobile Remote pairing page (public; ticket exchange is rate-limited) ──
    if ((path === '/remote' || path === '/remote/') && req.method === 'GET') {
      return serveSpaIndex({ 'Cache-Control': 'no-store' })
    }

    // ── Public static assets used by login and Remote pairing pages ──
    if (
      path === '/favicon.ico'
      || path === '/favicon.svg'
      || path === '/apple-touch-icon.png'
      || path === '/manifest.json'
      || path === '/sw.js'
      || path.startsWith('/login-assets/')
      || path.startsWith('/assets/')
    ) {
      return await serveFile(join(webuiDir, path), {
        'Content-Type': getMimeType(path),
      }) ?? new Response('Not Found', { status: 404 })
    }

    // ── Exchange a one-time ticket for a device-scoped Remote session ──
    if (path === '/api/remote/pair' && req.method === 'POST') {
      const ip = getClientIp(req)
      if (!pairingRateLimiter.check(ip)) {
        logger.warn(`[webui] Rate limited Remote pairing attempt from ${ip}`)
        return Response.json({ error: 'Too many pairing attempts. Try again later.' }, { status: 429 })
      }

      let body: { ticket?: string; code?: string; deviceName?: string }
      try {
        body = await req.json() as { ticket?: string; code?: string; deviceName?: string }
      } catch {
        return Response.json({ error: 'Invalid request body' }, { status: 400 })
      }

      const ticket = typeof body.ticket === 'string' && body.ticket.length <= 256 ? body.ticket : undefined
      const code = typeof body.code === 'string' && body.code.length <= 16 ? body.code : undefined
      if (!ticket && !code) {
        return Response.json({ error: 'A pairing ticket or code is required' }, { status: 400 })
      }

      const result = pairingManager.consume({ ticket, code })
      if (!result.ok) {
        const status = result.reason === 'used' ? 409 : result.reason === 'expired' ? 410 : 401
        return Response.json({ error: `Pairing ${result.reason}` }, { status })
      }

      const deviceId = randomUUID()
      const deviceName = typeof body.deviceName === 'string' && body.deviceName.trim()
        ? body.deviceName.trim().slice(0, 80)
        : 'Mobile device'
      const allowedWorkspaceIds = [...new Set(getRemoteWorkspaceIds?.() ?? [])]
      if (allowedWorkspaceIds.length === 0) {
        return Response.json({ error: 'No active workspace is available for Remote pairing' }, { status: 409 })
      }
      const authorizationGeneration = Date.now()
      const expiresAt = new Date(Date.now() + REMOTE_SESSION_EXPIRY_SECONDS * 1000).toISOString()
      remoteDeviceRegistry.register({
        id: deviceId,
        name: deviceName,
        allowedWorkspaceIds,
        expiresAt,
        authorizationGeneration,
      })
      const jwt = await createRemoteSessionToken(secret, {
        deviceId,
        allowedWorkspaceIds,
        authorizationGeneration,
      })
      logger.info(`[webui] Paired Remote device ${deviceId} (${deviceName}) from ${ip}`)

      return Response.json({
        ok: true,
        deviceId,
        hostLabel: getHostLabel(req),
      }, {
        headers: {
          'Cache-Control': 'no-store',
          'Set-Cookie': buildSessionCookie(jwt, useSecureCookies, REMOTE_SESSION_EXPIRY_SECONDS),
        },
      })
    }

    // ── Auth endpoint ──
    if (path === '/api/auth' && req.method === 'POST') {
      await passwordReady
      const ip = getClientIp(req)

      if (!rateLimiter.check(ip)) {
        logger.warn(`[webui] Rate limited auth attempt from ${ip}`)
        return Response.json(
          { error: 'Too many attempts. Try again later.' },
          { status: 429 },
        )
      }

      let body: { password?: string }
      try {
        body = await req.json() as { password?: string }
      } catch {
        return Response.json({ error: 'Invalid request body' }, { status: 400 })
      }

      if (!body.password || typeof body.password !== 'string') {
        return Response.json({ error: 'Password is required' }, { status: 400 })
      }

      if (!await verifyPassword(body.password)) {
        logger.warn(`[webui] Failed auth attempt from ${ip}`)
        return Response.json({ error: 'Invalid credentials' }, { status: 401 })
      }

      const jwt = await createSessionToken(secret)
      logger.info(`[webui] Successful auth from ${ip}`)

      return Response.json({ ok: true }, {
        status: 200,
        headers: {
          'Set-Cookie': buildSessionCookie(jwt, useSecureCookies),
        },
      })
    }

    // ── Logout endpoint ──
    if (path === '/api/auth/logout' && req.method === 'POST') {
      return new Response(null, {
        status: 204,
        headers: {
          'Set-Cookie': buildLogoutCookie(useSecureCookies),
        },
      })
    }

    // ── Create a one-time pairing link (owner session only) ──
    if (path === '/api/remote/pairing' && req.method === 'POST') {
      const ownerSession = await validateAuthorizedSession(req.headers.get('cookie'))
      if (!ownerSession) return Response.json({ error: 'Unauthorized' }, { status: 401 })
      if (ownerSession.kind !== 'owner') {
        return Response.json({ error: 'Only the host owner can pair another device' }, { status: 403 })
      }

      return Response.json(issueRemotePairing(getPublicWebuiBaseUrl(req), getHostLabel(req)), {
        headers: { 'Cache-Control': 'no-store' },
      })
    }

    if (path === '/api/remote/devices' && req.method === 'GET') {
      const ownerSession = await validateAuthorizedSession(req.headers.get('cookie'))
      if (!ownerSession) return Response.json({ error: 'Unauthorized' }, { status: 401 })
      if (ownerSession.kind !== 'owner') {
        return Response.json({ error: 'Only the host owner can list paired devices' }, { status: 403 })
      }
      return Response.json({ devices: remoteDeviceRegistry.list() }, {
        headers: { 'Cache-Control': 'no-store' },
      })
    }

    const remoteDeviceRoute = path.match(/^\/api\/remote\/devices\/([^/]+)$/)
    if (remoteDeviceRoute && req.method === 'DELETE') {
      const ownerSession = await validateAuthorizedSession(req.headers.get('cookie'))
      if (!ownerSession) return Response.json({ error: 'Unauthorized' }, { status: 401 })
      if (ownerSession.kind !== 'owner') {
        return Response.json({ error: 'Only the host owner can revoke paired devices' }, { status: 403 })
      }
      const deviceId = decodeURIComponent(remoteDeviceRoute[1] ?? '')
      if (!remoteDeviceRegistry.revoke(deviceId)) {
        return Response.json({ error: 'Remote device not found' }, { status: 404 })
      }
      options.onRemoteDeviceRevoked?.(deviceId)
      return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
    }

    if (path === '/api/remote/status' && req.method === 'GET') {
      const remoteSession = await validateAuthorizedSession(req.headers.get('cookie'))
      if (!remoteSession) return Response.json({ error: 'Unauthorized' }, { status: 401 })
      return Response.json({
        kind: remoteSession.kind,
        deviceId: remoteSession.deviceId ?? null,
        expiresAt: new Date(remoteSession.exp * 1000).toISOString(),
        hostLabel: getHostLabel(req),
      }, {
        headers: { 'Cache-Control': 'no-store' },
      })
    }

    // ── OAuth callback (no cookie auth — state param is CSRF protection) ──
    // Receives redirect from the relay (or directly from OAuth provider for MCP sources).
    // Completes the token exchange server-side and renders a success/error page.
    if (path === '/api/oauth/callback' && req.method === 'GET' && options.oauthCallbackDeps) {
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      const errorDescription = url.searchParams.get('error_description')

      if (error) {
        const flow = state ? options.oauthCallbackDeps.flowStore.getByState(state) : null
        if (flow && state) options.oauthCallbackDeps.flowStore.remove(state)
        const errorMsg = errorDescription || error
        logger.warn(`[webui] OAuth callback error: ${errorMsg}`)
        return new Response(generateCallbackPage({ title: 'Authorization Failed', isSuccess: false, errorDetail: errorMsg }), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }

      if (!code || !state) {
        return new Response(generateCallbackPage({ title: 'Authorization Failed', isSuccess: false, errorDetail: 'Missing code or state parameter' }), {
          status: 400,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }

      try {
        const { completeOAuthFlow } = await import('../handlers/rpc/oauth')
        const result = await completeOAuthFlow({
          code,
          state,
          flowStore: options.oauthCallbackDeps.flowStore,
          credManager: options.oauthCallbackDeps.credManager,
          sessionManager: options.oauthCallbackDeps.sessionManager,
          pushSourcesChanged: options.oauthCallbackDeps.pushSourcesChanged,
          logger,
          // No clientId/workspaceId — HTTP callback skips ownership checks (state is auth)
        })

        if (result.success) {
          return new Response(generateCallbackPage({ title: 'Authorization Successful', isSuccess: true }), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        } else {
          return new Response(generateCallbackPage({ title: 'Authorization Failed', isSuccess: false, errorDetail: result.error }), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Token exchange failed'
        logger.error(`[webui] OAuth callback failed: ${msg}`)
        return new Response(generateCallbackPage({ title: 'Authorization Failed', isSuccess: false, errorDetail: msg }), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
      }
    }

    // ── Config endpoint (requires session cookie) ──
    if (path === '/api/config' && req.method === 'GET') {
      const configSession = await validateAuthorizedSession(req.headers.get('cookie'))
      if (!configSession) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      return Response.json({
        wsUrl: resolveWebSocketUrl(req, { publicWsUrl, wsProtocol, wsPort }),
        session: {
          kind: configSession.kind,
          deviceId: configSession.deviceId ?? null,
          expiresAt: new Date(configSession.exp * 1000).toISOString(),
        },
        hostLabel: getHostLabel(req),
      })
    }

    // Return the default workspace ID so the webui can include it in the WS handshake
    if (path === '/api/config/workspaces' && req.method === 'GET') {
      const configSession = await validateAuthorizedSession(req.headers.get('cookie'))
      if (!configSession) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      const { getActiveWorkspace } = await import('@craft-agent/shared/config/storage')
      const active = getActiveWorkspace()
      const defaultWorkspaceId = configSession.allowedWorkspaceIds === '*'
        ? active?.id ?? null
        : configSession.allowedWorkspaceIds[0] ?? null
      return Response.json({
        defaultWorkspaceId,
      })
    }

    // ── Everything below requires a valid session cookie ──
    const cookieHeader = req.headers.get('cookie')
    const session = await validateAuthorizedSession(cookieHeader)

    if (!session) {
      const accept = req.headers.get('accept') ?? ''
      if (accept.includes('text/html') || path === '/' || path === '') {
        const next = path.startsWith('/remote/setup') ? `?next=${encodeURIComponent(path)}` : ''
        return Response.redirect(`/login${next}`, 302)
      }
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // ── Serve SPA static files ──
    if (path !== '/') {
      const file = await serveFile(join(webuiDir, path), { 'Content-Type': getMimeType(path) })
      if (file) return file
    }

    // SPA fallback — serve index.html for all non-file routes
    return serveSpaIndex()
  }

  return {
    fetch,
    dispose: () => clearInterval(cleanupTimer),
    setOAuthCallbackDeps: (deps: OAuthCallbackDeps) => {
      options.oauthCallbackDeps = deps
    },
    createRemotePairing: (publicBaseUrl, displayHostLabel = hostLabel || 'Robb Agents host') => (
      issueRemotePairing(publicBaseUrl, displayHostLabel.trim().slice(0, 80))
    ),
    listRemoteDevices: () => remoteDeviceRegistry.list(),
    revokeRemoteDevice: (deviceId) => {
      const revoked = remoteDeviceRegistry.revoke(deviceId)
      if (revoked) options.onRemoteDeviceRevoked?.(deviceId)
      return revoked
    },
  }
}

// ---------------------------------------------------------------------------
// Standalone server (backwards-compatible, uses Bun.serve)
// ---------------------------------------------------------------------------

export interface WebuiHttpServerOptions extends WebuiHandlerOptions {
  /** Port to bind on. Use 0 for an ephemeral port in tests. */
  port: number
}

export async function startWebuiHttpServer(
  options: WebuiHttpServerOptions,
): Promise<{ port: number, stop: () => void }> {
  const { port, logger, ...handlerOpts } = options
  const handler = createWebuiHandler({ ...handlerOpts, logger })

  const server = Bun.serve({
    port,
    fetch: handler.fetch,
  })

  const boundPort = server.port ?? port
  logger.info(`[webui] Web UI server listening on http://0.0.0.0:${boundPort}`)

  return {
    port: boundPort,
    stop: () => {
      handler.dispose()
      server.stop()
    },
  }
}
