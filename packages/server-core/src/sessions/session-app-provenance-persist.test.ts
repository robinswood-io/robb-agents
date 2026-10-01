import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformServices } from '../runtime/platform'
import type { SessionAppProvenance } from '@craft-agent/shared/sessions'
import { loadSession, sessionPersistenceQueue } from '@craft-agent/shared/sessions'
import {
  SessionManager,
  createManagedSession,
  setSessionPlatform,
} from './SessionManager'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('SessionManager app provenance persistence', () => {
  it('updates lastUsedByApp without overwriting createdByApp', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'session-manager-app-provenance-'))
    tempDirs.push(workspaceRoot)
    const currentApp: SessionAppProvenance = {
      appVersion: '0.11.7',
      buildCommit: 'new123',
      buildChannel: 'production',
      buildDirty: false,
      isPackaged: true,
    }
    const platform: PlatformServices = {
      appRootPath: '/app',
      resourcesPath: '/resources',
      ...currentApp,
      imageProcessor: {
        async getMetadata() { return null },
        async process() { return Buffer.alloc(0) },
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      isDebugMode: false,
    }
    setSessionPlatform(platform)

    const createdByApp: SessionAppProvenance = {
      appVersion: '0.11.6',
      buildCommit: 'old456',
      buildChannel: 'development',
      buildDirty: true,
      isPackaged: false,
    }
    const managed = createManagedSession({
      id: 'persist-build-provenance',
      createdAt: 1,
      createdByApp,
      lastUsedByApp: createdByApp,
    }, {
      id: 'workspace-provenance',
      name: 'Workspace',
      rootPath: workspaceRoot,
      createdAt: 1,
    } as never, { messagesLoaded: true })

    const sessionManager = new SessionManager()
    ;(sessionManager as unknown as { persistSession: (session: unknown) => void })
      .persistSession(managed)
    await sessionPersistenceQueue.flush(managed.id)

    const stored = loadSession(workspaceRoot, managed.id)
    expect(stored?.createdByApp).toEqual(createdByApp)
    expect(stored?.lastUsedByApp).toEqual(currentApp)
  })
})
