import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { RateLimiter, createSessionToken, createRemoteSessionToken, REMOTE_SESSION_EXPIRY_SECONDS, buildSessionCookie, buildLogoutCookie } from './auth';
import { RemotePairingManager } from './remote-pairing';
import { RemoteDeviceRegistry } from './remote-device-registry';

import { generateCallbackPage } from '@craft-agent/shared/auth';
import { ApiRequestBodyError, readApiJson, getMimeType, shouldUseSecureCookies, resolveWebSocketUrl, type WebuiHandlerOptions, type RemotePairingDetails } from "./http-request-context";
import type { JwtPayload } from './auth';

interface createWebuiRequestRouterInput {
  allowInsecureSessions: boolean
  secureCookies: boolean | undefined
  isSecureSessionTransport: (req: Request) => boolean
  isAllowedBrowserMutation: (req: Request) => boolean
  logger: import("..").Logger
  getHealthCheck: () => { status: string; }
  serveFile: (path: string, headers?: Record<string, string>) => Promise<Response | null>
  webuiDir: string
  serveSpaIndex: (headers?: Record<string, string>) => Promise<Response>
  getClientIp: (req: Request) => string
  pairingRateLimiter: RateLimiter
  pairingManager: RemotePairingManager
  getRemoteWorkspaceIds: (() => readonly string[]) | undefined
  remoteDeviceRegistry: RemoteDeviceRegistry
  secret: string
  getHostLabel: (req: Request) => string
  passwordVerifierReady: Promise<import("./auth").PasswordVerifier>
  rateLimiter: RateLimiter
  validateAuthorizedSession: (cookieHeader: string | null) => Promise<JwtPayload | null>
  issueRemotePairing: (publicBaseUrl: string, displayHostLabel: string) => RemotePairingDetails
  getPublicWebuiBaseUrl: (req: Request) => string
  options: WebuiHandlerOptions
  remoteAuthMode: "pairing-code" | "server-token" | "email-code" | "external-provider"
  publicWsUrl: string | undefined
  wsProtocol: "ws" | "wss"
  wsPort: number
  isTrustedProxyRequest: (req: Request) => boolean
}

export function createWebuiRequestRouter({
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
}: createWebuiRequestRouterInput) {
async function routeRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    const useSecureCookies = allowInsecureSessions
      ? shouldUseSecureCookies(req, secureCookies)
      : true

    if (path.startsWith('/api/') && !isSecureSessionTransport(req)) {
      return Response.json({ error: 'HTTPS is required' }, {
        status: 426,
        headers: { 'Cache-Control': 'no-store', Upgrade: 'TLS/1.2' },
      })
    }

    if (
      path.startsWith('/api/')
      && !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())
      && !isAllowedBrowserMutation(req)
    ) {
      logger.warn('[webui] Rejected cross-origin state-changing request')
      return Response.json({ error: 'Cross-origin request rejected' }, {
        status: 403,
        headers: { 'Cache-Control': 'no-store' },
      })
    }

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
        'Cache-Control': 'private, no-store',
      }) ?? new Response('Login page not found', { status: 404 })
    }

    // ── Mobile Remote pairing page (public; ticket exchange is rate-limited) ──
    if ((path === '/remote' || path === '/remote/') && req.method === 'GET') {
      return serveSpaIndex({ 'Cache-Control': 'no-store' })
    }

    // ── Public static assets used by login and Remote pairing pages ──
    if (path.endsWith('.map')) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      })
    }

    if (
      path === '/favicon.ico'
      || path === '/favicon.svg'
      || path === '/apple-touch-icon.png'
      || path === '/icon-192.png'
      || path === '/icon-512.png'
      || path === '/manifest.json'
      || path === '/offline.html'
      || path === '/index.html'
      || path === '/sw.js'
      || path.startsWith('/login-assets/')
      || path.startsWith('/assets/')
    ) {
      const isServiceWorker = path === '/sw.js'
      const isHtml = path.endsWith('.html')
      const isImmutableAsset = path.startsWith('/assets/')
      return await serveFile(join(webuiDir, path), {
        'Content-Type': path === '/manifest.json'
          ? 'application/manifest+json; charset=utf-8'
          : getMimeType(path),
        'Cache-Control': isServiceWorker
          ? 'no-cache'
          : isHtml
            ? 'private, no-store'
            : isImmutableAsset
              ? 'public, max-age=31536000, immutable'
              : 'public, max-age=300, must-revalidate',
        ...(isServiceWorker ? { 'Service-Worker-Allowed': '/' } : {}),
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
        body = await readApiJson(req)
      } catch (error) {
        const bodyError = error instanceof ApiRequestBodyError
          ? error
          : new ApiRequestBodyError('Invalid request body', 400)
        return Response.json({ error: bodyError.message }, { status: bodyError.status })
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
      const verifyPassword = await passwordVerifierReady
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
        body = await readApiJson(req)
      } catch (error) {
        const bodyError = error instanceof ApiRequestBodyError
          ? error
          : new ApiRequestBodyError('Invalid request body', 400)
        return Response.json({ error: bodyError.message }, { status: bodyError.status })
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
        if (flow && state) {
          options.oauthCallbackDeps.flowStore.remove(state)
          if (flow.sessionId && flow.authRequestId) {
            options.oauthCallbackDeps.sessionManager.releasePendingOAuthRequest?.(
              flow.sessionId, flow.authRequestId, flow.flowId,
            )
          }
        }
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

    // ── Config endpoint ──
    if (path === '/api/config' && req.method === 'GET') {
      const configSession = await validateAuthorizedSession(req.headers.get('cookie'))
      if (!configSession) {
        // Pairing-code and tunnel-provider modes intentionally expose only the
        // public WSS endpoint. The one-time ticket/code remains the credential.
        // Legacy server-token mode keeps the historical owner login gate.
        if (remoteAuthMode === 'server-token') {
          return Response.json({ error: 'Unauthorized' }, { status: 401 })
        }
        return Response.json({
          wsUrl: resolveWebSocketUrl(req, { publicWsUrl, wsProtocol, wsPort, trustedProxy: isTrustedProxyRequest(req) }),
          session: {
            kind: 'pairing',
            deviceId: null,
            expiresAt: null,
          },
          hostLabel: getHostLabel(req),
        }, {
          headers: { 'Cache-Control': 'no-store' },
        })
      }
      return Response.json({
        wsUrl: resolveWebSocketUrl(req, { publicWsUrl, wsProtocol, wsPort, trustedProxy: isTrustedProxyRequest(req) }),
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
        // Node's WHATWG Response.redirect rejects relative URLs even though Bun
        // accepts them. Emit the relative Location header directly so Electron
        // does not return a generic 500 and no untrusted Host value is reflected.
        return new Response(null, {
          status: 302,
          headers: { Location: `/login${next}` },
        })
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
return routeRequest
}
