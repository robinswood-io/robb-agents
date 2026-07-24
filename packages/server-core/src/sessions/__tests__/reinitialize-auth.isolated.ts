import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PlatformServices } from '@craft-agent/server-core/runtime'

describe('SessionManager reinitializeAuth', () => {
  let tmpConfigRoot: string
  let previousConfigDir: string | undefined

  beforeEach(() => {
    previousConfigDir = process.env.CRAFT_CONFIG_DIR
    tmpConfigRoot = mkdtempSync(join(tmpdir(), 'sm-reinitialize-auth-'))
    process.env.CRAFT_CONFIG_DIR = tmpConfigRoot
  })

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CRAFT_CONFIG_DIR
    } else {
      process.env.CRAFT_CONFIG_DIR = previousConfigDir
    }
    rmSync(tmpConfigRoot, { recursive: true, force: true })
  })

  it('does not log an error when no default LLM connection is configured', async () => {
    mkdirSync(tmpConfigRoot, { recursive: true })
    writeFileSync(join(tmpConfigRoot, 'config.json'), JSON.stringify({
      workspaces: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      llmConnections: [],
    }, null, 2))

    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }
    const platform: PlatformServices = {
      appRootPath: tmpConfigRoot,
      resourcesPath: tmpConfigRoot,
      isPackaged: false,
      appVersion: 'test',
      imageProcessor: {
        getMetadata: async () => null,
        process: async (input) => Buffer.isBuffer(input) ? input : Buffer.from(input),
      },
      logger,
      isDebugMode: false,
    }
    const { SessionManager, setSessionPlatform } = await import('../SessionManager.ts')
    setSessionPlatform(platform)

    const sm = new SessionManager()
    await sm.reinitializeAuth()

    expect(logger.warn).toHaveBeenCalledWith('[session]', 'No LLM connection slug available for reinitializeAuth')
    expect(logger.error).not.toHaveBeenCalled()
  })
})
