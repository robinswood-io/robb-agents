import { omitUndefined } from '@craft-agent/shared/utils/json';
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

import { spawn } from 'node:child_process';
import "node:os";
import { basename, isAbsolute, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { clearDismissedUpdateVersion } from '@craft-agent/shared/config';
import { getAppVersion } from '@craft-agent/shared/version';
import { RPC_CHANNELS, type UpdateInfo } from '../shared/types';
import { canUseStableUpdater, isStableReleaseVersion, resolveAppChannel } from './app-channel';
import { autoUpdateLog, mainLog } from './logger';

import { resolveMacAppBundlePath, resolveMacUpdaterCacheRoot, resolvePendingMacUpdateZip, writeDetachedMacInstallerScript } from "./auto-update-mac";








import type { EventSink } from '@craft-agent/server-core/transport';




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
  updateInfo = omitUndefined<UpdateInfo>({
    ...updateInfo,
    available: true,
    latestVersion: info.version,
    downloadState: 'idle',
    downloadProgress: 0,
    error: undefined,
  })
  broadcastUpdateInfo()
})

autoUpdater.on('update-not-available', (info) => {
  autoUpdateLog.info('No stable update available', {
    currentVersion: updateInfo.currentVersion,
    feedVersion: info.version,
  })
  updateInfo = omitUndefined<UpdateInfo>({
    ...updateInfo,
    available: false,
    latestVersion: info.version,
    downloadState: 'idle',
    downloadProgress: 0,
    error: undefined,
  })
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
  updateInfo = omitUndefined<UpdateInfo>({
    ...updateInfo,
    available: true,
    latestVersion: info.version,
    downloadState: 'ready',
    downloadProgress: 100,
    error: undefined,
  })
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
    updateInfo = omitUndefined<UpdateInfo>({
      ...updateInfo,
      downloadState: 'idle',
      downloadProgress: 0,
      error: undefined,
    })
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
    }).catch((error: unknown) => {
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
    updateInfo = omitUndefined<UpdateInfo>({
      ...updateInfo,
      downloadState: 'downloading',
      downloadProgress: 0,
      error: undefined,
    })
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
