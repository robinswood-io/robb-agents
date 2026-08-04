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

import { spawn, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { clearDismissedUpdateVersion } from '@craft-agent/shared/config'
import { getAppVersion } from '@craft-agent/shared/version'
import type { EventSink } from '@craft-agent/server-core/transport'
import { RPC_CHANNELS, type UpdateInfo } from '../shared/types'
import {
  canUseStableUpdater,
  isDeveloperIdApplicationSignature,
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
  autoUpdateLog.info('Manual stable update check started')
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
    if (match?.[1]) return match[1].trim()
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
      const candidate = join(pendingDir, configuredPath)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // Older/broken caches can be missing update-info.json; fall through to file discovery.
  }

  try {
    const zip = readdirSync(pendingDir).find((entry) => entry.endsWith('.zip'))
    if (zip) return join(pendingDir, zip)
  } catch {
    // Fall through to the compatibility path used by electron-updater on macOS.
  }

  const compatibilityZip = join(cacheRoot, 'update.zip')
  if (existsSync(compatibilityZip)) return compatibilityZip
  throw new Error(`Downloaded macOS update zip not found in ${cacheRoot}`)
}

function currentMacAppUsesDeveloperIdSignature(): boolean {
  if (process.platform !== 'darwin') return false
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', process.execPath], {
    encoding: 'utf8',
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  return result.status === 0 && isDeveloperIdApplicationSignature(output)
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
TMP_DIR="$(mktemp -d "\${TMPDIR:-/tmp}/robb-agents-update.XXXXXX")"
cleanup() { rm -rf "$TMP_DIR"; }
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

mkdir -p "$BACKUP_DIR"
BACKUP_PATH=''
if [ -d "$APP_PATH" ]; then
  BACKUP_PATH="$BACKUP_DIR/Robb Agents.app.pre-update-$(date +%Y%m%d-%H%M%S)"
  echo "Backing up current app to $BACKUP_PATH"
  ditto "$APP_PATH" "$BACKUP_PATH"
fi

echo 'Replacing installed application...'
rm -rf "$APP_PATH"
ditto "$SRC" "$APP_PATH"
xattr -cr "$APP_PATH" || true
if ! validate_notarized_app "$APP_PATH"; then
  echo 'Installed application failed signature verification; restoring the previous version.'
  rm -rf "$APP_PATH"
  if [ -n "$BACKUP_PATH" ] && [ -d "$BACKUP_PATH" ]; then
    ditto "$BACKUP_PATH" "$APP_PATH"
    /usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"
  fi
  exit 1
fi
INSTALLED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")"
if [ "$INSTALLED_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "Installed application has unexpected version $INSTALLED_VERSION; restoring the previous version."
  rm -rf "$APP_PATH"
  if [ -n "$BACKUP_PATH" ] && [ -d "$BACKUP_PATH" ]; then
    ditto "$BACKUP_PATH" "$APP_PATH"
    /usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"
  fi
  exit 1
fi
echo "Installed version=$INSTALLED_VERSION"

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
  const cacheRoot = resolveMacUpdaterCacheRoot()
  const logDir = join(app.getPath('userData'), 'logs')
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, 'detached-macos-update.log')
  const backupDir = join(app.getPath('userData'), 'Backups')
  const scriptPath = writeDetachedMacInstallerScript()

  autoUpdateLog.warn('Installing macOS update with detached installer fallback', {
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
 * Check the stable feed after an explicit Settings click.
 *
 * Downloading is deliberately a separate action: finding a release must not
 * consume bandwidth or disk space until the user accepts it in Settings.
 */
export async function checkForUpdates(): Promise<UpdateInfo> {
  assertUpdaterIsAllowed()
  if (updateCheckInProgress) return getUpdateInfo()

  updateCheckInProgress = true
  updateInfo = {
    ...updateInfo,
    downloadState: 'idle',
    downloadProgress: 0,
    error: undefined,
  }
  broadcastUpdateInfo()

  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    autoUpdateLog.error('Manual update request failed', error)
    updateInfo = {
      ...updateInfo,
      downloadState: 'error',
      error: error instanceof Error ? error.message : 'Update request failed',
    }
    broadcastUpdateInfo()
  } finally {
    updateCheckInProgress = false
  }

  return getUpdateInfo()
}

/** Download the stable release previously discovered by checkForUpdates(). */
export async function downloadUpdate(): Promise<UpdateInfo> {
  assertUpdaterIsAllowed()
  if (updateInfo.downloadState === 'ready') return getUpdateInfo()
  if (!updateInfo.available || !updateInfo.latestVersion) {
    throw new Error('No stable update is available to download')
  }
  if (!isStableReleaseVersion(updateInfo.latestVersion)) {
    throw new Error(`Refused non-stable release ${updateInfo.latestVersion}`)
  }

  updateInfo = {
    ...updateInfo,
    downloadState: 'downloading',
    downloadProgress: 0,
    error: undefined,
  }
  broadcastUpdateInfo()

  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    updateInfo = {
      ...updateInfo,
      downloadState: 'error',
      error: error instanceof Error ? error.message : 'Update download failed',
    }
    broadcastUpdateInfo()
    throw error
  }

  return getUpdateInfo()
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
    if (process.platform === 'darwin' && !currentMacAppUsesDeveloperIdSignature()) {
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
