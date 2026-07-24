/**
 * Stable production updater.
 *
 * Update policy:
 * - GitHub Releases is the only feed configured by electron-builder.
 * - Development and unpackaged runtimes are rejected.
 * - Prerelease versions are rejected.
 * - No launch check, background download or install-on-quit is allowed.
 * - The Settings update button is the only caller that starts the flow.
 */

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
let manualCheckInProgress = false

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
  if (!manualCheckInProgress) {
    autoUpdateLog.error('Ignored update event outside a manual Settings request')
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

/**
 * Run the complete check-and-download flow after an explicit Settings click.
 */
export async function checkForUpdates(): Promise<UpdateInfo> {
  assertUpdaterIsAllowed()
  if (manualCheckInProgress) return getUpdateInfo()

  manualCheckInProgress = true
  updateInfo = {
    ...updateInfo,
    downloadState: 'idle',
    downloadProgress: 0,
    error: undefined,
  }
  broadcastUpdateInfo()

  try {
    const result = await autoUpdater.checkForUpdates()
    const candidateVersion = result?.updateInfo.version
    if (
      updateInfo.available
      && candidateVersion
      && isStableReleaseVersion(candidateVersion)
      && updateInfo.downloadState !== 'ready'
    ) {
      updateInfo = {
        ...updateInfo,
        downloadState: 'downloading',
        downloadProgress: 0,
      }
      broadcastUpdateInfo()
      await autoUpdater.downloadUpdate()
    }
  } catch (error) {
    autoUpdateLog.error('Manual update request failed', error)
    updateInfo = {
      ...updateInfo,
      downloadState: 'error',
      error: error instanceof Error ? error.message : 'Update request failed',
    }
    broadcastUpdateInfo()
  } finally {
    manualCheckInProgress = false
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
