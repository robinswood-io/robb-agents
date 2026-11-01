import { join, resolve, sep } from 'node:path';
import "node:crypto";
import { readFile, realpath } from 'node:fs/promises';
import { RateLimiter, createPasswordVerifier, validateSession } from './auth';
import { RemotePairingManager, formatPairingCode } from './remote-pairing';
import { RemoteDeviceRegistry } from './remote-device-registry';
import { getNodeRequestRemoteAddress } from './node-adapter';
import "@craft-agent/shared/auth";
import { getRequestHost, withBrowserSecurityHeaders, type OAuthCallbackDeps, type WebuiHandlerOptions, type WebuiHandler, type RemotePairingDetails } from "./http-request-context";
export { shouldUseSecureCookies, type ResolveWebSocketUrlOptions, resolveWebSocketUrl, type OAuthCallbackDeps, type WebuiHandlerOptions, type WebuiHandler, type RemotePairingDetails } from "./http-request-context";

import { createWebuiRequestRouter } from "./http-request-router";
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




















import type { JwtPayload } from './auth';


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
    remoteAuthMode = 'pairing-code',
    hostLabel,
    wsProtocol,
    wsPort,
    getHealthCheck,
    logger,
    trustedProxies,
    getRemoteWorkspaceIds,
    allowInsecureSessions = false,
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

  // Derive a handler-local password verifier before accepting an auth attempt.
  const passwordVerifierReady = createPasswordVerifier(loginPassword)

  function hasSecureBrowserWebSocket(): boolean {
    if (publicWsUrl) {
      try {
        return new URL(publicWsUrl).protocol === 'wss:'
      } catch {
        return false
      }
    }
    return wsProtocol === 'wss'
  }

  function isConfiguredHttpsProxy(): boolean {
    if (!publicWebuiUrl || secureCookies !== true || !hasSecureBrowserWebSocket()) return false
    try {
      return new URL(publicWebuiUrl).protocol === 'https:'
    } catch {
      return false
    }
  }

  function isSecureSessionTransport(req: Request): boolean {
    if (allowInsecureSessions) return true
    const isDirectHttps = new URL(req.url).protocol === 'https:'
      && secureCookies !== false
      && hasSecureBrowserWebSocket()
    return isDirectHttps || isConfiguredHttpsProxy()
  }

  function isAllowedBrowserMutation(req: Request): boolean {
    const fetchSite = req.headers.get('sec-fetch-site')?.toLowerCase()
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false

    const origin = req.headers.get('origin')
    if (!origin) return true

    try {
      const expectedOrigin = publicWebuiUrl
        ? new URL(publicWebuiUrl).origin
        : new URL(req.url).origin
      return new URL(origin).origin === expectedOrigin
    } catch {
      return false
    }
  }

  function isTrustedProxyRequest(req: Request): boolean {
    if (trustedProxySet.size === 0) return true
    const transportPeer = getNodeRequestRemoteAddress(req)
    return Boolean(transportPeer && trustedProxySet.has(transportPeer))
  }

  /** Extract client IP — only trusts proxy headers when trustedProxies is configured. */
  function getClientIp(req: Request): string {
    const transportPeer = getNodeRequestRemoteAddress(req)
    if (transportPeer && trustedProxySet.has(transportPeer)) {
      return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        ?? req.headers.get('x-real-ip')
        ?? transportPeer
    }
    return transportPeer ?? 'direct'
  }

  function getPublicWebuiBaseUrl(req: Request): string {
    if (publicWebuiUrl) return publicWebuiUrl.replace(/\/$/, '')
    // Never build a credential-bearing link from spoofable proxy headers.
    // Reverse proxies must provide the explicit browser-facing URL above.
    return new URL(req.url).origin
  }

  function getHostLabel(req: Request): string {
    if (hostLabel?.trim()) return hostLabel.trim().slice(0, 80)
    const requestHost = getRequestHost(req, isTrustedProxyRequest(req))
    if (!requestHost) return 'Robb Agents host'
    try {
      return new URL(`http://${requestHost}`).hostname
    } catch {
      return requestHost.slice(0, 80)
    }
  }

  const resolvedWebuiDir = resolve(webuiDir)
  const webuiPrefix = resolvedWebuiDir.endsWith(sep) ? resolvedWebuiDir : `${resolvedWebuiDir}${sep}`

  async function serveFile(path: string, headers: Record<string, string> = {}): Promise<Response | null> {
    if (path.includes('\0')) return null
    const resolvedTarget = resolve(path)
    if (resolvedTarget !== resolvedWebuiDir && !resolvedTarget.startsWith(webuiPrefix)) {
      return null
    }
    try {
      const realTarget = await realpath(resolvedTarget)
      const realRoot = await realpath(resolvedWebuiDir).catch(() => resolvedWebuiDir)
      const realPrefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
      if (!realTarget.startsWith(realPrefix)) {
        return null
      }
      const contents = await readFile(realTarget)
      return new Response(contents, {
        headers: {
          ...headers,
        },
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return null
      throw error
    }
  }

  async function serveSpaIndex(headers: Record<string, string> = {}): Promise<Response> {
    return await serveFile(join(webuiDir, 'index.html'), {
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'private, no-store',
      ...headers,
    }) ?? new Response('Not Found', { status: 404 })
  }

  function issueRemotePairing(publicBaseUrl: string, displayHostLabel: string): RemotePairingDetails {
    const pairingUrl = new URL('/remote', publicBaseUrl)
    if (pairingUrl.username || pairingUrl.password) {
      throw new Error('Remote pairing URL must not contain credentials')
    }
    if (!allowInsecureSessions && (pairingUrl.protocol !== 'https:' || !hasSecureBrowserWebSocket())) {
      throw new Error('HTTPS and WSS are required before pairing a Remote device')
    }

    const pairing = pairingManager.issue()
    pairingUrl.hash = new URLSearchParams({ pairing: pairing.ticket }).toString()
    return {
      pairingUrl: pairingUrl.toString(),
      code: formatPairingCode(pairing.code),
      expiresAt: pairing.expiresAt,
      hostLabel: displayHostLabel,
    }
  }
  const routeRequest = createWebuiRequestRouter({
    allowInsecureSessions,
    secureCookies,
    isSecureSessionTransport,
    isAllowedBrowserMutation,
    logger,
    getHealthCheck,
    serveFile,
    webuiDir,
    serveSpaIndex,
    getClientIp,
    pairingRateLimiter,
    pairingManager,
    getRemoteWorkspaceIds,
    remoteDeviceRegistry,
    secret,
    getHostLabel,
    passwordVerifierReady,
    rateLimiter,
    validateAuthorizedSession,
    issueRemotePairing,
    getPublicWebuiBaseUrl,
    options,
    remoteAuthMode,
    publicWsUrl,
    wsProtocol,
    wsPort,
    isTrustedProxyRequest,
  })

  async function fetch(req: Request): Promise<Response> {
    const response = await routeRequest(req)
    const parsedUrl = new URL(req.url)
    const isHttps = parsedUrl.protocol === 'https:' || isConfiguredHttpsProxy()
    return withBrowserSecurityHeaders(response, parsedUrl.pathname.startsWith('/api/'), isHttps)
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
  /** Hostname to bind on (defaults to 127.0.0.1). */
  host?: string | undefined
}

export async function startWebuiHttpServer(
  options: WebuiHttpServerOptions,
): Promise<{ port: number, stop: () => void }> {
  const { port, host = '127.0.0.1', logger, ...handlerOpts } = options
  const handler = createWebuiHandler({ ...handlerOpts, logger })

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: handler.fetch,
  })

  const boundPort = server.port ?? port
  logger.info(`[webui] Web UI server listening on http://${host}:${boundPort}`)

  return {
    port: boundPort,
    stop: () => {
      handler.dispose()
      server.stop()
    },
  }
}
