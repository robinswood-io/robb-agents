/**
 * Electron platform factory — creates PlatformServices from Electron APIs.
 *
 * Extracted from main/index.ts so it can be injected into bootstrapServer()
 * without duplicating construction logic.
 */

import type { PlatformServices } from '../runtime/platform'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  REQUIRED_PACKAGED_EXTERNAL_RUNTIME_PATHS,
  RUNTIME_INTEGRITY_MANIFEST_ASAR_PATH,
  verifyRuntimeIntegrityManifest,
} from '@craft-agent/shared/agent'

interface ElectronAppPathProvider {
  isPackaged: boolean
  getAppPath(): string
}

/**
 * Resolve the real filesystem root used by packaged subprocesses and tooling.
 *
 * With production ASAR enabled, app.getAppPath() points inside app.asar. That
 * virtual path works for Electron fs/require calls, but external Bun/Claude/MCP
 * processes cannot execute files through it. electron-builder stages their
 * runtime payload under Resources/app, which is the only valid packaged root.
 */
export function resolveElectronRuntimeAppRoot(
  app: ElectronAppPathProvider,
  resourcesPath = process.resourcesPath,
): string {
  if (!app.isPackaged) return process.cwd()

  const appPath = app.getAppPath()
  if (!appPath.endsWith('.asar')) return appPath

  const externalRuntimeRoot = join(resourcesPath, 'app')
  if (!existsSync(externalRuntimeRoot)) {
    throw new Error(
      `Packaged runtime root is missing: ${externalRuntimeRoot}. `
      + 'The ASAR package cannot launch external agent subprocesses without it.',
    )
  }
  const protectedManifestPath = join(appPath, RUNTIME_INTEGRITY_MANIFEST_ASAR_PATH)
  let protectedManifest: Buffer
  try {
    // Electron's fs shim reads this path from the integrity-protected ASAR.
    // The manifest must never be sourced from the mutable Resources/app tree.
    protectedManifest = readFileSync(protectedManifestPath)
  } catch (error) {
    throw new Error(
      `Protected external runtime manifest is missing: ${protectedManifestPath}`,
      { cause: error },
    )
  }
  verifyRuntimeIntegrityManifest(
    resourcesPath,
    protectedManifest,
    REQUIRED_PACKAGED_EXTERNAL_RUNTIME_PATHS,
  )
  return externalRuntimeRoot
}

export interface ElectronPlatformOptions {
  app: Electron.App
  nativeImage: typeof import('electron').nativeImage
  shell: typeof import('electron').shell
  nativeTheme: typeof import('electron').nativeTheme
  logger: PlatformServices['logger']
  isDebugMode: boolean
  buildCommit?: string
  buildChannel?: string
  buildDirty?: boolean
  runtimeAppRoot?: string
  resourcesPath?: string
  getLogFilePath?: () => string | undefined
  captureError?: (error: Error) => void
}

export function createElectronPlatform(opts: ElectronPlatformOptions): PlatformServices {
  const { app, nativeImage, shell, nativeTheme, logger } = opts
  const resourcesPath = opts.resourcesPath ?? process.resourcesPath

  return {
    appRootPath: opts.runtimeAppRoot ?? resolveElectronRuntimeAppRoot(app, resourcesPath),
    resourcesPath,
    isPackaged: app.isPackaged,
    appVersion: app.getVersion(),
    buildCommit: opts.buildCommit?.trim() || undefined,
    buildChannel: opts.buildChannel?.trim() || undefined,
    buildDirty: opts.buildDirty,
    openExternal: (url) => shell.openExternal(url),
    openPath: (p) => shell.openPath(p).then(() => {}),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    quit: () => app.quit(),
    systemDarkMode: () => nativeTheme.shouldUseDarkColors,
    imageProcessor: {
      async getMetadata(buffer) {
        const img = nativeImage.createFromBuffer(buffer)
        if (img.isEmpty()) return null
        const { width, height } = img.getSize()
        return (width && height) ? { width, height } : null
      },
      async process(input, processOpts = {}) {
        const img = typeof input === 'string'
          ? nativeImage.createFromPath(input)
          : nativeImage.createFromBuffer(input)
        if (img.isEmpty()) throw new Error('Invalid image input')

        let result = img
        if (processOpts.resize) {
          const { width: tw, height: th } = processOpts.resize
          const fit = processOpts.fit ?? 'inside'
          if (fit === 'inside') {
            const { width: sw, height: sh } = result.getSize()
            const scale = Math.min(tw / sw, th / sh, 1)
            result = result.resize({
              width: Math.round(sw * scale),
              height: Math.round(sh * scale),
            })
          } else {
            result = result.resize({ width: tw, height: th })
          }
        }
        return (processOpts.format === 'jpeg')
          ? result.toJPEG(processOpts.quality ?? 90)
          : result.toPNG()
      },
    },
    logger,
    isDebugMode: opts.isDebugMode,
    getLogFilePath: opts.getLogFilePath,
    captureError: opts.captureError,
  }
}
