import { omitUndefined } from '@craft-agent/shared/utils/json';
import { app, ipcMain } from 'electron';

import { hostname, networkInterfaces } from 'os';

import { i18n, SUPPORTED_LANGUAGE_CODES, type LanguageCode } from '@craft-agent/shared/i18n';
import { setPersistedUiLanguage } from '@craft-agent/shared/config';

import { existsSync } from 'fs';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { SessionManager } from '@craft-agent/server-core/sessions';

import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { isLoopbackHost, remoteServerNeedsRestart, resolveRemoteServerUrls } from './remote-access-security';

import { validateBundle, type SessionBundle } from '@craft-agent/shared/sessions';
import { mainLog } from './logger';

import { createLocalRpcEndpoint } from '../transport/local-rpc-endpoint';

import { mainState } from './main-state';
import type { ServerInstance } from '@craft-agent/server-core/bootstrap';
import type { WsRpcTlsOptions } from '@craft-agent/server-core/transport';
import type { ServerConfig } from '@craft-agent/shared/config';

interface EmbeddedServerHandlersInput {
  instance: ServerInstance<SessionManager>
  tls: WsRpcTlsOptions | undefined
  rpcHost: string
  embeddedServerConfig: ServerConfig
  serverToken: string
  serverModeEnabled: boolean
  hasSecureBrowserTransport: boolean
}

function hasTransferSummary(value: unknown): value is { summary: string } {
  if (typeof value !== 'object' || value === null || !('summary' in value)) return false
  return typeof value.summary === 'string' && value.summary.length > 0
}

export function registerEmbeddedServerHandlers({
  instance, tls, rpcHost, embeddedServerConfig, serverToken,
  serverModeEnabled, hasSecureBrowserTransport,
}: EmbeddedServerHandlersInput): (deviceId: string) => void {
ipcMain.handle('workspace:remove', async (_event, workspaceId: string) => {
        const { removeWorkspace: remove } = await import('@craft-agent/shared/config')
        return remove(workspaceId)
      })

      // Cross-server RPC — invoke a channel on an arbitrary remote server
      ipcMain.handle('server:invokeOnServer', async (_event, url: string, token: string, channel: string, ...args: unknown[]) => {
        const { connectToRemote } = await import('./handlers/workspace')
        const { client, error } = await connectToRemote(url, token)
        if (!client) throw new Error(error ?? 'Connection failed')
        try {
          return await client.invoke(channel, ...args)
        } finally {
          client.destroy()
        }
      })

      // Transfer session to another workspace — orchestrated in main process
      // so large bundles can be moved directly between owning servers.
      ipcMain.handle('session:transferToRemoteWorkspace', async (_event, sessionId: string, targetWorkspaceId: string, sessionIndex?: number, sessionCount?: number) => {
        const idx = sessionIndex ?? 0
        const count = sessionCount ?? 1
        const { getWorkspaceByNameOrId } = await import('@craft-agent/shared/config')
        const { connectToRemote } = await import('./handlers/workspace')
        const { CHUNKED_TRANSFER_THRESHOLD, getChunkCount, invokeChunked, prepareChunkedPayload } = await import('./chunked-rpc')

        const targetWorkspace = getWorkspaceByNameOrId(targetWorkspaceId)
        if (!targetWorkspace?.remoteServer) throw new Error(`Workspace ${targetWorkspaceId} has no remote server`)
        if (!mainState.sessionManager) throw new Error('Session manager not initialized')

        const sourceWorkspaceLocalId = mainState.windowManager?.getWorkspaceForWindow(_event.sender.id)
        if (!sourceWorkspaceLocalId) throw new Error('Unable to resolve source workspace for transfer')

        const sourceWorkspace = getWorkspaceByNameOrId(sourceWorkspaceLocalId)
        if (!sourceWorkspace) throw new Error(`Source workspace ${sourceWorkspaceLocalId} not found`)

        let bundle: SessionBundle | null = null

        if (sourceWorkspace.remoteServer) {
          const { url: sourceUrl, token: sourceToken, remoteWorkspaceId: sourceRemoteWorkspaceId } = sourceWorkspace.remoteServer
          console.log(`[Transfer] Exporting remote-owned session ${sessionId} from workspace ${sourceRemoteWorkspaceId}...`)
          const { client: sourceClient, error: sourceError } = await connectToRemote(sourceUrl, sourceToken, sourceRemoteWorkspaceId)
          if (!sourceClient) throw new Error(sourceError ?? 'Connection failed to source remote server')

          try {
            const exportedBundle: unknown = await sourceClient.invoke('sessions:export', sessionId)
            if (!validateBundle(exportedBundle)) {
              throw new Error(`Failed to export a valid session bundle for ${sessionId}`)
            }
            bundle = exportedBundle

            try {
              console.log('[Transfer] Generating conversation summary on source server...')
              const transferPayload: unknown = await sourceClient.invoke('sessions:exportRemoteTransfer', sessionId)
              if (hasTransferSummary(transferPayload)) {
                bundle.session.header.transferredSessionSummary = transferPayload.summary
                bundle.session.header.transferredSessionSummaryApplied = false
                console.log(`[Transfer] Summary generated: ${transferPayload.summary.length} chars`)
              }
            } catch (err) {
              console.warn('[Transfer] Source-server summary generation failed:', err)
            }
          } finally {
            sourceClient.destroy()
          }
        } else {
          console.log(`[Transfer] Exporting local-owned session ${sessionId} from workspace ${sourceWorkspace.id}...`)
          bundle = await mainState.sessionManager.exportSession(sessionId, sourceWorkspace.id)
          if (!bundle) throw new Error(`Failed to export session ${sessionId}`)

          try {
            console.log('[Transfer] Generating conversation summary...')
            const transferPayload = await mainState.sessionManager.exportRemoteSessionTransfer(sessionId, sourceWorkspace.id)
            if (hasTransferSummary(transferPayload)) {
              bundle.session.header.transferredSessionSummary = transferPayload.summary
              bundle.session.header.transferredSessionSummaryApplied = false
              console.log(`[Transfer] Summary generated: ${transferPayload.summary.length} chars`)
            }
          } catch (err) {
            console.warn('[Transfer] Summary generation failed:', err)
          }
        }

        if (!bundle) throw new Error(`Failed to export session ${sessionId}`)
        console.log(`[Transfer] Export complete: ${bundle.session.messages.length} messages, ${bundle.files.length} files`)

        const { url, token, remoteWorkspaceId } = targetWorkspace.remoteServer
        console.log(`[Transfer] Connecting to target remote server: ${url}`)
        const { client, error } = await connectToRemote(url, token, remoteWorkspaceId)
        if (!client) throw new Error(error ?? 'Connection failed to target remote server')
        console.log('[Transfer] Connected to target remote server')

        try {
          const preparedBundle = prepareChunkedPayload(bundle)
          const payloadSize = preparedBundle.bytes.length
          const payloadMB = (payloadSize / (1024 * 1024)).toFixed(1)

          const emitProgress = (chunkSent: number, chunkTotal: number) => {
            try { _event.sender.send('transfer:progress', { sessionIndex: idx, sessionCount: count, chunkSent, chunkTotal }) } catch { /* renderer may be gone */ }
          }

          if (payloadSize < CHUNKED_TRANSFER_THRESHOLD) {
            console.log(`[Transfer] Bundle size: ${payloadMB}MB (< 5MB threshold) → using direct RPC`)
            emitProgress(0, 1)
            const result = await client.invoke('sessions:import', remoteWorkspaceId, bundle, 'fork')
            emitProgress(1, 1)
            return result
          }

          const chunkCount = getChunkCount(payloadSize)
          console.log(`[Transfer] Bundle size: ${payloadMB}MB (>= 5MB threshold) → using chunked transfer (${chunkCount} chunks)`)
          return await invokeChunked(
            client,
            'sessions:import',
            [remoteWorkspaceId, bundle, 'fork'],
            1,
            emitProgress,
            preparedBundle,
          )
        } finally {
          client.destroy()
        }
      })

      // App relaunch (for server config changes — NOT an update install)
      ipcMain.handle('app:relaunch', () => {
        app.relaunch()
        app.exit(0)
      })

      // Language change: sync from renderer to main process, persist, and rebuild native menu.
      // Persistence here is what lets the next app launch hydrate main's i18n correctly —
      // see the `getPersistedUiLanguage()` block at the top of this file.
      ipcMain.handle('i18n:changeLanguage', async (_event, lang: unknown) => {
        const previousResolved = i18n.resolvedLanguage ?? null
        if (typeof lang !== 'string' || !SUPPORTED_LANGUAGE_CODES.includes(lang as LanguageCode)) {
          // Defense-in-depth: renderer guarantees a supported code, but if a renegade
          // caller hands us garbage we drop it silently rather than poison i18n state.
          mainLog.warn('[i18n] changeLanguage IPC rejected — unsupported code', {
            incoming: lang,
            previousResolved,
          })
          return
        }
        const code = lang as LanguageCode
        await i18n.changeLanguage(code)
        setPersistedUiLanguage(code)
        mainLog.info('[i18n] changeLanguage IPC applied', {
          incoming: code,
          previousResolved,
          newResolved: i18n.resolvedLanguage ?? null,
        })
        const { rebuildMenu } = await import('./menu')
        await rebuildMenu()
      })

      ipcMain.on('__get-ws-port', (e) => {
        e.returnValue = instance.port
      })
      ipcMain.on('__get-ws-endpoint', (e) => {
        e.returnValue = createLocalRpcEndpoint(instance.port, Boolean(tls))
      })
      ipcMain.on('__get-ws-token', (e) => {
        e.returnValue = instance.token
      })
      ipcMain.on('__get-workspace-remote-config', (e) => {
        const wsId = mainState.windowManager?.getWorkspaceForWindow(e.sender.id)
        if (!wsId) { e.returnValue = null; return }
        const ws = getWorkspaceByNameOrId(wsId)
        e.returnValue = ws?.remoteServer ?? null
      })

      // Server config RPC handlers (LOCAL_ONLY — Electron-specific)
      const runningServerState = omitUndefined({
        host: rpcHost,
        port: instance.port,
        tls: !!tls,
        tlsCertPath: tls ? embeddedServerConfig.tlsCertPath : undefined,
        tlsKeyPath: tls ? embeddedServerConfig.tlsKeyPath : undefined,
        token: serverToken,
        enabled: serverModeEnabled,
        publicWebuiUrl: embeddedServerConfig.publicWebuiUrl,
        publicWsUrl: embeddedServerConfig.publicWsUrl,
        tunnelProvider: embeddedServerConfig.tunnelProvider,
        remoteAuthMode: embeddedServerConfig.remoteAuthMode,
      })

      const disconnectRemoteDevice = (deviceId: string) => {
        instance.wsServer.disconnectClientsByActor(`remote-device:${deviceId}`)
      }

      const getDisplayHost = (): string => {
        if (runningServerState.host !== '0.0.0.0' && runningServerState.host !== '::') {
          return runningServerState.host
        }
        for (const addresses of Object.values(networkInterfaces())) {
          const address = addresses?.find((candidate) => candidate.family === 'IPv4' && !candidate.internal)
          if (address) return address.address
        }
        return '127.0.0.1'
      }

      const getRunningRemoteUrls = () => resolveRemoteServerUrls(
        runningServerState,
        getDisplayHost(),
        Boolean(mainState.embeddedWebuiHandler),
      )

      instance.wsServer.handle(RPC_CHANNELS.settings.GET_SERVER_CONFIG, async () => {
        const { getServerConfig: getConfig } = await import('@craft-agent/shared/config')
        return getConfig()
      })

      instance.wsServer.handle(RPC_CHANNELS.settings.SET_SERVER_CONFIG, async (_ctx: unknown, config: unknown) => {
        const { setServerConfig: setConfig } = await import('@craft-agent/shared/config')
        const cfg = config as import('@craft-agent/shared/config').ServerConfig
        // Validate port range
        if (cfg.port < 1024 || cfg.port > 65535) {
          throw new Error(`Port must be between 1024 and 65535, got ${cfg.port}`)
        }
        // Validate cert/key files exist if provided
        if (cfg.tlsCertPath && !existsSync(cfg.tlsCertPath)) {
          throw new Error(`Certificate file not found: ${cfg.tlsCertPath}`)
        }
        if (cfg.tlsKeyPath && !existsSync(cfg.tlsKeyPath)) {
          throw new Error(`Private key file not found: ${cfg.tlsKeyPath}`)
        }
        setConfig(cfg)
      })

      instance.wsServer.handle(RPC_CHANNELS.settings.GET_SERVER_STATUS, async () => {
        const { getServerConfig: getConfig } = await import('@craft-agent/shared/config')
        const saved = getConfig()
        // Only compare port/tls/token when at least one side has server mode enabled.
        // When both are disabled, the running port is random — comparing it to the
        // saved default (9100) would always produce a false "restart required" banner.
        const needsRestart = remoteServerNeedsRestart(saved, runningServerState)
        const publicUrls = getRunningRemoteUrls()

        return {
          running: true,
          host: runningServerState.host,
          port: runningServerState.port,
          tls: hasSecureBrowserTransport,
          url: publicUrls.url,
          webUrl: publicUrls.webUrl,
          token: runningServerState.token,
          needsRestart,
          insecureWarning: isInsecureBind,
        }
      })

      instance.wsServer.handle(RPC_CHANNELS.settings.CREATE_REMOTE_PAIRING, async () => {
        if (!serverModeEnabled || !mainState.embeddedWebuiHandler) {
          throw new Error('Enable Remote access and restart Robb Agents before pairing a phone')
        }
        if (!hasSecureBrowserTransport) {
          throw new Error('Configure TLS or an HTTPS/WSS reverse proxy, then restart Robb Agents before pairing a phone')
        }
        const publicWebUrl = getRunningRemoteUrls().webUrl
        if (!publicWebUrl) {
          throw new Error('Remote Web UI is unavailable')
        }
        return mainState.embeddedWebuiHandler.createRemotePairing(publicWebUrl, hostname())
      })

      instance.wsServer.handle(RPC_CHANNELS.settings.LIST_REMOTE_DEVICES, async () => {
        return mainState.embeddedWebuiHandler?.listRemoteDevices() ?? []
      })

      instance.wsServer.handle(RPC_CHANNELS.settings.REVOKE_REMOTE_DEVICE, async (_ctx: unknown, deviceId: string) => {
        if (!mainState.embeddedWebuiHandler) return false
        return mainState.embeddedWebuiHandler.revokeRemoteDevice(deviceId)
      })

      // Defensive status guard. Startup has already forced an insecure network
      // bind back to loopback, so this should remain false in normal operation.
      const isInsecureBind = serverModeEnabled && !tls
        && !isLoopbackHost(rpcHost)
      if (isInsecureBind) {
        mainLog.warn(
          '[server-mode] WARNING: Listening on a network address without TLS. ' +
          'Auth tokens will be sent in cleartext. ' +
          'Configure TLS certificates in Settings > Server.'
        )
      }
return disconnectRemoteDevice
}
