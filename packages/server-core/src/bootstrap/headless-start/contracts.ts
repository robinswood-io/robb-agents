import { OAuthFlowStore } from "@craft-agent/shared/auth";
import { WsRpcServer, type WsRpcServerOptions, type WsRpcTlsOptions } from "../../transport/server";
import type { EventSink, RpcServer, AuthenticationResult, ConnectedClientInfo } from "../../transport/types";
import type { PlatformServices } from "../../runtime/platform";

interface ModelRefreshServiceLike {
  startAll(): void
  stopAll?(): void
}

export interface ServerBootstrapOptions<TSessionManager, THandlerDeps> {
  serverToken?: string
  rpcHost?: string
  rpcPort?: number
  bundledAssetsRoot?: string
  platformFactory?: () => PlatformServices
  applyPlatformToSubsystems?: (platform: PlatformServices) => void
  createSessionManager: () => TSessionManager
  createHandlerDeps: (ctx: {
    sessionManager: TSessionManager
    platform: PlatformServices
    oauthFlowStore: OAuthFlowStore
  }) => THandlerDeps
  registerAllRpcHandlers: (server: RpcServer, deps: THandlerDeps, serverCtx: ServerHandlerContext) => void
  initializeSessionManager: (sessionManager: TSessionManager) => Promise<void>
  setSessionEventSink: (sessionManager: TSessionManager, sink: EventSink) => void
  /**
   * Optional hook called right after the WS RPC server starts listening. Use
   * this to plumb the server into the SessionManager (e.g. `sm.setRpcServer(server)`)
   * so the remote-bridge code path for `client:browser:invoke` activates.
   */
  bindRpcServer?: (sessionManager: TSessionManager, server: RpcServer) => void
  initModelRefreshService: () => ModelRefreshServiceLike
  cleanupSessionManager?: (sessionManager: TSessionManager) => Promise<void> | void
  cleanupClientResources?: (clientId: string) => void
  onClientConnected?: (info: ConnectedClientInfo) => void
  serverId?: string
  /** App version string, included in handshake_ack for client compatibility checks. */
  serverVersion?: string
  /** TLS configuration. When provided, the server listens on wss:// instead of ws://. */
  tls?: WsRpcTlsOptions
  /** Cookie-based session validator for web UI auth on WebSocket upgrade. */
  validateSessionCookie?: (cookieHeader: string | null) => Promise<AuthenticationResult>
  /** Browser origins allowed to use cookie-authenticated WebSocket upgrades. */
  allowedSessionCookieOrigins?: readonly string[]
  /** Authoritative per-channel request authorization. */
  authorizeRequest?: WsRpcServerOptions['authorizeRequest']
  /**
   * Optional HTTP request handler for non-WebSocket requests on the RPC port.
   * When provided, the WsRpcServer serves HTTP (e.g. WebUI) on the same port.
   */
  httpHandler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
}

export interface ServerHandlerContext {
  getConnectedClientCount: () => number
  serverId: string
  startedAt: number
}

export interface ServerInstance<TSessionManager> {
  platform: PlatformServices
  sessionManager: TSessionManager
  wsServer: WsRpcServer
  oauthFlowStore: OAuthFlowStore
  host: string
  port: number
  protocol: 'ws' | 'wss'
  token: string
  /** Context for server-level RPC handlers (status, health, active sessions). */
  serverHandlerContext: ServerHandlerContext
  stop: () => Promise<void>
}
