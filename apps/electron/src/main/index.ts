import { mainState } from './main-state';
import { runShutdownCleanup } from './shutdown-cleanup';
// Load user's shell environment first (before other imports that may use env)
// This ensures tools like Homebrew, nvm, etc. are available to the agent
import { loadShellEnv } from './shell-env';
loadShellEnv()

import { app, BrowserWindow } from 'electron';
import { createHash } from 'crypto';
import { hostname, homedir } from 'os';
import * as Sentry from '@sentry/electron/main';
import { getDefaultAppName, getDefaultDeepLinkScheme, resolveAppChannel } from './app-channel';


const APP_CHANNEL = resolveAppChannel(app.isPackaged)
const IS_DEVELOPMENT_CHANNEL = APP_CHANNEL === 'development'

// Initialize Sentry error tracking as early as possible after app import.
// Only enabled in production (packaged) builds to avoid noise during development.
// DSN is baked in at build time via esbuild --define (same pattern as OAuth secrets).
//
// NOTE: Source map upload is intentionally disabled. Stack traces in Sentry will show
// bundled/minified code. To enable source map upload in the future:
//   1. Add SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT to CI secrets
//   2. Re-enable the @sentry/vite-plugin in vite.config.ts (handles renderer maps)
//   3. Add @sentry/esbuild-plugin to scripts/electron-build-main.ts (handles main process maps)
Sentry.init({
  dsn: process.env.SENTRY_ELECTRON_INGEST_URL,
  environment: APP_CHANNEL,
  release: app.getVersion(),
  // Opt-in only (ROBB_ENABLE_SENTRY=1) to preserve strict local confidentiality by default.
  enabled: !!process.env.SENTRY_ELECTRON_INGEST_URL && process.env.ROBB_ENABLE_SENTRY === '1',

  // Scrub sensitive data before sending to Sentry.
  // Removes authorization headers, API keys/tokens, and credential-like values.
  beforeSend(event) {
    // Scrub request headers (authorization, cookies)
    if (event.request?.headers) {
      const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key']
      for (const header of sensitiveHeaders) {
        if (event.request.headers[header]) {
          event.request.headers[header] = '[REDACTED]'
        }
      }
    }

    // Scrub breadcrumb data that may contain sensitive values
    if (event.breadcrumbs) {
      for (const breadcrumb of event.breadcrumbs) {
        if (breadcrumb.data) {
          for (const key of Object.keys(breadcrumb.data)) {
            const lowerKey = key.toLowerCase()
            if (lowerKey.includes('token') || lowerKey.includes('key') ||
                lowerKey.includes('secret') || lowerKey.includes('password') ||
                lowerKey.includes('credential') || lowerKey.includes('auth')) {
              breadcrumb.data[key] = '[REDACTED]'
            }
          }
        }
      }
    }

    return event
  },
})

// Initialize i18n for main process (menus, dialogs, etc.)
//
// The main-process i18n instance has no detection plugin (no localStorage in Node)
// — in the Robinswood fork it starts at the French fallback. We hydrate it here
// from the persisted `uiLanguage` preference, which is maintained by the `i18n:changeLanguage` IPC
// handler whenever the user changes Appearance → Language. Without this, the
// renderer would restore its language from localStorage on every restart while
// the main process silently stayed at English — breaking session title language,
// the system prompt's "Preferred language" line, and the native menu.
import { setupI18n, i18n } from '@craft-agent/shared/i18n';
import { getPersistedUiLanguage } from '@craft-agent/shared/config';
setupI18n()
const persistedUiLanguage = getPersistedUiLanguage()
if (persistedUiLanguage) {
  void i18n.changeLanguage(persistedUiLanguage)
}
// Note: deferred startup log lives below where mainLog is available (after log.initialize()).

// Set anonymous machine ID for Sentry user tracking (no PII — just a hash).
// Uses hostname + homedir to produce a stable per-machine identifier.
if (process.env.ROBB_ENABLE_SENTRY === '1') {
  const machineId = createHash('sha256').update(hostname() + homedir()).digest('hex').slice(0, 16)
  Sentry.setUser({ id: machineId })
}

import { join, delimiter } from 'path';
import { existsSync } from 'fs';





import { resolveElectronRuntimeAppRoot } from './platform';

import { releaseServerLock } from '@craft-agent/server-core/bootstrap';


import { getModelRefreshService } from '@craft-agent/server-core/model-fetchers';
import { loadRobbOperationsModule } from '@craft-agent/server-core/operations';



import { saveWindowState } from './window-state';
import { CONFIG_DIR } from '@craft-agent/shared/config';










import { handleDeepLink } from './deep-link';


import { registerThumbnailScheme } from './thumbnail-protocol';
import log, { isDebugMode, mainLog, autoUpdateLog } from './logger';
import { setPerfEnabled, enableDebug } from '@craft-agent/shared/utils';
import { registerPiModelResolver } from '@craft-agent/shared/config';
import { getPiModelsForAuthProvider, getAllPiModels } from '@craft-agent/shared/config';

import { isUpdating, stopAutomaticUpdateChecks } from './auto-update';





// Initialize electron-log for renderer process support
log.initialize()

// Diagnostic: report main-process i18n hydration result. We log here (not inline
// at the hydration site above) because mainLog is only available after this point.
mainLog.info('[i18n] startup hydration', {
  persistedUiLanguage: persistedUiLanguage ?? null,
  resolvedLanguageAfterHydration: i18n.resolvedLanguage ?? null,
})

// Enable debug/perf in dev mode (running from source)
if (isDebugMode) {
  process.env.CRAFT_DEBUG = '1'
  // Do not implicitly enable developer feedback in dev mode unless explicitly opted in.
  process.env.CRAFT_FEATURE_DEVELOPER_FEEDBACK ??= '0'
  enableDebug()
  setPerfEnabled(true)
}

const runtimeAppRoot = resolveElectronRuntimeAppRoot(app)

// Bundle CLI tools: resolve platform-specific uv binary and wrapper scripts.
// These are available to all agent Bash sessions via CRAFT_UV, CRAFT_SCRIPTS env vars
// and PATH prepend. uv auto-downloads Python 3.12 on first use (~5s, then cached).
{
  // In packaged app: resources are at process.resourcesPath/app/resources/
  // In dev: resources are at __dirname/../resources/ (sibling of dist/)
  const resourcesBase = app.isPackaged
    ? join(process.resourcesPath, 'app')
    : join(__dirname, '..')
  const platformKey = `${process.platform}-${process.arch}`
  const uvPlatformDir = join(resourcesBase, 'resources', 'bin', platformKey)
  const uvBinary = join(uvPlatformDir, process.platform === 'win32' ? 'uv.exe' : 'uv')
  const binDir = join(resourcesBase, 'resources', 'bin')
  const scriptsDir = join(resourcesBase, 'resources', 'scripts')

  const bundledUvExists = existsSync(uvBinary)
  const fallbackUv = bundledUvExists ? null : 'uv'

  // Runtime resolver hints for shared session tools
  process.env.CRAFT_IS_PACKAGED = app.isPackaged ? '1' : '0'
  process.env.CRAFT_RESOURCES_BASE = resourcesBase
  process.env.CRAFT_APP_ROOT = runtimeAppRoot

  process.env.CRAFT_UV = bundledUvExists ? uvBinary : (fallbackUv ?? uvBinary)

  // Bun runtime (packaged builds should prefer bundled runtime over PATH)
  const bunBinary = join(resourcesBase, 'vendor', 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun')
  if (existsSync(bunBinary)) {
    process.env.CRAFT_BUN = bunBinary
  }

  process.env.CRAFT_SCRIPTS = scriptsDir
  process.env.CRAFT_COMMANDS_ENTRY = app.isPackaged
    ? join(runtimeAppRoot, 'packages', 'craft-agents-commands', 'src', 'main.ts')
    : join(process.cwd(), 'packages', 'craft-agents-commands', 'src', 'main.ts')
  process.env.CRAFT_CLI_ENTRY = app.isPackaged
    ? join(runtimeAppRoot, 'packages', 'craft-cli', 'src', 'cli.ts')
    : join(process.cwd(), 'packages', 'craft-cli', 'src', 'cli.ts')
  process.env.CRAFT_COMMANDS_DOC_PATH = app.isPackaged
    ? join(resourcesBase, 'resources', 'docs', 'craft-cli.md')
    : join(process.cwd(), 'apps', 'electron', 'resources', 'docs', 'craft-cli.md')
  process.env.CRAFT_CLI_DOC_PATH = process.env.CRAFT_COMMANDS_DOC_PATH
  process.env.CRAFT_AGENT_VERSION = app.getVersion()
  // Prepend both generic wrappers dir and platform uv dir:
  // - binDir exposes wrapper commands (pdf-tool, docx-tool, ...)
  // - uvPlatformDir exposes raw `uv` for direct shell usage / debugging
  process.env.PATH = `${binDir}${delimiter}${uvPlatformDir}${delimiter}${process.env.PATH}`

  if (!bundledUvExists) {
    mainLog.warn('Bundled uv binary missing, CLI document tools may fail unless uv is available on PATH.', {
      expectedUvPath: uvBinary,
      usingCraftUv: process.env.CRAFT_UV,
    })
  }

  if (isDebugMode) {
    mainLog.info('CLI tools configured:', { uvBinary: process.env.CRAFT_UV, binDir, scriptsDir, bundledUvExists })
  }
}

// Register Pi model resolver so llm-connections.ts can resolve Pi models
// without importing @earendil-works/pi-ai (which breaks the Vite renderer build)
registerPiModelResolver((piAuthProvider) =>
  piAuthProvider ? getPiModelsForAuthProvider(piAuthProvider) : getAllPiModels()
)

// Custom URL scheme for deeplinks (e.g., craftagents://auth-complete)
// Supports multi-instance dev: CRAFT_DEEPLINK_SCHEME env var (craftagents1, craftagents2, etc.)
const DEEPLINK_SCHEME = process.env.CRAFT_DEEPLINK_SCHEME || getDefaultDeepLinkScheme(APP_CHANNEL)

// Set app name early (before app.whenReady) to ensure correct macOS menu bar title
// Supports isolated development instances while preserving the stable
// production identity in release builds.
app.setName(process.env.CRAFT_APP_NAME || getDefaultAppName(APP_CHANNEL))

// Share the established Craft data root (sessions, sources, projects and
// credentials) while isolating Electron's cache, single-instance lock and
// local server runtime lock. This lets Craft Agents and Robb run side-by-side
// without a data migration.
const robbRuntimeDir = join(CONFIG_DIR, 'robb-electron')
app.setPath('userData', robbRuntimeDir)
process.env.CRAFT_SERVER_LOCK_DIR = robbRuntimeDir
process.env.CRAFT_CONFIG_DIR = CONFIG_DIR

// Register as default protocol client for craftagents:// URLs
// This must be done before app.whenReady() on some platforms
if (process.defaultApp) {
  // Development mode: need to pass the app path
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEPLINK_SCHEME, process.execPath, [process.argv[1]])
  }
} else {
  // Production mode
  app.setAsDefaultProtocolClient(DEEPLINK_SCHEME)
}

// Apply network proxy settings early (Node-level only — Electron sessions require app.whenReady)
import { applyConfiguredProxySettings } from './network-proxy';
void applyConfiguredProxySettings()

// Accept self-signed / untrusted certificates when connecting to a user-configured remote server.
// Only bypasses cert validation for the exact CRAFT_SERVER_URL origin — all other connections
// use standard certificate verification. Without this, wss:// to self-signed servers fails with
// ERR_CERT_AUTHORITY_INVALID because Chromium's WebSocket rejects untrusted certs.
//
// Electron's certificate-error always reports URLs with https:// scheme, so we normalize
// wss:// → https:// (and ws:// → http://) to ensure origins compare correctly.
function normalizeOriginForCert(urlStr: string): string {
  const u = new URL(urlStr)
  if (u.protocol === 'wss:') u.protocol = 'https:'
  else if (u.protocol === 'ws:') u.protocol = 'http:'
  return u.origin
}

if (process.env.CRAFT_SERVER_URL) {
  let serverOrigin: string | undefined
  let allowSelfSignedCert = false
  try {
    serverOrigin = normalizeOriginForCert(process.env.CRAFT_SERVER_URL)
    const parsedHost = new URL(serverOrigin).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    const isLoopbackServer =
      parsedHost === '127.0.0.1' ||
      parsedHost === 'localhost' ||
      parsedHost === '::1'
    const insecureTlsFlag = process.env.CRAFT_ALLOW_INSECURE_TLS?.trim().toLowerCase()
    allowSelfSignedCert =
      isLoopbackServer ||
      insecureTlsFlag === '1' ||
      insecureTlsFlag === 'true'
  } catch {
    // Invalid URL — will fail later during connection, no need to handle here
  }
  if (serverOrigin && allowSelfSignedCert) {
    app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
      try {
        if (normalizeOriginForCert(url) === serverOrigin) {
          event.preventDefault()
          callback(true)
          return
        }
      } catch {
        // URL parse failure — fall through to default rejection
      }
      callback(false)
    })
  }
}

// Register thumbnail:// custom protocol for file preview thumbnails in the sidebar.
// Must happen before app.whenReady() — Electron requires early scheme registration.
registerThumbnailScheme()

// Handle deeplink on macOS (when app is already running)
app.on('open-url', (event, url) => {
  event.preventDefault()
  mainLog.info('Received deeplink:', url)

  if (mainState.windowManager) {
    handleDeepLink(url, mainState.windowManager, mainState.moduleSink ?? undefined, mainState.moduleClientResolver ?? undefined).catch(err => {
      mainLog.error('Failed to handle deep link:', err)
    })
  } else {
    // App not ready - store for later
    mainState.pendingDeepLink = url
  }
})

// Only Windows/Linux need Electron's single-instance lock for command-line
// deeplinks. On macOS, keeping this lock would make Robb quit when Craft
// Agents is already open, despite the apps intentionally sharing data.
const gotTheLock = process.platform === 'darwin' || app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine, _workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    // On Windows/Linux, the deeplink is in commandLine
    const url = commandLine.find(arg => arg.startsWith(`${DEEPLINK_SCHEME}://`))
    if (url && mainState.windowManager) {
      mainLog.info('Received deeplink from second instance:', url)
      handleDeepLink(url, mainState.windowManager, mainState.moduleSink ?? undefined, mainState.moduleClientResolver ?? undefined).catch(err => {
        mainLog.error('Failed to handle deep link:', err)
      })
    } else if (mainState.windowManager) {
      // No deep link - just focus the first window
      const windows = mainState.windowManager.getAllWindows()
      if (windows.length > 0) {
        const win = windows[0].window
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    }
  })
}
app.whenReady().then(async () => {
  const packagedOperationsPath = join(process.resourcesPath, 'app', 'resources', 'operations', 'index.mjs')
  const operations = await loadRobbOperationsModule({
    dataRoot: CONFIG_DIR,
    appVersion: app.getVersion(),
    buildChannel: IS_DEVELOPMENT_CHANNEL ? 'development' : 'production',
    isPackaged: app.isPackaged,
    env: process.env,
    modulePath: app.isPackaged && existsSync(packagedOperationsPath)
      ? packagedOperationsPath
      : undefined,
  }).catch((error: unknown) => {
    mainLog.error('[operations] Commercial module unavailable:', error)
    return null
  })
  mainLog.info(operations
    ? `[operations] Loaded ${operations.id}`
    : '[operations] Commercial module not loaded (OSS mode)')
  const { startMainProcess } = await import('./main-ready')
  const { createInitialWindows } = await import('./initial-windows')
  await startMainProcess({
    APP_CHANNEL, IS_DEVELOPMENT_CHANNEL, runtimeAppRoot,
    createInitialWindows, captureAndSaveWindowState,
  })
}).catch((error) => {
  console.error('[Robb startup] initialization failed:', error)
})

app.on('window-all-closed', () => {
  if (process.env.CRAFT_HEADLESS) return  // headless server stays alive
  // On macOS, apps typically stay active until explicitly quit
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Track if we're in the process of quitting (to avoid re-entry)
let isQuitting = false

/**
 * Capture the current multi-window state and persist it to disk.
 * Called from two sites:
 *   - before-quit (normal quit path, reason='before-quit')
 *   - installUpdate hook (auto-update path, reason='pre-update'), because
 *     electron-updater destroys BrowserWindows between quitAndInstall and
 *     before-quit firing — by the time before-quit runs, getWindowStates()
 *     returns an empty array and would clobber the on-disk state.
 * Returns the number of windows saved, or -1 if windowManager isn't ready.
 */
function captureAndSaveWindowState(reason: 'before-quit' | 'pre-update'): number {
  if (!mainState.windowManager) return -1
  const windows = mainState.windowManager.getWindowStates()
  const focusedWindow = BrowserWindow.getFocusedWindow()
  const lastFocusedWorkspaceId = focusedWindow
    ? mainState.windowManager.getWorkspaceForWindow(focusedWindow.webContents.id) ?? undefined
    : undefined
  saveWindowState({ windows, lastFocusedWorkspaceId })
  mainLog.info('[window-state] saved', { windowCount: windows.length, reason })
  return windows.length
}

// Save window state and clean up resources before quitting
app.on('before-quit', async (event) => {
  // Avoid re-entry when we call app.exit()
  if (isQuitting) return
  isQuitting = true
  stopAutomaticUpdateChecks()

  // Ensure Cmd+Q/app quit bypasses layered window close interception (Cmd+W behavior).
  mainState.windowManager?.setAppQuitting(true)

  if (mainState.windowManager) {
    const windows = mainState.windowManager.getWindowStates()
    // Empty-snapshot guard: during update-quit, electron-updater has already
    // destroyed all BrowserWindows by the time before-quit fires. The pre-update
    // hook already saved the real state — don't let this late save overwrite it.
    if (windows.length === 0 && isUpdating()) {
      mainLog.warn('[window-state] skip save: empty snapshot during update-quit (pre-update snapshot wins)')
    } else {
      captureAndSaveWindowState('before-quit')
    }
    // Diagnostic correlation with installUpdate's [update-flow] log. During an
    // update-quit, record it to the dedicated always-on auto-update log (#891)
    // so the install/quit handoff is diagnosable in production; normal quits
    // stay on the debug-only main log.
    const isUpdateQuit = isUpdating()
    const beforeQuitSave = {
      windowCount: windows.length,
      electronWindowCount: BrowserWindow.getAllWindows().length,
      isUpdating: isUpdateQuit,
      reason: isUpdateQuit ? 'update-quit' : 'user-quit',
    }
    if (isUpdateQuit) {
      autoUpdateLog.info('before-quit save', beforeQuitSave)
    } else {
      mainLog.info('[update-flow] before-quit save', beforeQuitSave)
    }
  }

  // Flush all pending session writes before quitting
  if (mainState.sessionManager) {
    // Prevent quit until sessions are flushed
    event.preventDefault()
    try {
      await mainState.sessionManager.flushAllSessions()
      mainLog.info('Flushed all pending session writes')
    } catch (error) {
      mainLog.error('Failed to flush sessions:', error)
    }
    await runShutdownCleanup([
      ['sessions', () => mainState.sessionManager!.cleanup()],
      ['browser panes', () => mainState.browserPaneManager?.destroyAll()],
      ['OAuth flows', () => mainState.oauthFlowStore?.dispose()],
      ['model refresh', () => getModelRefreshService().stopAll()],
      ['messaging', () => mainState.messagingHandle?.dispose()],
      ['web UI', () => { mainState.embeddedWebuiHandler?.dispose(); mainState.embeddedWebuiHandler = null }],
      ['power manager', async () => { const { cleanup } = await import('./power-manager'); cleanup() }],
      ['server lock', () => releaseServerLock()],
    ], (step, error) => mainLog.error(`[shutdown] ${step} cleanup failed:`, error))

    // If update is in progress, let electron-updater handle the quit flow
    // Force exit breaks the NSIS installer on Windows
    if (isUpdating()) {
      mainLog.info('Update in progress, letting electron-updater handle quit')
      app.quit()
      return
    }

    // Now actually quit
    app.exit(0)
  }
})

// Handle uncaught exceptions — forward to Sentry explicitly since registering
// a custom handler can interfere with @sentry/electron's automatic capture.
process.on('uncaughtException', (error) => {
  mainLog.error('Uncaught exception:', error)
  Sentry.captureException(error)
})

process.on('unhandledRejection', (reason, promise) => {
  const error = reason instanceof Error ? reason : new Error(String(reason))
  mainLog.error('Unhandled rejection:', {
    name: error.name,
    message: error.message,
    stack: error.stack,
    promise: String(promise),
  })
  Sentry.captureException(error)
})
