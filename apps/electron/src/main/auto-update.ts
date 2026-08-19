/**
 * Stable production updater.
 *
 * Update policy:
 * - GitHub Releases is the only feed configured by electron-builder.
 * - Development and unpackaged runtimes are rejected.
 * - Prerelease versions are rejected.
 * - A lightweight launch check is allowed, but downloads always require user consent.
 * - No background download or install-on-quit is allowed.
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { clearDismissedUpdateVersion } from '@craft-agent/shared/config'
import { getAppVersion } from '@craft-agent/shared/version'
import type { EventSink } from '@craft-agent/server-core/transport'
import { RPC_CHANNELS, type UpdateInfo } from '../shared/types'
import {
  canUseStableUpdater,
  isStableReleaseVersion,
  resolveAppChannel,
} from './app-channel'
import { autoUpdateLog, mainLog } from './logger'

let updateInfo: UpdateInfo = {
  available: false,
  currentVersion: getAppVersion(),
  latestVersion: null,
  downloadState: 'idle',
  downloadProgress: 0,
}

let eventSink: EventSink | null = null
let beforeUpdateQuitHook: (() => void) | null = null
let updateInProgress = false
let updateCheckInProgress = false
let activeUpdateCheckSource: 'manual' | 'automatic' | null = null
let updateCheckPromise: Promise<UpdateInfo> | null = null
let updateDownloadPromise: Promise<UpdateInfo> | null = null
let automaticUpdateTimer: NodeJS.Timeout | null = null
let automaticUpdateChecksStarted = false
let consecutiveAutomaticCheckFailures = 0

const AUTOMATIC_UPDATE_INITIAL_DELAY_MS = 30_000
const AUTOMATIC_UPDATE_SUCCESS_INTERVAL_MS = 6 * 60 * 60 * 1000
const AUTOMATIC_UPDATE_RETRY_BASE_MS = 15 * 60 * 1000
const AUTOMATIC_UPDATE_RETRY_MAX_MS = 60 * 60 * 1000

autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false
autoUpdater.allowPrerelease = false
autoUpdater.allowDowngrade = false
autoUpdater.logger = {
  info: (message: unknown) => mainLog.info('[electron-updater]', message),
  warn: (message: unknown) => mainLog.warn('[electron-updater]', message),
  error: (message: unknown) => mainLog.error('[electron-updater]', message),
  debug: (message: unknown) => mainLog.info('[electron-updater:debug]', message),
}

function updaterIsAllowed(): boolean {
  return canUseStableUpdater(app.isPackaged, resolveAppChannel(app.isPackaged))
}

function assertUpdaterIsAllowed(): void {
  if (!updaterIsAllowed()) {
    throw new Error('Stable updates are available only in the packaged production application')
  }
}

function broadcastUpdateInfo(): void {
  eventSink?.(RPC_CHANNELS.update.AVAILABLE, { to: 'all' }, { ...updateInfo })
}

function broadcastDownloadProgress(progress: number): void {
  eventSink?.(RPC_CHANNELS.update.DOWNLOAD_PROGRESS, { to: 'all' }, progress)
}

autoUpdater.on('checking-for-update', () => {
  autoUpdateLog.info(`${activeUpdateCheckSource === 'automatic' ? 'Automatic' : 'Manual'} stable update check started`)
})

autoUpdater.on('update-available', (info) => {
  if (!updateCheckInProgress) {
    autoUpdateLog.error('Ignored update event outside an application update check')
    return
  }
  if (!isStableReleaseVersion(info.version)) {
    updateInfo = {
      ...updateInfo,
      available: false,
      latestVersion: info.version,
      downloadState: 'error',
      error: `Refused non-stable release ${info.version}`,
    }
    broadcastUpdateInfo()
    return
  }

  autoUpdateLog.info(`Stable update available: ${updateInfo.currentVersion} → ${info.version}`)
  updateInfo = {
    ...updateInfo,
    available: true,
    latestVersion: info.version,
    downloadState: 'idle',
    downloadProgress: 0,
    error: undefined,
  }
  broadcastUpdateInfo()
})

autoUpdater.on('update-not-available', (info) => {
  autoUpdateLog.info('No stable update available', {
    currentVersion: updateInfo.currentVersion,
    feedVersion: info.version,
  })
  updateInfo = {
    ...updateInfo,
    available: false,
    latestVersion: info.version,
    downloadState: 'idle',
    downloadProgress: 0,
    error: undefined,
  }
  broadcastUpdateInfo()
})

autoUpdater.on('download-progress', (progress) => {
  const percent = Math.round(progress.percent)
  updateInfo = {
    ...updateInfo,
    downloadState: 'downloading',
    downloadProgress: percent,
  }
  broadcastDownloadProgress(percent)
  broadcastUpdateInfo()
})

autoUpdater.on('update-downloaded', (info) => {
  if (!isStableReleaseVersion(info.version)) {
    updateInfo = {
      ...updateInfo,
      downloadState: 'error',
      error: `Refused non-stable downloaded release ${info.version}`,
    }
    broadcastUpdateInfo()
    return
  }

  autoUpdateLog.info(`Stable update downloaded: v${info.version}`)
  updateInfo = {
    ...updateInfo,
    available: true,
    latestVersion: info.version,
    downloadState: 'ready',
    downloadProgress: 100,
    error: undefined,
  }
  broadcastUpdateInfo()
})

autoUpdater.on('error', (error) => {
  autoUpdateLog.error('electron-updater error', error)
  updateInfo = {
    ...updateInfo,
    downloadState: 'error',
    error: error.message,
  }
  broadcastUpdateInfo()
})

export function setBeforeUpdateQuitHook(hook: () => void): void {
  beforeUpdateQuitHook = hook
}

export function setAutoUpdateEventSink(sink: EventSink): void {
  eventSink = sink
}

export function isUpdating(): boolean {
  return updateInProgress
}

export function getUpdateInfo(): UpdateInfo {
  return { ...updateInfo }
}

function resolveMacAppBundlePath(): string {
  return dirname(dirname(dirname(process.execPath)))
}

function readUpdaterCacheDirName(): string {
  const updateConfigPath = join(process.resourcesPath, 'app-update.yml')
  try {
    const config = readFileSync(updateConfigPath, 'utf8')
    const match = config.match(/^updaterCacheDirName:\s*['"]?([^'"\n]+)['"]?\s*$/m)
    if (match?.[1]) {
      const cacheDirName = match[1].trim()
      if (cacheDirName && cacheDirName !== '.' && cacheDirName !== '..' && basename(cacheDirName) === cacheDirName) {
        return cacheDirName
      }
      autoUpdateLog.warn('Ignored unsafe updater cache directory name; using bundled default')
    }
  } catch (error) {
    autoUpdateLog.warn('Could not read updater cache directory name; using bundled default', error)
  }
  return '@craft-agentelectron-updater'
}

function resolveMacUpdaterCacheRoot(): string {
  return join(homedir(), 'Library', 'Caches', readUpdaterCacheDirName())
}

function resolvePendingMacUpdateZip(): string {
  const cacheRoot = resolveMacUpdaterCacheRoot()
  const pendingDir = join(cacheRoot, 'pending')
  const updateInfoPath = join(pendingDir, 'update-info.json')

  try {
    const info = JSON.parse(readFileSync(updateInfoPath, 'utf8')) as { fileName?: string; path?: string }
    const configuredPath = info.path ?? info.fileName
    if (configuredPath) {
      // update-info.json is local updater state, but constrain it to the pending
      // directory anyway so a corrupted cache cannot redirect installation.
      const candidate = join(pendingDir, basename(configuredPath))
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // Older/broken caches can be missing update-info.json; fall through to file discovery.
  }

  try {
    // Broken/legacy caches may omit update-info.json. Prefer the most recently
    // written ZIP instead of filesystem enumeration order, which can select a
    // stale update when multiple archives remain.
    const zip = readdirSync(pendingDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.zip'))
      .map(entry => ({
        name: entry.name,
        modifiedAt: statSync(join(pendingDir, entry.name)).mtimeMs,
      }))
      .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]
    if (zip) return join(pendingDir, zip.name)
  } catch {
    // Fall through to the compatibility path used by electron-updater on macOS.
  }

  const compatibilityZip = join(cacheRoot, 'update.zip')
  if (existsSync(compatibilityZip)) return compatibilityZip
  throw new Error(`Downloaded macOS update zip not found in ${cacheRoot}`)
}

function writeDetachedMacInstallerScript(): string {
  const scriptPath = join(app.getPath('temp'), `robb-agents-detached-update-${Date.now()}.sh`)
  const script = `#!/usr/bin/env bash
set -euo pipefail
ZIP_PATH="$1"
APP_PATH="$2"
EXPECTED_VERSION="$3"
CACHE_ROOT="$4"
LOG_PATH="$5"
BACKUP_DIR="$6"
exec >>"$LOG_PATH" 2>&1
printf '\n==== Robb detached macOS update started %s ====\n' "$(date -Iseconds)"
echo "zip=$ZIP_PATH"
echo "app=$APP_PATH"
echo "expectedVersion=$EXPECTED_VERSION"
if [[ "$APP_PATH" != /* || "$(basename "$APP_PATH")" != 'Robb Agents.app' ]]; then
  echo "Unsafe application replacement target: $APP_PATH"
  exit 1
fi
TMP_DIR="$(mktemp -d "\${TMPDIR:-/tmp}/robb-agents-update.XXXXXX")"
STAGED_ROOT=''
OLD_APP_PATH=''
cleanup() {
  rm -rf "$TMP_DIR"
  if [ -n "$STAGED_ROOT" ]; then rm -rf "$STAGED_ROOT"; fi
  rm -f "$0"
}
trap cleanup EXIT

validate_notarized_app() {
  local bundle="$1"
  local signature_details
  local assessment
  if ! /usr/bin/codesign --verify --deep --strict --verbose=2 "$bundle"; then
    return 1
  fi
  signature_details="$(/usr/bin/codesign -dv --verbose=4 "$bundle" 2>&1)"
  printf '%s\n' "$signature_details"
  if ! printf '%s\n' "$signature_details" | /usr/bin/grep -Eq '^Authority=Developer ID Application: .+$'; then
    return 1
  fi
  if ! printf '%s\n' "$signature_details" | /usr/bin/grep -Eq '^TeamIdentifier=[A-Z0-9]{10}$'; then
    return 1
  fi
  if ! assessment="$(/usr/sbin/spctl --assess --type execute --verbose=4 "$bundle" 2>&1)"; then
    printf '%s\n' "$assessment"
    return 1
  fi
  printf '%s\n' "$assessment"
  printf '%s\n' "$assessment" | /usr/bin/grep -Eq 'source=Notarized Developer ID'
}

for _ in {1..60}; do
  if ! pgrep -f "$APP_PATH/Contents/MacOS" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if pgrep -f "$APP_PATH/Contents/MacOS" >/dev/null 2>&1; then
  echo 'Robb Agents did not quit in time; stopping remaining app processes.'
  pkill -f "$APP_PATH/Contents/MacOS" || true
  sleep 2
fi

echo 'Extracting downloaded update...'
unzip -q "$ZIP_PATH" -d "$TMP_DIR"
SRC="$TMP_DIR/Robb Agents.app"
if [ ! -d "$SRC" ]; then
  echo 'Archive does not contain Robb Agents.app'
  exit 1
fi
find "$SRC" -name '._*' -delete
xattr -cr "$SRC" || true
if ! validate_notarized_app "$SRC"; then
  echo 'Downloaded update is not signed and notarized with Apple Developer ID; refusing installation.'
  exit 1
fi
ACTUAL_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$SRC/Contents/Info.plist")"
if [ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "Unexpected update version: $ACTUAL_VERSION"
  exit 1
fi

APP_PARENT="$(dirname "$APP_PATH")"
STAGED_ROOT="$(mktemp -d "$APP_PARENT/.robb-agents-update.XXXXXX")"
STAGED_APP="$STAGED_ROOT/Robb Agents.app"
echo "Staging verified update beside installed application..."
ditto "$SRC" "$STAGED_APP"
xattr -cr "$STAGED_APP" || true
if ! validate_notarized_app "$STAGED_APP"; then
  echo 'Staged application failed signature verification; refusing installation.'
  exit 1
fi
STAGED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$STAGED_APP/Contents/Info.plist")"
if [ "$STAGED_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "Staged application has unexpected version $STAGED_VERSION"
  exit 1
fi

mkdir -p "$BACKUP_DIR"
BACKUP_PATH=''
if [ -d "$APP_PATH" ]; then
  BACKUP_PATH="$BACKUP_DIR/Robb Agents.app.pre-update-$(date +%Y%m%d-%H%M%S)"
  echo "Backing up current app to $BACKUP_PATH"
  ditto "$APP_PATH" "$BACKUP_PATH"
fi

restore_previous_app() {
  echo 'Restoring previous application...'
  rm -rf "$APP_PATH"
  if [ -n "$OLD_APP_PATH" ] && [ -d "$OLD_APP_PATH" ]; then
    mv "$OLD_APP_PATH" "$APP_PATH"
    OLD_APP_PATH=''
  elif [ -n "$BACKUP_PATH" ] && [ -d "$BACKUP_PATH" ]; then
    ditto "$BACKUP_PATH" "$APP_PATH"
  fi
}

echo 'Replacing installed application transactionally...'
if [ -d "$APP_PATH" ]; then
  OLD_APP_PATH="$APP_PARENT/.Robb Agents.app.pre-update-$$"
  if ! mv "$APP_PATH" "$OLD_APP_PATH"; then
    echo 'Could not move the installed application aside; leaving it untouched.'
    exit 1
  fi
fi
if ! mv "$STAGED_APP" "$APP_PATH"; then
  echo 'Could not activate the staged update.'
  restore_previous_app
  exit 1
fi
xattr -cr "$APP_PATH" || true
if ! validate_notarized_app "$APP_PATH"; then
  echo 'Installed application failed signature verification; restoring the previous version.'
  restore_previous_app
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"
  exit 1
fi
INSTALLED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")"
if [ "$INSTALLED_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "Installed application has unexpected version $INSTALLED_VERSION; restoring the previous version."
  restore_previous_app
  /usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"
  exit 1
fi
echo "Installed version=$INSTALLED_VERSION"
if [ -n "$OLD_APP_PATH" ] && [ -d "$OLD_APP_PATH" ]; then
  rm -rf "$OLD_APP_PATH"
  OLD_APP_PATH=''
fi

# Retain only the three newest recoverable backups to keep userData bounded.
shopt -s nullglob
backups=("$BACKUP_DIR"/Robb\ Agents.app.pre-update-*)
if [ "\${#backups[@]}" -gt 3 ]; then
  remove_count=$((\${#backups[@]} - 3))
  for ((index=0; index<remove_count; index++)); do
    rm -rf "\${backups[$index]}"
  done
fi

rm -rf "$CACHE_ROOT/pending" "$CACHE_ROOT/update.zip" "$HOME/Library/Caches/io.robinswood.robbagents.ShipIt"

echo 'Relaunching Robb Agents...'
open "$APP_PATH"
printf '==== Robb detached macOS update finished %s ====\n' "$(date -Iseconds)"
`
  writeFileSync(scriptPath, script, { mode: 0o755 })
  return scriptPath
}

function installMacUpdateWithDetachedInstaller(): void {
  if (process.platform !== 'darwin') {
    throw new Error('Detached update installer is macOS-only')
  }
  const latestVersion = updateInfo.latestVersion
  if (!latestVersion || !isStableReleaseVersion(latestVersion)) {
    throw new Error('No stable macOS update version is ready to install')
  }

  const zipPath = resolvePendingMacUpdateZip()
  const appBundlePath = resolveMacAppBundlePath()
  if (!isAbsolute(appBundlePath) || basename(appBundlePath) !== 'Robb Agents.app' || !existsSync(appBundlePath)) {
    throw new Error(`Refusing unsafe macOS application replacement target: ${appBundlePath}`)
  }
  const cacheRoot = resolveMacUpdaterCacheRoot()
  const logDir = join(app.getPath('userData'), 'logs')
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, 'detached-macos-update.log')
  const backupDir = join(app.getPath('userData'), 'Backups')
  const scriptPath = writeDetachedMacInstallerScript()

  autoUpdateLog.info('Installing macOS update with verified detached installer', {
    appBundlePath,
    cacheRoot,
    latestVersion,
    logPath,
    zipPath,
  })

  const child = spawn('/bin/bash', [scriptPath, zipPath, appBundlePath, latestVersion, cacheRoot, logPath, backupDir], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  app.quit()
}

/**
 * Check the stable feed, either after an explicit Settings click or from the
 * bounded main-process scheduler.
 *
 * Downloading is deliberately a separate action: finding a release must not
 * consume bandwidth or disk space until the user accepts it in Settings.
 */
export async function checkForUpdates(
  source: 'manual' | 'automatic' = 'manual',
): Promise<UpdateInfo> {
  assertUpdaterIsAllowed()
  if (updateInfo.downloadState === 'downloading'
    || updateInfo.downloadState === 'ready'
    || updateInfo.downloadState === 'installing') {
    return getUpdateInfo()
  }
  if (updateCheckPromise) return updateCheckPromise

  const operation = (async (): Promise<UpdateInfo> => {
    updateCheckInProgress = true
    activeUpdateCheckSource = source
    updateInfo = {
      ...updateInfo,
      downloadState: 'idle',
      downloadProgress: 0,
      error: undefined,
    }
    broadcastUpdateInfo()

    try {
      await autoUpdater.checkForUpdates()
      return getUpdateInfo()
    } catch (error) {
      autoUpdateLog.error(`${source === 'automatic' ? 'Automatic' : 'Manual'} update request failed`, error)
      updateInfo = {
        ...updateInfo,
        downloadState: 'error',
        error: error instanceof Error ? error.message : 'Update request failed',
      }
      broadcastUpdateInfo()
      throw error
    } finally {
      updateCheckInProgress = false
      activeUpdateCheckSource = null
    }
  })()

  updateCheckPromise = operation
  try {
    return await operation
  } finally {
    if (updateCheckPromise === operation) updateCheckPromise = null
  }
}

function scheduleAutomaticUpdateCheck(delayMs: number): void {
  if (!automaticUpdateChecksStarted || automaticUpdateTimer) return

  automaticUpdateTimer = setTimeout(() => {
    automaticUpdateTimer = null
    void checkForUpdates('automatic').then(() => {
      consecutiveAutomaticCheckFailures = 0
      scheduleAutomaticUpdateCheck(AUTOMATIC_UPDATE_SUCCESS_INTERVAL_MS)
    }).catch((error) => {
      consecutiveAutomaticCheckFailures++
      const retryDelay = Math.min(
        AUTOMATIC_UPDATE_RETRY_BASE_MS * (2 ** (consecutiveAutomaticCheckFailures - 1)),
        AUTOMATIC_UPDATE_RETRY_MAX_MS,
      )
      autoUpdateLog.warn('Automatic stable update check will retry', {
        error: error instanceof Error ? error.message : String(error),
        retryDelayMs: retryDelay,
      })
      scheduleAutomaticUpdateCheck(retryDelay)
    })
  }, delayMs)
  automaticUpdateTimer.unref?.()
}

/**
 * Start bounded availability checks in the main process. This never downloads
 * or installs an update; those actions remain explicit user choices.
 */
export function startAutomaticUpdateChecks(): void {
  if (!updaterIsAllowed() || automaticUpdateChecksStarted) return
  automaticUpdateChecksStarted = true
  consecutiveAutomaticCheckFailures = 0
  autoUpdateLog.info('Automatic stable update checks scheduled', {
    initialDelayMs: AUTOMATIC_UPDATE_INITIAL_DELAY_MS,
    successIntervalMs: AUTOMATIC_UPDATE_SUCCESS_INTERVAL_MS,
  })
  scheduleAutomaticUpdateCheck(AUTOMATIC_UPDATE_INITIAL_DELAY_MS)
}

export function stopAutomaticUpdateChecks(): void {
  automaticUpdateChecksStarted = false
  consecutiveAutomaticCheckFailures = 0
  if (automaticUpdateTimer) {
    clearTimeout(automaticUpdateTimer)
    automaticUpdateTimer = null
  }
}

/** Download the stable release previously discovered by checkForUpdates(). */
export async function downloadUpdate(): Promise<UpdateInfo> {
  assertUpdaterIsAllowed()
  if (updateInfo.downloadState === 'ready') return getUpdateInfo()
  if (updateDownloadPromise) return updateDownloadPromise
  if (!updateInfo.available || !updateInfo.latestVersion) {
    throw new Error('No stable update is available to download')
  }
  if (!isStableReleaseVersion(updateInfo.latestVersion)) {
    throw new Error(`Refused non-stable release ${updateInfo.latestVersion}`)
  }

  const operation = (async (): Promise<UpdateInfo> => {
    updateInfo = {
      ...updateInfo,
      downloadState: 'downloading',
      downloadProgress: 0,
      error: undefined,
    }
    broadcastUpdateInfo()

    try {
      await autoUpdater.downloadUpdate()
      return getUpdateInfo()
    } catch (error) {
      updateInfo = {
        ...updateInfo,
        downloadState: 'error',
        error: error instanceof Error ? error.message : 'Update download failed',
      }
      broadcastUpdateInfo()
      throw error
    }
  })()

  updateDownloadPromise = operation
  try {
    return await operation
  } finally {
    if (updateDownloadPromise === operation) updateDownloadPromise = null
  }
}

export async function installUpdate(): Promise<void> {
  assertUpdaterIsAllowed()
  if (updateInfo.downloadState !== 'ready') {
    throw new Error('No stable update is ready to install')
  }

  updateInfo = { ...updateInfo, downloadState: 'installing' }
  broadcastUpdateInfo()
  clearDismissedUpdateVersion()
  updateInProgress = true

  autoUpdateLog.info('Installing stable update from the Settings flow', {
    electronWindowCount: BrowserWindow.getAllWindows().length,
    latestVersion: updateInfo.latestVersion,
  })

  try {
    beforeUpdateQuitHook?.()
    stopAutomaticUpdateChecks()
    if (process.platform === 'darwin') {
      installMacUpdateWithDetachedInstaller()
      return
    }
    autoUpdater.quitAndInstall(false, true)
  } catch (error) {
    updateInProgress = false
    updateInfo = {
      ...updateInfo,
      downloadState: 'error',
      error: error instanceof Error ? error.message : 'Update installation failed',
    }
    broadcastUpdateInfo()
    throw error
  }
}
