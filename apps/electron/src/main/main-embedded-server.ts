import type { ServerBootstrapOptions } from '../../../../packages/server-core/src/bootstrap/headless-start/contracts.ts';
import type { ServerConfig } from '../../../../packages/shared/src/config/server-config.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import { registerEmbeddedServerHandlers } from './main-embedded-handlers';
import { app } from 'electron';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import * as Sentry from '@sentry/electron/main';

import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

import { SessionManager, setSessionPlatform, setSessionRuntimeHooks } from '@craft-agent/server-core/sessions';
import { registerAllRpcHandlers } from './handlers/index';
import { registerCoreRpcHandlers, cleanupSessionFileWatchForClient } from '@craft-agent/server-core/handlers/rpc';
import type { PlatformServices } from '../runtime/platform';

import type { HandlerDeps } from './handlers/handler-deps';
import { bootstrapServer } from '@craft-agent/server-core/bootstrap';
import { createMessagingBootstrap } from '@craft-agent/messaging-gateway';
import { getCredentialManager } from '@craft-agent/shared/credentials';
import { initModelRefreshService, setFetcherPlatform } from '@craft-agent/server-core/model-fetchers';
import { setSearchPlatform, setImageProcessor } from '@craft-agent/server-core/services';

import { CONFIG_DIR, getWorkspaces, getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { resolveAllowedSessionCookieOrigins, resolveSecureRemoteHost } from './remote-access-security';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';

import { mainLog, messagingGatewayLog } from './logger';
import { updateBadgeCount } from './notifications';

import { validateGitBashPath } from '@craft-agent/server-core/services';

import { createWebuiHandler, nodeHttpAdapter, RemoteDeviceRegistry, createWebuiRpcAuthorizer, validateSession } from '@craft-agent/server-core/webui';

import { mainState } from './main-state';

interface EmbeddedServerStartupInput {
  isClientOnly: boolean
  isHeadless: boolean
  platform: PlatformServices
}



export async function startEmbeddedServer({ isClientOnly, isHeadless, platform }: EmbeddedServerStartupInput): Promise<void> {
if (!isClientOnly) {
      // Restore persisted Git Bash path on Windows (must happen before any SDK subprocess spawn)
      if (process.platform === 'win32') {
        const { getGitBashPath, clearGitBashPath } = await import('@craft-agent/shared/config')
        const gitBashPath = getGitBashPath()
        if (gitBashPath) {
          const validation = await validateGitBashPath(gitBashPath)
          if (validation.valid) {
            process.env["CLAUDE_CODE_GIT_BASH_PATH"] = validation.path
          } else {
            clearGitBashPath()
            delete process.env["CLAUDE_CODE_GIT_BASH_PATH"]
            mainLog.warn(`Cleared invalid persisted Git Bash path: ${gitBashPath}`)
          }
        }
      }

      // Pre-import power manager (async import needed for applyPlatformToSubsystems)
      const { onSessionStarted, onSessionStopped } = await import('./power-manager')

      // Client ID tracking for Electron IPC bridge (webContentsId → clientId)
      const clientMap = new Map<number, string>()
      const resolveClientId = (wcId: number) => clientMap.get(wcId)

      // Read embedded server config (Server settings page)
      const {
        getServerConfig,
        normalizeServerConfigPublicUrls,
      } = await import('@craft-agent/shared/config')
      const persistedEmbeddedServerConfig = getServerConfig()
      let embeddedServerConfig = persistedEmbeddedServerConfig
      try {
        embeddedServerConfig = normalizeServerConfigPublicUrls(persistedEmbeddedServerConfig)
      } catch {
        // A manually edited or corrupted public endpoint must never be trusted
        // at startup. Keep the local app available and require the owner to
        // correct the persisted settings before Remote can start again.
        embeddedServerConfig = omitUndefined<ServerConfig>({
          ...persistedEmbeddedServerConfig,
          enabled: false,
          publicWebuiUrl: undefined,
          publicWsUrl: undefined,
        })
        mainLog.error('[server-mode] Invalid public Remote URL configuration; Remote access is disabled')
      }
      const serverModeEnabled = embeddedServerConfig.enabled && !isClientOnly

      // Derive host/port/token from server config (or env overrides)
      const serverToken = serverModeEnabled && embeddedServerConfig.token
        ? embeddedServerConfig.token
        : randomUUID()
      let rpcHost = process.env["CRAFT_RPC_HOST"]
        ?? (serverModeEnabled ? '0.0.0.0' : '127.0.0.1')
      const rpcPort = process.env["CRAFT_RPC_PORT"]
        ? parseInt(process.env["CRAFT_RPC_PORT"], 10)
        : (serverModeEnabled ? embeddedServerConfig.port : 0)

      // Load TLS certificates if configured
      let tls: import('@craft-agent/server-core/transport').WsRpcTlsOptions | undefined
      if (serverModeEnabled && embeddedServerConfig.tlsCertPath && embeddedServerConfig.tlsKeyPath) {
        try {
          tls = {
            cert: readFileSync(embeddedServerConfig.tlsCertPath),
            key: readFileSync(embeddedServerConfig.tlsKeyPath),
          }
          mainLog.info('[server-mode] TLS enabled')
        } catch (err) {
          mainLog.error('[server-mode] Failed to load TLS certificates:', err)
        }
      }

      const hasPublicReverseProxy = Boolean(
        embeddedServerConfig.publicWebuiUrl && embeddedServerConfig.publicWsUrl,
      )
      const hasSecureBrowserTransport = Boolean(tls) || hasPublicReverseProxy

      const secureHost = resolveSecureRemoteHost(rpcHost, Boolean(tls))
      if (secureHost.networkBindRejected) {
        if (hasPublicReverseProxy) {
          mainLog.info(
            '[server-mode] TLS terminates at the configured reverse proxy; restricting its plaintext upstream to 127.0.0.1.',
          )
        } else {
          mainLog.error(
            '[server-mode] TLS is unavailable; refusing the network bind and falling back to 127.0.0.1. ' +
            'Configure a certificate and private key, then restart to enable Remote access.'
          )
        }
      }
      rpcHost = secureHost.host

      if (serverModeEnabled) {
        mainLog.info(`[server-mode] Enabled — binding ${rpcHost}:${rpcPort}${tls ? ' (TLS)' : ''}`)
      }

      // Remote mobile UI is served by the embedded server itself. The phone
      // receives only a short-lived one-time ticket; the durable server token
      // never leaves the host UI or appears in the QR code.
      const webuiDir = app.isPackaged
        ? join(process.resourcesPath, 'app', 'webui')
        : join(process.cwd(), 'apps', 'webui', 'dist')
      const remoteDeviceRegistry = new RemoteDeviceRegistry({
        filePath: join(CONFIG_DIR, 'remote-devices.json'),
      })
      const authorizeWebuiRpcRequest = createWebuiRpcAuthorizer(remoteDeviceRegistry)
      let disconnectRemoteDevice: ((deviceId: string) => void) | null = null
      let webuiNodeHandler: ReturnType<typeof nodeHttpAdapter> | undefined

      if (serverModeEnabled && existsSync(webuiDir)) {
        mainState.embeddedWebuiHandler = createWebuiHandler({
          webuiDir,
          secret: serverToken,
          secureCookies: hasSecureBrowserTransport,
          ...(embeddedServerConfig.publicWebuiUrl !== undefined ? { publicWebuiUrl: embeddedServerConfig.publicWebuiUrl } : {}),
          ...(embeddedServerConfig.publicWsUrl !== undefined ? { publicWsUrl: embeddedServerConfig.publicWsUrl } : {}),
          ...(embeddedServerConfig.remoteAuthMode !== undefined ? { remoteAuthMode: embeddedServerConfig.remoteAuthMode } : {}),
          wsProtocol: tls ? 'wss' : 'ws',
          wsPort: rpcPort,
          hostLabel: hostname(),
          getHealthCheck: () => ({ status: mainState.sessionManager ? 'ok' : 'starting' }),
          logger: mainLog,
          remoteDeviceRegistry,
          getRemoteWorkspaceIds: () => getWorkspaces()
            .filter((workspace) => !workspace.remoteServer)
            .map((workspace) => workspace.id),
          onRemoteDeviceRevoked: (deviceId) => disconnectRemoteDevice?.(deviceId),
        })
        webuiNodeHandler = nodeHttpAdapter(mainState.embeddedWebuiHandler.fetch, {
          onError: (context) => {
            mainLog.error('[server-mode] Remote mobile UI request failed', context)
          },
        })
        mainLog.info(`[server-mode] Remote mobile UI enabled from ${webuiDir}`)
      } else if (serverModeEnabled) {
        mainLog.error(`[server-mode] Remote mobile UI assets are missing from ${webuiDir}`)
      }

      // Bootstrap the WS RPC server via shared bootstrap function.
      const instance = await bootstrapServer<SessionManager, HandlerDeps>(omitUndefined<ServerBootstrapOptions<SessionManager, HandlerDeps>>({
        serverToken,
        rpcHost,
        rpcPort,
        ...(tls !== undefined ? { tls: tls } : {}),
        validateSessionCookie: mainState.embeddedWebuiHandler && hasSecureBrowserTransport
          ? async (cookieHeader) => {
              const remoteSession = await validateSession(cookieHeader, serverToken)
              if (!remoteSession) return false
              if (remoteSession.kind === 'remote-device') {
                if (!remoteSession.deviceId) return false
                const device = remoteDeviceRegistry.authorize(
                  remoteSession.deviceId,
                  remoteSession.authorizationGeneration,
                )
                if (!device) return false
                return {
                  actorId: `remote-device:${remoteSession.deviceId}`,
                  allowedWorkspaceIds: device.allowedWorkspaceIds,
                  capabilities: [],
                  roles: ['remote-device'],
                  authorizationGeneration: device.authorizationGeneration,
                }
              }
              return {
                actorId: 'local-owner',
                allowedWorkspaceIds: '*',
                capabilities: '*',
                roles: ['owner'],
                authorizationGeneration: remoteSession.authorizationGeneration,
              }
            }
          : undefined,
        allowedSessionCookieOrigins: resolveAllowedSessionCookieOrigins(
          embeddedServerConfig.publicWebuiUrl,
        ),
        authorizeRequest: mainState.embeddedWebuiHandler ? authorizeWebuiRpcRequest : undefined,
        ...(webuiNodeHandler !== undefined ? { httpHandler: webuiNodeHandler } : {}),
        bundledAssetsRoot: __dirname,
        serverId: 'local',
        serverVersion: app.getVersion(),
        platformFactory: () => platform,
        applyPlatformToSubsystems: (p) => {
          setFetcherPlatform(p)
          setSessionPlatform(p)
          setSessionRuntimeHooks({
            updateBadgeCount,
            onSessionStarted,
            onSessionStopped,
            captureException: (error, context) => {
              if (process.env["ROBB_ENABLE_SENTRY"] !== '1') return
              Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
                tags: {
                  ...(context?.errorSource ? { errorSource: context.errorSource } : {}),
                  ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
                },
              })
            },
          })
          setSearchPlatform(p)
          setImageProcessor(p.imageProcessor)
        },
        createSessionManager: () => {
          const sm = new SessionManager()
          sm.setBrowserPaneManager(mainState.browserPaneManager!)
          return sm
        },
        bindRpcServer: (sm, server) => sm.setRpcServer(server),
        createHandlerDeps: ({ sessionManager: sm, platform: p, oauthFlowStore: ofs }) => {
          // The messaging handle is built here because it needs sessionManager.
          // The WS publisher is attached after bootstrapServer resolves (via
          // handle.setPublisher) because wsServer isn't available yet.
          mainState.messagingHandle = createMessagingBootstrap({
            sessionManager: sm,
            credentialManager: getCredentialManager(),
            getMessagingDir: (wsId: string) =>
              join(CONFIG_DIR, 'workspaces', wsId, 'messaging'),
            getLegacyMessagingDir: (wsId: string) => {
              const ws = getWorkspaces().find((w) => w.id === wsId)
              return ws ? join(ws.rootPath, 'messaging') : undefined
            },
            // Route messaging diagnostics through the dedicated messaging log
            // at ~/.craft-agent/logs/messaging-gateway.log.
            logger: messagingGatewayLog,
            // WhatsApp worker runs under Electron's embedded Node via
            // ELECTRON_RUN_AS_NODE (WhatsAppAdapter defaults nodeBin to
            // process.execPath). In dev we resolve worker.cjs from the
            // monorepo; in packaged builds it's shipped via extraResources
            // (see apps/electron/electron-builder.yml).
            whatsapp: {
              workerEntry: app.isPackaged
                ? join(process.resourcesPath, 'messaging-whatsapp-worker', 'worker.cjs')
                : join(process.cwd(), 'packages', 'messaging-whatsapp-worker', 'dist', 'worker.cjs'),
              pairingMode: 'qr',
            },
          })
          return omitUndefined<HandlerDeps>({
            sessionManager: sm,
            platform: p,
            windowManager: mainState.windowManager ?? undefined,
            browserPaneManager: mainState.browserPaneManager ?? undefined,
            oauthFlowStore: ofs,
            messagingRegistry: mainState.messagingHandle.registry,
          })
        },
        // Headless: register only core handlers (no GUI handlers for browser, settings, etc.)
        // GUI: register all handlers (core + GUI)
        registerAllRpcHandlers: isHeadless
          ? (server, deps, serverCtx) => registerCoreRpcHandlers(server, deps, serverCtx)
          : registerAllRpcHandlers,
        setSessionEventSink: (sm, sink) => sm.setEventSink(sink),
        initializeSessionManager: (sm) => sm.initialize(),
        initModelRefreshService: () => initModelRefreshService(async (slug: string) => {
          const { getCredentialManager } = await import('@craft-agent/shared/credentials')
          const manager = getCredentialManager()
          const [apiKey, oauth] = await Promise.all([
            manager.getLlmApiKey(slug).catch(() => null),
            manager.getLlmOAuth(slug).catch(() => null),
          ])
          return omitUndefined({
            apiKey: apiKey ?? undefined,
            oauthAccessToken: oauth?.accessToken,
            oauthRefreshToken: oauth?.refreshToken,
            oauthIdToken: oauth?.idToken,
          })
        }),
        onClientConnected: ({ clientId, webContentsId }) => {
          if (webContentsId != null) clientMap.set(webContentsId, clientId)
        },
        cleanupClientResources: (clientId) => {
          for (const [wcId, cId] of clientMap) {
            if (cId === clientId) { clientMap.delete(wcId); break }
          }
          cleanupSessionFileWatchForClient(clientId)
        },
      }))

      // Capture module-level references for before-quit cleanup and deep-link handlers
      mainState.sessionManager = instance.sessionManager
      mainState.browserPaneManager?.setPermissionAutonomyResolver(({ sessionId, workspaceId }) => {
        const permissionMode = mainState.sessionManager?.getSessionPermissionModeState(sessionId)?.permissionMode
        const workspace = getWorkspaceByNameOrId(workspaceId)
        const workspaceConfig = workspace ? loadWorkspaceConfig(workspace.rootPath) : null

        if (!permissionMode || !workspaceConfig) return null
        return omitUndefined({
          permissionMode,
          externalActionPolicy: workspaceConfig.defaults?.externalActionPolicy,
        })
      })
      mainState.oauthFlowStore = instance.oauthFlowStore
      mainState.moduleSink = instance.wsServer.push.bind(instance.wsServer)
      mainState.moduleClientResolver = resolveClientId

      // -----------------------------------------------------------------------
      // Messaging Gateway — attach the WS publisher, init local workspaces,
      // install the fan-out event sink. The handle was created inside
      // createHandlerDeps so the registry could be wired into HandlerDeps.
      // -----------------------------------------------------------------------
      try {
        if (!mainState.messagingHandle) {
          throw new Error('Messaging handle was not constructed in createHandlerDeps')
        }

        mainState.messagingHandle.setPublisher(instance.wsServer.push.bind(instance.wsServer))

        // Skip remote-owned workspaces — messaging runs on the remote server.
        const localWorkspaceIds = getWorkspaces()
          .filter((ws) => !ws.remoteServer)
          .map((ws) => ws.id)
        await mainState.messagingHandle.initializeWorkspaces(localWorkspaceIds)

        // Compose fan-out event sink: RPC push + messaging gateway dispatch.
        // Always install — this lets workspaces enable messaging at runtime
        // without a process restart.
        const baseSink = instance.wsServer.push.bind(instance.wsServer)
        instance.sessionManager.setEventSink(mainState.messagingHandle.wrapSink(baseSink))
        if (mainState.messagingHandle.registry.size > 0) {
          mainLog.info(`[messaging] Fan-out sink active for ${mainState.messagingHandle.registry.size} workspace(s)`)
        }
      } catch (err) {
        mainLog.error('[messaging] Gateway initialization failed:', err)
      }

      // IPC handlers — preload uses sendSync to get WS connection details

      // Remove workspace from config (cleanup stale entries)
      disconnectRemoteDevice = registerEmbeddedServerHandlers({
        instance, tls, rpcHost, embeddedServerConfig, serverToken,
        serverModeEnabled, hasSecureBrowserTransport,
      })

      // Wire EventSink to Electron-specific services
      // Must happen BEFORE createInitialWindows() so event handlers use WS from the start
      mainState.windowManager!.setRpcEventSink(mainState.moduleSink!, resolveClientId)
      const { setMenuEventSink } = await import('./menu')
      setMenuEventSink(mainState.moduleSink!, resolveClientId)
      const { setNotificationEventSink } = await import('./notifications')
      setNotificationEventSink(mainState.moduleSink!, resolveClientId)

      // Headless: print connection details
      if (isHeadless) {
        console.log(`CRAFT_SERVER_URL=${instance.protocol}://${instance.host}:${instance.port}`)
        console.log(`CRAFT_SERVER_TOKEN=${instance.token}`)
      }
    }
}
