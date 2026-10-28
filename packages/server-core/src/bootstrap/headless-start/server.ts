import type { WsRpcServerOptions } from '../../transport/server/shared.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { OAuthFlowStore } from "@craft-agent/shared/auth";
import { ensureConfigDir, loadStoredConfig, saveConfig } from "@craft-agent/shared/config";
import { CONFIG_DIR } from "@craft-agent/shared/config/paths";
import { setBundledAssetsRoot } from "@craft-agent/shared/utils";
import { shutdownLongRunningProcessSupervisor, startLongRunningProcessSupervisor } from "@craft-agent/shared/processes";
import { WsRpcServer } from "../../transport/server";
import type { AuthenticatedPrincipal } from "../../transport/types";
import { createHeadlessPlatform } from "../../runtime/platform-headless";
import type { PlatformServices } from "../../runtime/platform";
import type { ServerBootstrapOptions, ServerHandlerContext, ServerInstance } from './contracts.ts';
import { acquireServerLock, releaseServerLock, validateTokenEntropy } from './server-identity.ts';

// ---------------------------------------------------------------------------
// Config artifacts
// ---------------------------------------------------------------------------

function bootstrapConfigArtifacts(platform: PlatformServices): void {
  ensureConfigDir()
  platform.logger.info('[bootstrap] Config artifacts initialized')
}

function ensureGlobalConfigExists(platform: PlatformServices): void {
  const config = loadStoredConfig()
  if (config) {
    platform.logger.info('[bootstrap] Global config found')
    return
  }

  saveConfig({
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  })
  platform.logger.info('[bootstrap] Initialized missing global config')
}

export async function bootstrapServer<TSessionManager, THandlerDeps>(
  options: ServerBootstrapOptions<TSessionManager, THandlerDeps>,
): Promise<ServerInstance<TSessionManager>> {
  const serverToken = options.serverToken ?? process.env["CRAFT_SERVER_TOKEN"]
  if (!serverToken) {
    throw new Error('Server token is required. Pass options.serverToken or set CRAFT_SERVER_TOKEN.')
  }

  const entropy = validateTokenEntropy(serverToken)
  if (!entropy.ok) {
    throw new Error(`Weak server token: ${entropy.error}`)
  }

  const platform = options.platformFactory?.() ?? createHeadlessPlatform(omitUndefined({ appVersion: options.serverVersion }))

  const bundledAssetsRoot = options.bundledAssetsRoot
    ?? process.env["CRAFT_BUNDLED_ASSETS_ROOT"]
    ?? process.cwd()
  setBundledAssetsRoot(bundledAssetsRoot)

  if (entropy.warning) {
    platform.logger.warn(`[bootstrap] ${entropy.warning}`)
  }

  options.applyPlatformToSubsystems?.(platform)

  bootstrapConfigArtifacts(platform)
  ensureGlobalConfigExists(platform)
  acquireServerLock(platform.logger)

  const modelRefreshService = options.initModelRefreshService()
  const sessionManager = options.createSessionManager()

  const rpcHost = options.rpcHost ?? process.env["CRAFT_RPC_HOST"] ?? '127.0.0.1'
  const rpcPortRaw = options.rpcPort ?? parseInt(process.env["CRAFT_RPC_PORT"] ?? '9100', 10)
  if (!Number.isFinite(rpcPortRaw) || rpcPortRaw < 0 || rpcPortRaw > 65535) {
    throw new Error(`Invalid RPC port: ${rpcPortRaw}`)
  }
  const rpcPort = Math.trunc(rpcPortRaw)
  const serverOwnerPrincipal: AuthenticatedPrincipal = {
    actorId: 'local-owner',
    allowedWorkspaceIds: '*',
    capabilities: '*',
    roles: ['owner'],
    authorizationGeneration: 0,
  }

  const expectedTokenDigest = createHash('sha256').update(serverToken).digest()
  const wsServer = new WsRpcServer(omitUndefined<WsRpcServerOptions>({
    host: rpcHost,
    port: rpcPort,
    requireAuth: true,
    requireAuthoritativePrincipal: true,
    validateToken: async (t) => {
      if (typeof t !== 'string' || t.length === 0) return false
      const actualDigest = createHash('sha256').update(t).digest()
      return timingSafeEqual(actualDigest, expectedTokenDigest) ? serverOwnerPrincipal : false
    },
    validateSessionCookie: options.validateSessionCookie,
    allowedSessionCookieOrigins: options.allowedSessionCookieOrigins,
    authorizeRequest: options.authorizeRequest,
    serverId: options.serverId ?? 'headless',
    serverVersion: options.serverVersion,
    tls: options.tls,
    httpHandler: options.httpHandler,
    onClientConnected: options.onClientConnected,
    onClientDisconnected: (clientId) => {
      options.cleanupClientResources?.(clientId)
      // Best-effort: notify SM so it can drop browser-host pins for this client.
      // Duck-typed because TSessionManager is generic at the bootstrap layer.
      const smWithDisconnect = sessionManager as { onClientDisconnected?: (id: string) => void }
      if (typeof smWithDisconnect.onClientDisconnected === 'function') {
        try {
          smWithDisconnect.onClientDisconnected(clientId)
        } catch {
          // Cleanup hook failures must not break the transport.
        }
      }
    },
  }))

  try {
    await wsServer.listen()
  } catch (error) {
    releaseServerLock()
    throw error
  }
  startLongRunningProcessSupervisor({
    healthReportPath: process.env["CRAFT_HEALTH_REPORT_PATH"]
      ?? join(CONFIG_DIR, 'health', 'long-running.json'),
  })

  options.bindRpcServer?.(sessionManager, wsServer)

  const oauthFlowStore = new OAuthFlowStore()

  const deps = options.createHandlerDeps({
    sessionManager,
    platform,
    oauthFlowStore,
  })

  const startedAt = Date.now()
  const serverHandlerContext: ServerHandlerContext = {
    getConnectedClientCount: () => wsServer.getConnectedClientCount(),
    serverId: options.serverId ?? 'headless',
    startedAt,
  }

  options.registerAllRpcHandlers(wsServer, deps, serverHandlerContext)

  options.setSessionEventSink(sessionManager, wsServer.push.bind(wsServer))

  try {
    await options.initializeSessionManager(sessionManager)
    modelRefreshService.startAll()
  } catch (error) {
    try { wsServer.close() } catch { /* best-effort startup rollback */ }
    try { oauthFlowStore.dispose() } catch { /* best-effort startup rollback */ }
    shutdownLongRunningProcessSupervisor('server startup failed')
    releaseServerLock()
    throw error
  }

  platform.logger.info(`Craft Agent server listening on ${wsServer.protocol}://${rpcHost}:${wsServer.port}`)

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true

    platform.logger.info('Shutting down...')

    // Notify connected clients before closing connections
    try {
      wsServer.push('server:shuttingDown', { to: 'all' }, {
        reason: 'shutdown',
        graceMs: 2000,
        timestamp: Date.now(),
      })
      // Brief drain period so clients receive the notification
      await new Promise(resolve => setTimeout(resolve, 2000))
    } catch (error) {
      platform.logger.error('[bootstrap] Failed to send shutdown notification:', error)
    }

    try {
      modelRefreshService.stopAll?.()
    } catch (error) {
      platform.logger.error('[bootstrap] Failed to stop model refresh service:', error)
    }

    try {
      await options.cleanupSessionManager?.(sessionManager)
    } catch (error) {
      platform.logger.error('[bootstrap] Failed to clean up session manager:', error)
    }

    try {
      wsServer.close()
    } catch (error) {
      platform.logger.error('[bootstrap] Failed to close WS server:', error)
    }

    try {
      oauthFlowStore.dispose()
    } catch (error) {
      platform.logger.error('[bootstrap] Failed to dispose OAuth flow store:', error)
    }

    shutdownLongRunningProcessSupervisor('server shutdown')

    releaseServerLock()
  }

  return {
    platform,
    sessionManager,
    wsServer,
    oauthFlowStore,
    host: rpcHost,
    port: wsServer.port,
    protocol: wsServer.protocol,
    token: serverToken,
    serverHandlerContext,
    stop,
  }
}

// ---------------------------------------------------------------------------
// HTTP Health Endpoint (opt-in, for load balancers / k8s probes)
// ---------------------------------------------------------------------------

export interface HealthHttpServerOptions {
  port: number
  host?: string
  deps: { sessionManager: { getWorkspaces(): unknown[] } }
  wsServer: WsRpcServer
  platform: PlatformServices
}

/**
 * Start a minimal HTTP server for health/status probes.
 * Only starts if port > 0. Returns a cleanup function.
 */
export async function startHealthHttpServer(options: HealthHttpServerOptions): Promise<{ stop: () => void } | null> {
  if (options.port <= 0) return null

  const bindHost = options.host ?? process.env["CRAFT_HEALTH_HOST"] ?? '127.0.0.1'

  // Dynamic import — getHealthCheck uses HandlerDeps shape
  const { getHealthCheck } = await import("../../handlers/rpc/server")

  // Use Bun.serve if available, otherwise skip (Node.js/Electron doesn't need HTTP health)
  if (typeof globalThis.Bun !== 'undefined') {
    const server = Bun.serve({
      hostname: bindHost,
      port: options.port,
      fetch(req: Request) {
        const path = new URL(req.url).pathname
        if (path === '/health') {
          const health = getHealthCheck({ sessionManager: options.deps.sessionManager })
          return Response.json(health, {
            status: health.status === 'ok' ? 200 : 503,
          })
        }
        return new Response('Not Found', { status: 404 })
      },
    })

    options.platform.logger.info(`[bootstrap] Health endpoint listening on http://${bindHost}:${options.port}/health`)

    return {
      stop: () => server.stop(),
    }
  }

  return null
}
