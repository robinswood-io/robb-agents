/**
 * Headless PlatformServices — runs under Bun without Electron.
 *
 * Uses sharp for image processing, console for logging.
 * GUI-only methods (openPath, openExternal, quit, etc.) are left undefined —
 * handlers guard them with optional chaining and capabilities handle client-side ops.
 */

import { join } from 'path'
import type { PlatformServices, Logger } from './platform'

/**
 * Simple console-based logger matching the Logger interface.
 * Prefixes each line with ISO timestamp and level for structured grepping.
 */
function createConsoleLogger(): Logger {
  const fmt = (level: string, args: unknown[]) => {
    const ts = new Date().toISOString()
    const parts = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
    return `${ts} ${level.toUpperCase().padEnd(5)} ${parts}`
  }
  return {
    info: (...args) => console.log(fmt('info', args)),
    warn: (...args) => console.warn(fmt('warn', args)),
    error: (...args) => console.error(fmt('error', args)),
    debug: (...args) => {
      if (process.env.CRAFT_DEBUG === 'true' || process.env.CRAFT_IS_PACKAGED !== 'true') {
        console.debug(fmt('debug', args))
      }
    },
  }
}

/**
 * Create PlatformServices for headless (Bun) mode.
 *
 * Environment variables:
 * - CRAFT_APP_ROOT — override appRootPath (default: cwd)
 * - CRAFT_RESOURCES_PATH — override resourcesPath (default: cwd/resources)
 * - CRAFT_IS_PACKAGED — 'true' for production (default: false)
 * - CRAFT_VERSION — app version string (default: '0.0.0-dev')
 * - CRAFT_BUILD_COMMIT / ROBB_BUILD_COMMIT — source revision (optional)
 * - CRAFT_BUILD_CHANNEL / ROBB_BUILD_CHANNEL — distribution channel (optional)
 * - CRAFT_BUILD_DIRTY / ROBB_BUILD_DIRTY — whether the source tree was dirty (optional)
 * - CRAFT_DEBUG — 'true' to enable debug logging
 */
export function createHeadlessPlatform(options?: {
  appVersion?: string
  buildCommit?: string
  buildChannel?: string
  buildDirty?: boolean
}): PlatformServices {
  const logger = createConsoleLogger()
  const isDebugMode = process.env.CRAFT_DEBUG === 'true' || process.env.CRAFT_IS_PACKAGED !== 'true'
  const buildCommit = process.env.CRAFT_BUILD_COMMIT
    || process.env.ROBB_BUILD_COMMIT
    || process.env.GITHUB_SHA
    || options?.buildCommit
  const buildChannel = process.env.CRAFT_BUILD_CHANNEL
    || process.env.ROBB_BUILD_CHANNEL
    || options?.buildChannel
  const declaredBuildDirty = (process.env.CRAFT_BUILD_DIRTY ?? process.env.ROBB_BUILD_DIRTY)
    ?.trim()
    .toLowerCase()
  const buildDirty = declaredBuildDirty === 'true' || declaredBuildDirty === '1' || declaredBuildDirty === 'dirty'
    ? true
    : declaredBuildDirty === 'false' || declaredBuildDirty === '0' || declaredBuildDirty === 'clean'
      ? false
      : options?.buildDirty

  return {
    appRootPath: process.env.CRAFT_APP_ROOT || process.cwd(),
    resourcesPath: process.env.CRAFT_RESOURCES_PATH || join(process.cwd(), 'resources'),
    isPackaged: process.env.CRAFT_IS_PACKAGED === 'true',
    appVersion: process.env.CRAFT_VERSION || options?.appVersion || '0.0.0-dev',
    buildCommit: buildCommit?.trim() || undefined,
    buildChannel: buildChannel?.trim() || undefined,
    buildDirty,

    imageProcessor: {
      async getMetadata(buffer) {
        const sharp = (await import('sharp')).default
        const m = await sharp(buffer).metadata().catch(() => null)
        return (m?.width && m?.height) ? { width: m.width, height: m.height } : null
      },
      async process(input, opts = {}) {
        const sharp = (await import('sharp')).default
        let pipeline = sharp(input)
        if (opts.resize) {
          pipeline = pipeline.resize(opts.resize.width, opts.resize.height, {
            fit: opts.fit ?? 'inside',
          })
        }
        if (opts.format === 'jpeg') {
          pipeline = pipeline.jpeg({ quality: opts.quality ?? 90 })
        } else {
          pipeline = pipeline.png()
        }
        return pipeline.toBuffer()
      },
    },

    logger,
    isDebugMode,

    captureError: (err) => {
      logger.error('[captureError]', err.message, err.stack)
    },

    // GUI methods intentionally undefined — headless mode.
    // Handlers guard these with optional chaining (?.) or capability routing.
    // openPath, openExternal, showItemInFolder, quit, systemDarkMode → undefined
  }
}
