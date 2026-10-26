import { startEmbeddedServer } from './main-embedded-server';

import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell } from 'electron';

import * as Sentry from '@sentry/electron/main';
import { resolveAppChannel } from './app-channel';
import { configurePlatformWebAuthn } from './webauthn';

import { join } from 'path';
import { existsSync } from 'fs';

import type { PlatformServices } from '../runtime/platform';
import { createElectronPlatform } from './platform';

import { createApplicationMenu } from './menu';
import { WindowManager } from './window-manager';
import { loadWindowState } from './window-state';
import { getWorkspaces } from '@craft-agent/shared/config';

import { initializeDocs } from '@craft-agent/shared/docs';
import { initializeReleaseNotes } from '@craft-agent/shared/release-notes';

import { ensureDefaultPermissions } from '@craft-agent/shared/agent/permissions-config';
import { ensureToolIcons, ensurePresetThemes } from '@craft-agent/shared/config';
import { setBundledAssetsRoot } from '@craft-agent/shared/utils';
import { initializeBackendHostRuntime } from '@craft-agent/shared/agent/backend';
import { setPowerShellValidatorRoot } from '@craft-agent/shared/agent';
import { handleDeepLink } from './deep-link';
import { BrowserPaneManager } from './browser-pane-manager';

import { registerThumbnailHandler } from './thumbnail-protocol';
import log, { isDebugMode, mainLog, getLogFilePath, getMessagingGatewayLogFilePath } from './logger';

import { initNotificationService, initBadgeIcon, initInstanceBadge } from './notifications';
import { setAutoUpdateEventSink, setBeforeUpdateQuitHook, startAutomaticUpdateChecks } from './auto-update';

import { applyConfiguredProxySettings } from './network-proxy';
import { mainState } from './main-state';

interface MainStartupInput {
  APP_CHANNEL: ReturnType<typeof resolveAppChannel>
  IS_DEVELOPMENT_CHANNEL: boolean
  runtimeAppRoot: string
  createInitialWindows: () => Promise<void>
  captureAndSaveWindowState: (reason: 'before-quit' | 'pre-update') => number
}



export async function startMainProcess({
  APP_CHANNEL, IS_DEVELOPMENT_CHANNEL, runtimeAppRoot,
  createInitialWindows, captureAndSaveWindowState,
}: MainStartupInput) {
  console.error('[Robb startup] Electron ready')
  // Export packaged state as env var so logger.ts (and headless Bun) don't need 'electron'
  process.env.CRAFT_IS_PACKAGED = app.isPackaged ? 'true' : 'false'

  const webAuthnConfiguration = configurePlatformWebAuthn(app, {
    platform: process.platform,
    channel: APP_CHANNEL,
  })
  if (webAuthnConfiguration.enabled) {
    mainLog.info('[webauthn] Touch ID platform authenticator enabled')
  } else if (webAuthnConfiguration.reason === 'configuration-failed') {
    mainLog.warn('[webauthn] Touch ID platform authenticator configuration failed', webAuthnConfiguration.error)
  }

  // Register bundled assets root so all seeding functions can find their files
  // (docs, permissions, themes, tool-icons resolve via getBundledAssetsDir)
  setBundledAssetsRoot(app.isPackaged ? runtimeAppRoot : __dirname)

  // Initialize backend runtime bootstrapping (Codex vendor root, Claude SDK runtime paths).
  initializeBackendHostRuntime({
    hostRuntime: {
      appRootPath: runtimeAppRoot,
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
    },
  })

  // Register PowerShell validator root so it can find the bundled parser script
  // (Windows only: validates PowerShell commands in Explore mode using AST analysis)
  setPowerShellValidatorRoot(join(app.isPackaged ? runtimeAppRoot : __dirname, 'resources'))

  // Initialize bundled docs
  initializeDocs()
  console.error('[Robb startup] docs initialized')

  // Initialize bundled release notes
  initializeReleaseNotes()
  console.error('[Robb startup] release notes initialized')

  // Ensure default permissions file exists (copies bundled default.json on first run)
  ensureDefaultPermissions()
  console.error('[Robb startup] permissions initialized')

  // Seed tool icons to ~/.craft-agent/tool-icons/ (copies bundled SVGs on first run)
  ensureToolIcons()
  console.error('[Robb startup] tool icons initialized')

  // Seed preset themes to ~/.craft-agent/themes/ (copies bundled theme JSONs on first run)
  ensurePresetThemes()
  console.error('[Robb startup] themes initialized')

  // Register thumbnail:// protocol handler (scheme was registered earlier, before app.whenReady)
  registerThumbnailHandler()
  console.error('[Robb startup] thumbnail protocol initialized')

  // Re-apply proxy settings now that Electron sessions are available
  // (first call before app.whenReady only configured Node-level proxy)
  await applyConfiguredProxySettings()
  console.error('[Robb startup] proxy settings applied')

  // Note: electron-updater handles pending updates internally via autoInstallOnAppQuit

  // Application menu is created after windowManager initialization (see below)

  // Set dock icon on macOS (required for dev mode, bundled apps use Info.plist)
  if (process.platform === 'darwin' && app.dock) {
    // In packaged app, resources are at dist/resources/ (same level as __dirname)
    // In dev, resources are at ../resources/ (sibling of dist/)
    const dockIconPath = [
      join(__dirname, 'resources/robinswood-icon.png'),
      join(__dirname, '../resources/robinswood-icon.png'),
    ].find(p => existsSync(p))

    if (dockIconPath) {
      if (!app.isPackaged) {
        app.dock.setIcon(dockIconPath)
      }
      // Initialize badge icon for canvas-based badge overlay
      initBadgeIcon(dockIconPath)
    }

    // Multi-instance dev: show instance number badge on dock icon
    // CRAFT_INSTANCE_NUMBER is set by detect-instance.sh for numbered folders
    const instanceNum = process.env.CRAFT_INSTANCE_NUMBER
    if (instanceNum) {
      const num = parseInt(instanceNum, 10)
      if (!isNaN(num) && num > 0) {
        initInstanceBadge(num)
      }
    }
  }

  try {
    console.error('[Robb startup] initializing window manager')
    // Initialize window manager
    mainState.windowManager = new WindowManager()
    console.error('[Robb startup] window manager initialized')

    // Create the application menu (needs windowManager for New Window action)
    createApplicationMenu(mainState.windowManager)
    console.error('[Robb startup] application menu initialized')

    // When CRAFT_SERVER_URL is set, this Electron instance is a thin client —
    // it only creates windows whose preload connects to the remote server.
    // Skip server-side initialization (SessionManager, model refresh, platform injection).
    const isClientOnly = !!process.env.CRAFT_SERVER_URL
    const isHeadless = !!process.env.CRAFT_HEADLESS

    if (isClientOnly) {
      mainLog.info(`Client-only mode: CRAFT_SERVER_URL=${process.env.CRAFT_SERVER_URL} (server initialization skipped)`)
    }

    // Initialize notification service (always — triggered by server push events)
    initNotificationService(mainState.windowManager)

    // Initialize browser pane manager (always — even in headless, for deps wiring)
    mainState.browserPaneManager = new BrowserPaneManager()
    mainState.browserPaneManager.setWindowManager(mainState.windowManager)
    mainState.browserPaneManager.registerToolbarIpc()
    mainState.browserPaneManager.registerCapabilityIpc()

    // Build real PlatformServices from Electron APIs
    const platform: PlatformServices = createElectronPlatform({
      app,
      nativeImage,
      shell,
      nativeTheme,
      logger: log,
      isDebugMode: IS_DEVELOPMENT_CHANNEL || isDebugMode,
      buildCommit: process.env.ROBB_BUILD_COMMIT,
      buildChannel: APP_CHANNEL,
      buildDirty: process.env.ROBB_BUILD_DIRTY === 'true'
        ? true
        : process.env.ROBB_BUILD_DIRTY === 'false'
          ? false
          : undefined,
      runtimeAppRoot,
      getLogFilePath,
      captureError: (err) => Sentry.captureException(err),
    })

    // Bootstrap IPC handlers — preload uses sendSync for window-local details
    ipcMain.on('__get-web-contents-id', (e) => {
      e.returnValue = e.sender.id
    })
    ipcMain.on('__get-workspace-id', (e) => {
      e.returnValue = mainState.windowManager?.getWorkspaceForWindow(e.sender.id) ?? ''
    })

    // Transport diagnostics bridge — preload reports remote WS connection state changes
    // so failures are visible in terminal/main.log (not only renderer console).
    ipcMain.on('__transport:status', (_event, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as {
        level?: 'info' | 'warn' | 'error'
        message?: string
        status?: string
        attempt?: number
        nextRetryInMs?: number
        error?: unknown
        close?: unknown
        url?: string
      }

      const level = p.level ?? 'info'
      const message = p.message ?? '[transport] status update'
      const context = {
        status: p.status,
        attempt: p.attempt,
        nextRetryInMs: p.nextRetryInMs,
        error: p.error,
        close: p.close,
        url: p.url,
      }

      if (level === 'error') {
        mainLog.error(message, context)
      } else if (level === 'warn') {
        mainLog.warn(message, context)
      } else {
        mainLog.info(message, context)
      }
    })

    // Dialog bridge — preload capability handlers use ipcRenderer.invoke to
    // call main-process-only dialog APIs (dialog, BrowserWindow).
    ipcMain.handle('__dialog:showMessageBox', async (event, spec) => {
      const win = BrowserWindow.fromWebContents(event.sender)
        || BrowserWindow.getFocusedWindow()
        || BrowserWindow.getAllWindows()[0]
      const result = await dialog.showMessageBox(win, spec)
      return { response: result.response }
    })
    ipcMain.handle('__dialog:showOpenDialog', async (event, spec) => {
      const win = BrowserWindow.fromWebContents(event.sender)
        || BrowserWindow.getFocusedWindow()
        || BrowserWindow.getAllWindows()[0]
      const result = await dialog.showOpenDialog(win, spec)
      return { canceled: result.canceled, filePaths: result.filePaths }
    })

    await startEmbeddedServer({ isClientOnly, isHeadless, platform })

    // Create initial windows (restores from saved state or opens first workspace)
    // In headless mode the server runs without any UI — skip window creation.
    if (!isHeadless) {
      await createInitialWindows()
    }

    // Run credential health check at startup to detect issues early
    // (corruption, machine migration, missing credentials for default connection)
    // Skip in thin-client mode — credentials are managed by the remote server.
    if (!isClientOnly) {
      try {
        const { getCredentialManager } = await import('@craft-agent/shared/credentials')
        const credentialManager = getCredentialManager()
        const health = await credentialManager.checkHealth()
        if (!health.healthy) {
          mainLog.warn('Credential health check failed:', health.issues)
          // Issues will be displayed in Settings → AI when user navigates there
        }
      } catch (err) {
        mainLog.error('Credential health check error:', err)
      }
    }

    // Initialize power manager (loads setting, must happen after config is available)
    // Non-critical — powerSaveBlocker may not work on headless/xvfb setups
    try {
      const { initPowerManager } = await import('./power-manager')
      await initPowerManager()
    } catch (err) {
      mainLog.warn('[power] Power manager init failed (non-critical):', err instanceof Error ? err.message : err)
    }

    // Set Sentry context tags for error grouping (no PII — just config classification).
    // Runs after init so config and auth state are available.
    // Derives values from the default LLM connection instead of legacy config fields.
    try {
      const { getLlmConnection, getDefaultLlmConnection } = await import('@craft-agent/shared/config')
      const workspaces = getWorkspaces()
      const defaultConnSlug = getDefaultLlmConnection()
      const defaultConn = defaultConnSlug ? getLlmConnection(defaultConnSlug) : null
      Sentry.setTag('authType', defaultConn?.authType ?? 'unknown')
      Sentry.setTag('providerType', defaultConn?.providerType ?? 'unknown')
      Sentry.setTag('hasCustomEndpoint', String(!!defaultConn?.baseUrl))
      Sentry.setTag('model', defaultConn?.defaultModel ?? 'default')
      Sentry.setTag('workspaceCount', String(workspaces.length))
    } catch (err) {
      mainLog.warn('Failed to set Sentry context tags:', err)
    }

    // Register the update bridge, then schedule bounded availability checks in
    // the main process. Downloads and installs always require explicit consent.
    // Development builds are rejected by the updater itself.
    if (mainState.moduleSink) setAutoUpdateEventSink(mainState.moduleSink)
    // Snapshot multi-window state BEFORE quitAndInstall. electron-updater
    // (Squirrel.Mac) destroys BrowserWindows between quitAndInstall and
    // before-quit firing; saving from before-quit alone would overwrite
    // window-state.json with an empty array.
    setBeforeUpdateQuitHook(() => captureAndSaveWindowState('pre-update'))
    startAutomaticUpdateChecks()
    mainLog.info(
      APP_CHANNEL === 'production'
        ? '[auto-update] Stable update checks enabled; downloads require confirmation'
        : '[auto-update] Disabled for the development channel',
    )

    // Process pending deep link from cold start
    if (mainState.pendingDeepLink) {
      mainLog.info('Processing pending deep link:', mainState.pendingDeepLink)
      await handleDeepLink(mainState.pendingDeepLink, mainState.windowManager, mainState.moduleSink ?? undefined, mainState.moduleClientResolver ?? undefined)
      mainState.pendingDeepLink = null
    }

    mainLog.info('App initialized successfully')
    if (isDebugMode) {
      mainLog.info('Debug mode enabled - logs at:', getLogFilePath())
    }
    mainLog.info('Messaging gateway log path:', getMessagingGatewayLogFilePath())
  } catch (error) {
    const stack = error instanceof Error ? error.stack : undefined
    mainLog.error('Failed to initialize app:', error instanceof Error ? error.message : error, stack)
    // Continue anyway - the app will show errors in the UI
  }

  // macOS: Re-create window when dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && mainState.windowManager) {
      // Open first workspace or last focused
      const workspaces = getWorkspaces()
      if (workspaces.length > 0) {
        const savedState = loadWindowState()
        const wsId = savedState?.lastFocusedWorkspaceId || workspaces[0].id
        // Verify workspace still exists
        if (workspaces.some(ws => ws.id === wsId)) {
          mainState.windowManager.createWindow({ workspaceId: wsId })
        } else {
          mainState.windowManager.createWindow({ workspaceId: workspaces[0].id })
        }
      }
    }
  })
}
