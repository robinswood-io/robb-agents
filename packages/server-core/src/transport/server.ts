/**
 * WsRpcServer — WebSocket-based RPC server.
 *
 * Owns ALL transport concerns: connection lifecycle, handshake, heartbeat,
 * optional auth, request dispatching, and push routing.
 *
 * Same class used locally (127.0.0.1, no auth) and remotely (0.0.0.0, auth).
 */

import { WebSocketServer, type WebSocket } from 'ws'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { randomUUID } from 'node:crypto'
import {
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MISSED,
  EVENT_BUFFER_MAX_SIZE,
  EVENT_BUFFER_TTL_MS,
  DISCONNECTED_CLIENT_TTL_MS,
  isErrorCode,
  type MessageEnvelope,
  type PushTarget,
  type ErrorCode,
} from '@craft-agent/shared/protocol'
import type {
  RpcServer,
  HandlerFn,
  RequestContext,
  AuthenticatedPrincipal,
  AuthenticationResult,
  ConnectedClientInfo,
} from './types'
import { serializeEnvelope, deserializeEnvelope } from './codec'
import { createLogger } from '@craft-agent/shared/utils'

// ---------------------------------------------------------------------------
// Client connection state
// ---------------------------------------------------------------------------

interface BufferedEvent {
  seq: number
  /** Shared serialized envelope — one allocation referenced by all client buffers. */
  data: string
  bytes: number
  timestamp: number
}

interface ClientConnection {
  id: string
  ws: WebSocket
  workspaceId: string | null
  webContentsId: number | null
  capabilities: Set<string>
  actorId: string
  roles: readonly string[]
  authorizationGeneration: number
  allowedWorkspaceIds: ReadonlySet<string> | '*'
  missedPongs: number
  alive: boolean
  /** Ring buffer of recent events for replay on reconnect. */
  eventBuffer: BufferedEvent[]
  /** Total byte size of buffered event strings for O(1) memory cap enforcement. */
  bufferedBytes: number
  /** Active concurrent RPC requests from this client. */
  inFlightRequests: number
  /** Highest per-client seq the client has acknowledged. */
  lastAckedSeq: number
  /** Highest per-client seq assigned to this client. */
  lastSentSeq: number
  /** Set when authorization is explicitly revoked so close handler does not retain reconnect buffer. */
  revoked?: boolean
}

interface PendingInvoke {
  clientId: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

function parseAuthenticatedPrincipal(value: AuthenticationResult): AuthenticatedPrincipal | null {
  if (typeof value !== 'object' || value === null) return null
  if (typeof value.actorId !== 'string' || value.actorId.trim() === '') return null
  if (!Number.isInteger(value.authorizationGeneration) || value.authorizationGeneration < 0) return null
  const workspaceIdsValid = value.allowedWorkspaceIds === '*'
    || (Array.isArray(value.allowedWorkspaceIds)
      && value.allowedWorkspaceIds.every((workspaceId) => typeof workspaceId === 'string' && workspaceId.trim() !== ''))
  const capabilitiesValid = value.capabilities === '*'
    || (Array.isArray(value.capabilities)
      && value.capabilities.every((capability) => typeof capability === 'string' && capability.trim() !== ''))
  const rolesValid = Array.isArray(value.roles)
    && value.roles.every((role) => typeof role === 'string' && role.trim() !== '')
  return workspaceIdsValid && capabilitiesValid && rolesValid ? value : null
}

function principalAllowsWorkspace(principal: AuthenticatedPrincipal, workspaceId: string | null): boolean {
  if (workspaceId === null || principal.allowedWorkspaceIds === '*') return true
  return principal.allowedWorkspaceIds.includes(workspaceId)
}

function authorizedCapabilities(
  principal: AuthenticatedPrincipal,
  requestedCapabilities: readonly string[],
): Set<string> {
  if (principal.capabilities === '*') return new Set(requestedCapabilities)
  const allowed = new Set(principal.capabilities)
  return new Set(requestedCapabilities.filter((capability) => allowed.has(capability)))
}

function localPrincipal(): AuthenticatedPrincipal {
  return {
    actorId: 'local-owner',
    allowedWorkspaceIds: '*',
    capabilities: '*',
    roles: ['owner'],
    authorizationGeneration: 0,
  }
}

function legacyAuthenticatedPrincipal(
  workspaceId: string | null,
  requestedCapabilities: readonly string[],
): AuthenticatedPrincipal {
  return {
    actorId: 'legacy-authenticated',
    allowedWorkspaceIds: workspaceId === null ? [] : [workspaceId],
    capabilities: [...requestedCapabilities],
    roles: [],
    authorizationGeneration: 0,
  }
}

// ---------------------------------------------------------------------------
// Server options
// ---------------------------------------------------------------------------

export interface WsRpcTlsOptions {
  /** PEM-encoded certificate (or Buffer). */
  cert: string | Buffer
  /** PEM-encoded private key (or Buffer). */
  key: string | Buffer
  /** Optional PEM-encoded CA chain for client certificate verification. */
  ca?: string | Buffer
  /** Optional passphrase for encrypted private keys. */
  passphrase?: string
}

export interface WsRpcServerOptions {
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string
  /** Port to bind to. 0 = random available port. Default: 0 */
  port?: number
  /** Whether to require a bearer token on handshake. Default: false */
  requireAuth?: boolean
  /** Token validator. Authoritative deployments return a server-issued principal. */
  validateToken?: (token: string) => Promise<AuthenticationResult>
  /**
   * Optional cookie-based session validator (for web UI auth).
   * Called with the Cookie header from the HTTP upgrade request.
   * If provided, a valid session cookie is accepted as an alternative to a bearer token.
   */
  validateSessionCookie?: (cookieHeader: string | null) => Promise<AuthenticationResult>
  /**
   * Explicit browser origins allowed to authenticate a WebSocket with a
   * session cookie. When unset, the server requires its own HTTPS/HTTP origin.
   */
  allowedSessionCookieOrigins?: readonly string[]
  /** Authoritative per-channel authorization invoked before every RPC handler. */
  authorizeRequest?: (
    context: RequestContext,
    channel: string,
    args: readonly unknown[],
  ) => boolean | Promise<boolean>
  /** Reject legacy boolean authentication results when true. */
  requireAuthoritativePrincipal?: boolean
  /** Server identity stamp on outgoing events. Default: 'local' */
  serverId?: string
  /** TLS configuration. When provided, the server listens on wss:// instead of ws://. */
  tls?: WsRpcTlsOptions
  /** App version string, included in handshake_ack for client compatibility checks. */
  serverVersion?: string
  /** Maximum concurrent clients. 0 = unlimited. Default: 50 */
  maxClients?: number
  /** Maximum WebSocket message size in bytes. Default: 8 MiB. */
  maxPayloadBytes?: number
  /** Maximum concurrent in-flight RPC requests per client. Default: 64. */
  maxInFlightRequestsPerClient?: number
  /** Maximum buffered event replay bytes per client. Default: 8 MiB. */
  maxEventBufferBytes?: number
  /** Maximum failed auth handshakes per IP per 60s window. Default: 15. */
  maxFailedHandshakesPerIp?: number
  /** Called when a client completes handshake. */
  onClientConnected?: (info: ConnectedClientInfo) => void
  /** Called when a client disconnects. */
  onClientDisconnected?: (clientId: string) => void
  /**
   * Optional HTTP request handler for non-WebSocket requests.
   * When provided, regular HTTP requests to the server's port are
   * routed here instead of being rejected. This enables serving the
   * WebUI from the same port as the WebSocket server.
   * Must use Node.js HTTP callback signature (IncomingMessage, ServerResponse).
   */
  httpHandler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
}

const transportLog = createLogger('ws-rpc-server')

// ---------------------------------------------------------------------------
// WsRpcServer
// ---------------------------------------------------------------------------

export class WsRpcServer implements RpcServer {
  private wss: WebSocketServer | null = null
  private httpServer: HttpServer | null = null
  private httpsServer: HttpsServer | null = null
  private clients = new Map<string, ClientConnection>()
  private clientByWs = new WeakMap<WebSocket, ClientConnection>()
  private handlers = new Map<string, HandlerFn>()
  private pendingInvokes = new Map<string, PendingInvoke>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private failedHandshakesByIp = new Map<string, { count: number; windowStart: number }>()
  private _port = 0
  private _protocol: 'ws' | 'wss' = 'ws'

  /** Recently disconnected clients retained for reconnect replay. */
  private disconnectedClients = new Map<string, { client: ClientConnection; timer: ReturnType<typeof setTimeout> }>()

  private readonly host: string
  private readonly requestedPort: number
  private readonly requireAuth: boolean
  private readonly validateToken: ((token: string) => Promise<AuthenticationResult>) | null
  private readonly validateSessionCookie: ((cookieHeader: string | null) => Promise<AuthenticationResult>) | null
  private readonly allowedSessionCookieOrigins: ReadonlySet<string>
  private readonly authorizeRequest: WsRpcServerOptions['authorizeRequest']
  private readonly requireAuthoritativePrincipal: boolean
  private readonly serverId: string
  private readonly tlsOptions: WsRpcTlsOptions | null
  private readonly serverVersion: string
  private readonly maxClients: number
  private readonly maxPayloadBytes: number
  private readonly maxInFlightRequestsPerClient: number
  private readonly maxEventBufferBytes: number
  private readonly maxFailedHandshakesPerIp: number
  private readonly onClientConnected: WsRpcServerOptions['onClientConnected']
  private readonly onClientDisconnected: WsRpcServerOptions['onClientDisconnected']
  private readonly httpHandler: WsRpcServerOptions['httpHandler']

  constructor(opts?: WsRpcServerOptions) {
    this.host = opts?.host ?? '127.0.0.1'
    this.requestedPort = opts?.port ?? 0
    this.requireAuth = opts?.requireAuth ?? false
    this.validateToken = opts?.validateToken ?? null
    this.validateSessionCookie = opts?.validateSessionCookie ?? null
    this.allowedSessionCookieOrigins = new Set((opts?.allowedSessionCookieOrigins ?? []).map((origin) => (
      new URL(origin).origin
    )))
    this.authorizeRequest = opts?.authorizeRequest
    this.requireAuthoritativePrincipal = opts?.requireAuthoritativePrincipal ?? false
    this.serverId = opts?.serverId ?? 'local'
    this.serverVersion = opts?.serverVersion ?? ''
    this.tlsOptions = opts?.tls ?? null
    this.maxClients = opts?.maxClients ?? 50
    this.maxPayloadBytes = opts?.maxPayloadBytes ?? 8 * 1024 * 1024
    this.maxInFlightRequestsPerClient = opts?.maxInFlightRequestsPerClient ?? 64
    this.maxEventBufferBytes = opts?.maxEventBufferBytes ?? 8 * 1024 * 1024
    this.maxFailedHandshakesPerIp = opts?.maxFailedHandshakesPerIp ?? 15
    this.onClientConnected = opts?.onClientConnected
    this.onClientDisconnected = opts?.onClientDisconnected
    this.httpHandler = opts?.httpHandler
  }

  /** The actual port the server is listening on (available after listen()). */
  get port(): number {
    return this._port
  }

  /** The protocol the server is using: 'wss' when TLS is configured, 'ws' otherwise. */
  get protocol(): 'ws' | 'wss' {
    return this._protocol
  }

  /** Number of currently connected (handshake-completed) clients. */
  getConnectedClientCount(): number {
    return this.clients.size
  }

  // -------------------------------------------------------------------------
  // RpcServer interface
  // -------------------------------------------------------------------------

  handle<Arguments extends unknown[]>(channel: string, handler: HandlerFn<Arguments>): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Handler already registered for channel: ${channel}`)
    }
    this.handlers.set(channel, handler)
  }

  push(channel: string, target: PushTarget, ...args: unknown[]): void {
    if (this.clients.size === 0 && this.disconnectedClients.size === 0) return
    const timestamp = Date.now()

    if (target.to === 'client') {
      const activeClient = this.clients.get(target.clientId)
      if (activeClient) {
        this.bufferAndMaybeSendEvent(activeClient, channel, args, timestamp, true)
        return
      }
      const disconnectedEntry = this.disconnectedClients.get(target.clientId)
      if (disconnectedEntry) {
        this.bufferAndMaybeSendEvent(disconnectedEntry.client, channel, args, timestamp, false)
      }
      return
    }

    for (const client of this.clients.values()) {
      if (!this.matchesTarget(client, target)) continue
      this.bufferAndMaybeSendEvent(client, channel, args, timestamp, true)
    }

    for (const { client } of this.disconnectedClients.values()) {
      if (!this.matchesTarget(client, target)) continue
      this.bufferAndMaybeSendEvent(client, channel, args, timestamp, false)
    }
  }

  hasClientCapability(clientId: string, capability: string): boolean {
    const client = this.clients.get(clientId)
    return !!client && client.capabilities.has(capability)
  }

  findClientsWithCapability(capability: string, opts?: { workspaceId?: string }): string[] {
    const results: string[] = []
    for (const [clientId, client] of this.clients) {
      if (!client.capabilities.has(capability)) continue
      if (opts?.workspaceId !== undefined && client.workspaceId !== opts.workspaceId) continue
      results.push(clientId)
    }
    return results
  }

  invokeClient(clientId: string, channel: string, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const client = this.clients.get(clientId)

      // Check connection
      if (!client) {
        const err: Error & { code?: string } = new Error(`Client not connected: ${clientId}`)
        ;err.code = 'CLIENT_DISCONNECTED'
        reject(err)
        return
      }

      // Check capability
      if (!client.capabilities.has(channel)) {
        const err: Error & { code?: string } = new Error(`Client lacks capability: ${channel}`)
        ;err.code = 'CAPABILITY_UNAVAILABLE'
        reject(err)
        return
      }

      const id = randomUUID()
      const timeout = setTimeout(() => {
        this.pendingInvokes.delete(id)
        const err: Error & { code?: string } = new Error(`Client request timeout: ${channel} (30000ms)`)
        ;err.code = 'CLIENT_REQUEST_TIMEOUT'
        reject(err)
      }, 30_000)

      this.pendingInvokes.set(id, { clientId, resolve, reject, timeout })

      const envelope: MessageEnvelope = {
        id,
        type: 'request',
        channel,
        args,
        serverId: this.serverId,
      }
      this.safeSend(client.ws, serializeEnvelope(envelope))
    })
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private configureNodeHttpTimeouts(server: HttpServer | HttpsServer): void {
    server.headersTimeout = 15_000
    server.requestTimeout = 60_000
    server.keepAliveTimeout = 5_000
    server.maxHeadersCount = 100
  }

  private isHandshakeIpRateLimited(ip: string): boolean {
    if (this.maxFailedHandshakesPerIp <= 0) return false
    const entry = this.failedHandshakesByIp.get(ip)
    if (!entry) return false
    if (Date.now() - entry.windowStart > 60_000) {
      this.failedHandshakesByIp.delete(ip)
      return false
    }
    return entry.count >= this.maxFailedHandshakesPerIp
  }

  private recordFailedHandshake(ip: string): void {
    if (this.maxFailedHandshakesPerIp <= 0) return
    const now = Date.now()
    const existing = this.failedHandshakesByIp.get(ip)
    if (!existing || now - existing.windowStart > 60_000) {
      if (!existing && this.failedHandshakesByIp.size >= 4096) {
        const oldestKey = this.failedHandshakesByIp.keys().next().value
        if (oldestKey !== undefined) this.failedHandshakesByIp.delete(oldestKey)
      }
      this.failedHandshakesByIp.set(ip, { count: 1, windowStart: now })
      return
    }
    existing.count += 1
  }

  async listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.tlsOptions) {
        // TLS mode: create HTTPS server, attach WebSocketServer to it.
        // When httpHandler is set, regular HTTP requests are served by it
        // (e.g. WebUI), while ws intercepts WebSocket upgrade requests.
        this._protocol = 'wss'
        this.httpsServer = createHttpsServer(
          {
            cert: this.tlsOptions.cert,
            key: this.tlsOptions.key,
            ca: this.tlsOptions.ca,
            // A client CA is an authentication requirement, not just a trust hint.
            requestCert: this.tlsOptions.ca !== undefined,
            rejectUnauthorized: true,
            passphrase: this.tlsOptions.passphrase,
          },
          this.httpHandler,
        )
        this.configureNodeHttpTimeouts(this.httpsServer)

        this.wss = new WebSocketServer({
          server: this.httpsServer,
          perMessageDeflate: false,
          maxPayload: this.maxPayloadBytes,
        })

        this.httpsServer.on('error', (err) => reject(err))

        this.httpsServer.listen(this.requestedPort, this.host, () => {
          const addr = this.httpsServer!.address()
          if (typeof addr === 'object' && addr) {
            this._port = addr.port
          }
          this.startHeartbeat()
          resolve()
        })
      } else if (this.httpHandler) {
        // Plain WS + HTTP handler: create an HTTP server for both.
        this._protocol = 'ws'
        this.httpServer = createHttpServer(this.httpHandler)
        this.configureNodeHttpTimeouts(this.httpServer)
        this.wss = new WebSocketServer({
          server: this.httpServer,
          perMessageDeflate: false,
          maxPayload: this.maxPayloadBytes,
        })

        this.httpServer.on('error', (err) => reject(err))

        this.httpServer.listen(this.requestedPort, this.host, () => {
          const addr = this.httpServer!.address()
          if (typeof addr === 'object' && addr) {
            this._port = addr.port
          }
          this.startHeartbeat()
          resolve()
        })
      } else {
        // Plain WS mode, no HTTP handler
        this._protocol = 'ws'
        this.wss = new WebSocketServer({
          host: this.host,
          port: this.requestedPort,
          perMessageDeflate: false,
          maxPayload: this.maxPayloadBytes,
        })

        this.wss.on('listening', () => {
          const addr = this.wss!.address()
          if (typeof addr === 'object' && addr) {
            this._port = addr.port
          }
          this.startHeartbeat()
          resolve()
        })

        this.wss.on('error', (err) => {
          reject(err)
        })
      }

      this.wss.on('connection', (ws, req) => {
        this.onConnection(
          ws,
          req.headers.cookie ?? null,
          req.headers.origin ?? null,
          req.headers.host ?? null,
          req.socket?.remoteAddress ?? 'direct',
        )
      })
    })
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    // Reject all pending invokes before tearing down connections
    for (const [id, pending] of this.pendingInvokes) {
      clearTimeout(pending.timeout)
      const err: Error & { code?: string } = new Error('Server shutting down')
      ;err.code = 'CLIENT_DISCONNECTED'
      pending.reject(err)
      this.pendingInvokes.delete(id)
    }
    for (const client of this.clients.values()) {
      client.ws.terminate()
    }
    this.clients.clear()
    // Clean up disconnected client timers
    for (const entry of this.disconnectedClients.values()) {
      clearTimeout(entry.timer)
    }
    this.disconnectedClients.clear()
    this.wss?.close()
    this.wss = null
    this.httpServer?.close()
    this.httpServer = null
    this.httpsServer?.close()
    this.httpsServer = null
  }

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  private onConnection(
    ws: WebSocket,
    upgradeRequestCookie: string | null,
    upgradeRequestOrigin: string | null,
    upgradeRequestHost: string | null,
    remoteAddress = 'direct',
  ): void {
    // Reject if at capacity
    if (this.maxClients > 0 && this.clients.size >= this.maxClients) {
      transportLog.warn('Connection rejected: at capacity', {
        maxClients: this.maxClients,
        current: this.clients.size,
      })
      ws.close(4008, 'Server at capacity')
      return
    }

    if (this.requireAuth && this.isHandshakeIpRateLimited(remoteAddress)) {
      transportLog.warn('Connection rejected: handshake auth rate limit exceeded', { remoteAddress })
      ws.close(4029, 'Too many authentication attempts')
      return
    }

    let handshakeCompleted = false
    let handshakeTimeout: ReturnType<typeof setTimeout> | null = null

    // Give the client 5 seconds to send a handshake
    handshakeTimeout = setTimeout(() => {
      if (!handshakeCompleted) {
        ws.close(4001, 'Handshake timeout')
      }
    }, 5_000)

    ws.on('message', async (raw) => {
      let envelope: MessageEnvelope
      try {
        envelope = deserializeEnvelope(raw.toString())
      } catch {
        ws.close(4002, 'Invalid JSON')
        return
      }

      if (!handshakeCompleted) {
        if (envelope.type !== 'handshake') {
          ws.close(4003, 'Expected handshake')
          return
        }

        if (handshakeTimeout) {
          clearTimeout(handshakeTimeout)
          handshakeTimeout = null
        }

        // Protocol version check (required)
        if (!envelope.protocolVersion || typeof envelope.protocolVersion !== 'string') {
          this.sendError(ws, envelope.id, 'PROTOCOL_VERSION_UNSUPPORTED',
            `Missing protocolVersion. Server protocol ${PROTOCOL_VERSION}`)
          ws.close(4004, 'Protocol version unsupported')
          return
        }

        const clientMajor = parseInt(envelope.protocolVersion.split('.')[0] ?? '0', 10)
        const serverMajor = parseInt(PROTOCOL_VERSION.split('.')[0] ?? '0', 10)
        if (clientMajor !== serverMajor) {
          this.sendError(ws, envelope.id, 'PROTOCOL_VERSION_UNSUPPORTED',
            `Server protocol ${PROTOCOL_VERSION}, client ${envelope.protocolVersion}`)
          ws.close(4004, 'Protocol version unsupported')
          return
        }

        const requestedWorkspaceId = envelope.workspaceId ?? null
        const requestedCapabilities = envelope.clientCapabilities ?? []
        let principal = localPrincipal()

        // Auth check — bearer token OR session cookie (web UI)
        if (this.requireAuth) {
          let authenticationResult: AuthenticationResult = false

          // 1. Try bearer token (standard path)
          if (envelope.token && this.validateToken) {
            try {
              authenticationResult = await this.validateToken(envelope.token)
            } catch (error) {
              transportLog.warn('Bearer token validation failed', {
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }

          // 2. Fallback: try session cookie from HTTP upgrade request (web UI path)
          if (
            authenticationResult === false
            && this.validateSessionCookie
            && upgradeRequestCookie
            && this.isSessionCookieOriginAllowed(upgradeRequestOrigin, upgradeRequestHost)
          ) {
            try {
              authenticationResult = await this.validateSessionCookie(upgradeRequestCookie)
            } catch (error) {
              transportLog.warn('Session cookie validation failed', {
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }

          const authoritativePrincipal = parseAuthenticatedPrincipal(authenticationResult)
          if (authoritativePrincipal) {
            principal = authoritativePrincipal
          } else if (authenticationResult === true && !this.requireAuthoritativePrincipal) {
            principal = legacyAuthenticatedPrincipal(requestedWorkspaceId, requestedCapabilities)
          } else {
            this.recordFailedHandshake(remoteAddress)
            const reason = envelope.token ? 'Invalid token' : 'Token required'
            this.sendError(ws, envelope.id, 'AUTH_FAILED', reason)
            ws.close(4005, 'Auth failed')
            return
          }

          if (!principalAllowsWorkspace(principal, requestedWorkspaceId)) {
            this.recordFailedHandshake(remoteAddress)
            this.sendError(ws, envelope.id, 'AUTH_FAILED', 'Workspace access denied')
            ws.close(4005, 'Auth failed')
            return
          }
        }

        const capabilities = authorizedCapabilities(principal, requestedCapabilities)

        // ── Reconnect attempt ──
        if (envelope.reconnectClientId && envelope.lastSeq != null) {
          const entry = this.disconnectedClients.get(envelope.reconnectClientId)
          if (entry) {
            const prevClient = entry.client

            // Identity must match the server-authorized actor and scope generation.
            const identityMatch =
              prevClient.workspaceId === requestedWorkspaceId &&
              prevClient.webContentsId === (envelope.webContentsId ?? null) &&
              prevClient.actorId === principal.actorId &&
              prevClient.authorizationGeneration === principal.authorizationGeneration

            if (identityMatch) {
              // Valid reconnect — prepare client state but do NOT add to
              // this.clients yet. The client stays in disconnectedClients
              // during replay so that push() can't interleave new events
              // between replayed ones. (Currently safe due to Node.js
              // single-threading, but this ordering makes the invariant
              // explicit and future-proof.)
              clearTimeout(entry.timer)

              prevClient.ws = ws
              prevClient.alive = true
              prevClient.missedPongs = 0
              prevClient.capabilities = capabilities
              prevClient.roles = [...principal.roles]
              prevClient.allowedWorkspaceIds = principal.allowedWorkspaceIds === '*'
                ? '*'
                : new Set(principal.allowedWorkspaceIds)
              handshakeCompleted = true

              // Determine replay vs stale using the per-client delivery sequence.
              // Retained buffers continue collecting events while the client is disconnected,
              // but TTL eviction still applies during the reconnect window.
              this.evictBuffer(prevClient)

              const lastSeq = envelope.lastSeq as number
              const hasMissedEvents = lastSeq < prevClient.lastSentSeq
              const firstBufferedSeq = prevClient.eventBuffer[0]?.seq
              const canReplay = !hasMissedEvents
                ? true
                : firstBufferedSeq != null && lastSeq >= firstBufferedSeq - 1

              if (canReplay) {
                const replayEvents = prevClient.eventBuffer.filter(e => e.seq > lastSeq)

                const ack: MessageEnvelope = {
                  id: envelope.id,
                  type: 'handshake_ack',
                  protocolVersion: PROTOCOL_VERSION,
                  serverVersion: this.serverVersion || undefined,
                  clientId: prevClient.id,
                  registeredChannels: [...this.handlers.keys()],
                  reconnected: true,
                }
                this.safeSend(ws, serializeEnvelope(ack))

                // Replay missed events in order
                for (const event of replayEvents) {
                  this.safeSend(ws, event.data)
                }

                transportLog.info('Client reconnected with replay', {
                  clientId: prevClient.id,
                  replayedCount: replayEvents.length,
                  lastSeq,
                })
              } else {
                // Buffer evicted — client must full-refresh
                const ack: MessageEnvelope = {
                  id: envelope.id,
                  type: 'handshake_ack',
                  protocolVersion: PROTOCOL_VERSION,
                  serverVersion: this.serverVersion || undefined,
                  clientId: prevClient.id,
                  registeredChannels: [...this.handlers.keys()],
                  reconnected: true,
                  stale: true,
                }
                this.safeSend(ws, serializeEnvelope(ack))

                transportLog.info('Client reconnected as stale', {
                  clientId: prevClient.id,
                  lastSeq,
                  firstBufferedSeq,
                  lastSentSeq: prevClient.lastSentSeq,
                })
              }

              // Atomic state transition: move from disconnected → active
              // AFTER replay is complete so push() can't target this client mid-replay.
              this.disconnectedClients.delete(envelope.reconnectClientId)
              this.clients.set(prevClient.id, prevClient)
              this.clientByWs.set(ws, prevClient)

              this.setupClientHandlers(ws, prevClient)
              this.onClientConnected?.({
                clientId: prevClient.id,
                webContentsId: prevClient.webContentsId,
                workspaceId: prevClient.workspaceId,
                capabilities: [...prevClient.capabilities],
                actorId: prevClient.actorId,
                roles: [...prevClient.roles],
                authorizationGeneration: prevClient.authorizationGeneration,
                allowedWorkspaceIds: prevClient.allowedWorkspaceIds === '*'
                  ? '*'
                  : [...prevClient.allowedWorkspaceIds],
              })
              return
            }

            // Identity mismatch — fall through to fresh connect
            transportLog.warn('Reconnect identity mismatch', {
              reconnectClientId: envelope.reconnectClientId,
            })
          }
          // reconnectClientId not found — fall through to fresh connect
        }

        // ── Normal fresh connect ──
        const clientId = randomUUID()
        const client: ClientConnection = {
          id: clientId,
          ws,
          workspaceId: requestedWorkspaceId,
          webContentsId: envelope.webContentsId ?? null,
          capabilities,
          actorId: principal.actorId,
          roles: [...principal.roles],
          authorizationGeneration: principal.authorizationGeneration,
          allowedWorkspaceIds: principal.allowedWorkspaceIds === '*'
            ? '*'
            : new Set(principal.allowedWorkspaceIds),
          missedPongs: 0,
          alive: true,
          eventBuffer: [],
          bufferedBytes: 0,
          inFlightRequests: 0,
          lastAckedSeq: 0,
          lastSentSeq: 0,
        }
        this.clients.set(clientId, client)
        this.clientByWs.set(ws, client)
        handshakeCompleted = true

        // Send handshake_ack
        const ack: MessageEnvelope = {
          id: envelope.id,
          type: 'handshake_ack',
          protocolVersion: PROTOCOL_VERSION,
          serverVersion: this.serverVersion || undefined,
          clientId,
          registeredChannels: [...this.handlers.keys()],
        }
        this.safeSend(ws, serializeEnvelope(ack))

        // Notify lifecycle listener
        transportLog.info('Client connected', {
          clientId,
          webContentsId: client.webContentsId,
          workspaceId: client.workspaceId,
        })
        this.onClientConnected?.({
          clientId,
          webContentsId: client.webContentsId,
          workspaceId: client.workspaceId,
          capabilities: [...client.capabilities],
          actorId: client.actorId,
          roles: [...client.roles],
          authorizationGeneration: client.authorizationGeneration,
          allowedWorkspaceIds: client.allowedWorkspaceIds === '*'
            ? '*'
            : [...client.allowedWorkspaceIds],
        })

        this.setupClientHandlers(ws, client)
        return
      }

      // Post-handshake: find the client for this ws
      const client = this.findClientByWs(ws)
      if (!client) {
        ws.close(4006, 'Unknown client')
        return
      }

      if (envelope.type === 'request') {
        await this.onRequest(client, envelope)
      } else if (envelope.type === 'response') {
        this.onClientResponse(client, envelope)
      } else if (envelope.type === 'sequence_ack') {
        const ackSeq = envelope.lastSeq
        if (typeof ackSeq === 'number' && ackSeq > client.lastAckedSeq) {
          client.lastAckedSeq = ackSeq
          // Evict acknowledged events
          const buf = client.eventBuffer
          let removeCount = 0
          let removedBytes = 0
          while (removeCount < buf.length && buf[removeCount]!.seq <= ackSeq) {
            removedBytes += buf[removeCount]!.bytes
            removeCount++
          }
          if (removeCount > 0) {
            buf.splice(0, removeCount)
            client.bufferedBytes = Math.max(0, client.bufferedBytes - removedBytes)
          }
        }
      }
    })

    ws.on('error', () => {
      // Connection errors are handled by the close event
    })
  }

  private isSessionCookieOriginAllowed(origin: string | null, host: string | null): boolean {
    if (!origin) return false
    try {
      const normalizedOrigin = new URL(origin).origin
      if (this.allowedSessionCookieOrigins.size > 0) {
        return this.allowedSessionCookieOrigins.has(normalizedOrigin)
      }
      if (!host) return false
      const expectedProtocol = this.tlsOptions ? 'https' : 'http'
      return normalizedOrigin === new URL(`${expectedProtocol}://${host}`).origin
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // Request dispatching
  // -------------------------------------------------------------------------

  /** Server-side timeout for RPC handler execution (ms). */
  private static readonly HANDLER_TIMEOUT_MS = 60_000

  private async onRequest(client: ClientConnection, envelope: MessageEnvelope): Promise<void> {
    const { channel, id, args } = envelope

    if (!channel) {
      this.sendResponseError(client.ws, id, undefined, 'CHANNEL_NOT_FOUND', 'Missing channel')
      return
    }

    const handler = this.handlers.get(channel)
    if (!handler) {
      this.sendResponseError(client.ws, id, channel, 'CHANNEL_NOT_FOUND', `No handler for: ${channel}`)
      return
    }

    if (
      this.maxInFlightRequestsPerClient > 0
      && client.inFlightRequests >= this.maxInFlightRequestsPerClient
    ) {
      this.sendResponseError(
        client.ws,
        id,
        channel,
        'HANDLER_ERROR',
        `Too many concurrent in-flight requests (max ${this.maxInFlightRequestsPerClient})`,
      )
      return
    }

    const ctx: RequestContext = {
      clientId: client.id,
      workspaceId: client.workspaceId,
      webContentsId: client.webContentsId,
      actorId: client.actorId,
      roles: client.roles,
      authorizationGeneration: client.authorizationGeneration,
      allowedWorkspaceIds: client.allowedWorkspaceIds === '*'
        ? '*'
        : [...client.allowedWorkspaceIds],
    }

    client.inFlightRequests += 1
    try {
      if (this.authorizeRequest && !await this.authorizeRequest(ctx, channel, args ?? [])) {
        this.sendResponseError(client.ws, id, channel, 'AUTH_FAILED', `RPC channel denied: ${channel}`)
        return
      }
      const result: unknown = await Promise.race([
        Reflect.apply(handler, undefined, [ctx, ...(args ?? [])]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Handler timeout: ${channel} (${WsRpcServer.HANDLER_TIMEOUT_MS}ms)`)),
            WsRpcServer.HANDLER_TIMEOUT_MS),
        ),
      ])
      const response: MessageEnvelope = {
        id,
        type: 'response',
        channel,
        result,
      }
      this.safeSend(client.ws, serializeEnvelope(response))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const rawCode = (err as { code?: unknown } | null)?.code
      const code: ErrorCode = isErrorCode(rawCode) ? rawCode : 'HANDLER_ERROR'
      this.sendResponseError(client.ws, id, channel, code, message)
    } finally {
      client.inFlightRequests = Math.max(0, client.inFlightRequests - 1)
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now()
      for (const [ip, entry] of this.failedHandshakesByIp.entries()) {
        if (now - entry.windowStart > 60_000) {
          this.failedHandshakesByIp.delete(ip)
        }
      }

      for (const [, client] of this.clients) {
        // Skip sockets that are already closing/closed (e.g. terminated on a previous tick)
        if (client.ws.readyState !== client.ws.OPEN) continue

        if (!client.alive) {
          client.missedPongs++
          if (client.missedPongs >= HEARTBEAT_MAX_MISSED) {
            // Let the close handler (setupClientHandlers) handle all cleanup:
            // clients.delete, buffer retention for reconnect, onClientDisconnected.
            client.ws.terminate()
            continue
          }
        }
        client.alive = false
        client.ws.ping()
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Wire up close + pong handlers for a WebSocket ↔ ClientConnection pair. */
  private setupClientHandlers(ws: WebSocket, client: ClientConnection): void {
    ws.on('close', () => {
      transportLog.info('Client disconnected', { clientId: client.id })
      this.clients.delete(client.id)

      if (!client.revoked) {
        // Retain buffer for potential reconnect
        const timer = setTimeout(() => {
          this.disconnectedClients.delete(client.id)
        }, DISCONNECTED_CLIENT_TTL_MS)
        this.disconnectedClients.set(client.id, { client, timer })

        // Cap disconnectedClients to prevent unbounded growth
        if (this.disconnectedClients.size > 50) {
          const oldestKey = this.disconnectedClients.keys().next().value
          if (oldestKey) {
            const oldest = this.disconnectedClients.get(oldestKey)
            if (oldest) clearTimeout(oldest.timer)
            this.disconnectedClients.delete(oldestKey)
          }
        }
      }

      this.rejectPendingInvokesForClient(client.id)
      this.onClientDisconnected?.(client.id)
    })

    ws.on('pong', () => {
      client.alive = true
      client.missedPongs = 0
    })
  }

  /** Assign a per-client seq, retain the event for replay, and optionally send it immediately. */
  private bufferAndMaybeSendEvent(
    client: ClientConnection,
    channel: string,
    args: unknown[],
    timestamp: number,
    shouldSend: boolean,
  ): void {
    client.lastSentSeq += 1
    const seq = client.lastSentSeq

    const envelope: MessageEnvelope = {
      id: randomUUID(),
      type: 'event',
      channel,
      args,
      serverId: this.serverId,
      seq,
    }

    const data = serializeEnvelope(envelope)
    const bytes = Buffer.byteLength(data, 'utf8')
    client.eventBuffer.push({ seq, data, bytes, timestamp })
    client.bufferedBytes += bytes
    this.evictBuffer(client)

    if (shouldSend) {
      this.safeSend(client.ws, data)
    }
  }

  /** Evict stale/oversized entries from a client's event buffer via batch splice. */
  private evictBuffer(client: ClientConnection): void {
    const buf = client.eventBuffer
    if (buf.length === 0) return

    const now = Date.now()
    let removeCount = 0
    let removedBytes = 0

    // Evict by TTL
    while (removeCount < buf.length &&
           now - buf[removeCount]!.timestamp > EVENT_BUFFER_TTL_MS) {
      removedBytes += buf[removeCount]!.bytes
      removeCount++
    }

    // Evict by count (keep at most EVENT_BUFFER_MAX_SIZE after TTL eviction)
    const remaining = buf.length - removeCount
    if (remaining > EVENT_BUFFER_MAX_SIZE) {
      const extra = remaining - EVENT_BUFFER_MAX_SIZE
      for (let i = 0; i < extra; i++) {
        removedBytes += buf[removeCount + i]!.bytes
      }
      removeCount += extra
    }

    // Evict by byte cap (keep at least the newest event if single event exceeds cap)
    if (this.maxEventBufferBytes > 0) {
      while (
        removeCount < buf.length - 1 &&
        client.bufferedBytes - removedBytes > this.maxEventBufferBytes
      ) {
        removedBytes += buf[removeCount]!.bytes
        removeCount++
      }
    }

    // Single splice instead of O(n) shift loop
    if (removeCount > 0) {
      buf.splice(0, removeCount)
      client.bufferedBytes = Math.max(0, client.bufferedBytes - removedBytes)
    }
  }

  private matchesTarget(client: ClientConnection, target: PushTarget): boolean {
    switch (target.to) {
      case 'all':
        return target.exclude ? client.id !== target.exclude : true
      case 'workspace':
        if (target.exclude && client.id === target.exclude) return false
        return client.workspaceId === target.workspaceId
      case 'client':
        return client.id === target.clientId
      default:
        return false
    }
  }

  /** Update a client's workspaceId (called after SWITCH_WORKSPACE so push routing stays correct). */
  updateClientWorkspace(clientId: string, workspaceId: string): void {
    const client = this.clients.get(clientId)
    if (client) {
      if (client.allowedWorkspaceIds !== '*' && !client.allowedWorkspaceIds.has(workspaceId)) {
        throw new Error(`Workspace access denied for \"${workspaceId}\"`)
      }
      client.workspaceId = workspaceId
    }
  }

  /** Close every active connection for an actor whose authorization was revoked. */
  disconnectClientsByActor(actorId: string): number {
    for (const [id, entry] of this.disconnectedClients.entries()) {
      if (entry.client.actorId !== actorId) continue
      clearTimeout(entry.timer)
      entry.client.eventBuffer.length = 0
      entry.client.bufferedBytes = 0
      this.disconnectedClients.delete(id)
    }

    let disconnected = 0
    for (const client of this.clients.values()) {
      if (client.actorId !== actorId) continue
      disconnected++
      client.revoked = true
      client.eventBuffer.length = 0
      client.bufferedBytes = 0
      this.clients.delete(client.id)
      this.clientByWs.delete(client.ws)
      this.rejectPendingInvokesForClient(client.id)
      client.ws.close(4005, 'Authorization revoked')
    }
    return disconnected
  }

  private findClientByWs(ws: WebSocket): ClientConnection | undefined {
    const fast = this.clientByWs.get(ws)
    if (fast && this.clients.has(fast.id)) return fast
    for (const client of this.clients.values()) {
      if (client.ws === ws) {
        this.clientByWs.set(ws, client)
        return client
      }
    }
    return undefined
  }

  /** Handler/request errors — sent as type:'response' with error field. */
  private sendResponseError(
    ws: WebSocket, id: string, channel: string | undefined,
    code: ErrorCode, message: string,
  ): void {
    const envelope: MessageEnvelope = {
      id,
      type: 'response',
      channel,
      error: { code, message },
    }
    this.safeSend(ws, serializeEnvelope(envelope))
  }

  /** Protocol-level errors only (handshake rejection, version mismatch). May close connection. */
  private sendError(ws: WebSocket, id: string, code: ErrorCode, message: string): void {
    const envelope: MessageEnvelope = {
      id,
      type: 'error',
      error: { code, message },
    }
    this.safeSend(ws, serializeEnvelope(envelope))
  }

  private onClientResponse(client: ClientConnection, envelope: MessageEnvelope): void {
    const pending = this.pendingInvokes.get(envelope.id)
    if (!pending) return
    if (pending.clientId !== client.id) {
      transportLog.warn('Ignored spoofed client response for pending invoke', {
        invokeId: envelope.id,
        expectedClientId: pending.clientId,
        actualClientId: client.id,
      })
      return
    }

    this.pendingInvokes.delete(envelope.id)
    clearTimeout(pending.timeout)

    if (envelope.error) {
      const err: Error & { code?: string; data?: unknown } = new Error(envelope.error.message)
      ;err.code = envelope.error.code
      ;err.data = envelope.error.data
      pending.reject(err)
    } else {
      pending.resolve(envelope.result)
    }
  }

  private rejectPendingInvokesForClient(clientId: string): void {
    for (const [id, pending] of this.pendingInvokes) {
      if (pending.clientId !== clientId) continue
      clearTimeout(pending.timeout)
      const err: Error & { code?: string } = new Error(`Client disconnected: ${clientId}`)
      ;err.code = 'CLIENT_DISCONNECTED'
      pending.reject(err)
      this.pendingInvokes.delete(id)
    }
  }

  private safeSend(ws: WebSocket, data: string): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(data)
    }
  }
}
