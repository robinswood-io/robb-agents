import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionAppProvenance } from '../types'
import { createSession, listSessions, loadSession, saveSession } from '../storage'
import { serializeSession } from '../bundle'

const tempDirs: string[] = []

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'session-app-provenance-'))
  tempDirs.push(workspace)
  return workspace
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('session app build provenance persistence', () => {
  it('round-trips creation and last-use builds through JSONL and list metadata', async () => {
    const workspace = makeWorkspace()
    const createdByApp: SessionAppProvenance = {
      appVersion: '0.11.6',
      buildCommit: 'abc123',
      buildChannel: 'production',
      buildDirty: false,
      isPackaged: true,
    }
    const session = await createSession(workspace, {
      createdByApp,
      lastUsedByApp: createdByApp,
    })

    const loaded = loadSession(workspace, session.id)
    expect(loaded?.createdByApp).toEqual(createdByApp)
    expect(loaded?.lastUsedByApp).toEqual(createdByApp)
    expect(listSessions(workspace).find(item => item.id === session.id)?.createdByApp)
      .toEqual(createdByApp)
    expect(serializeSession(workspace, session.id)?.session.header.createdByApp)
      .toEqual(createdByApp)

    const newerBuild: SessionAppProvenance = {
      appVersion: '0.11.7',
      buildCommit: 'def456',
      buildChannel: 'development',
      buildDirty: true,
      isPackaged: false,
    }
    loaded!.lastUsedByApp = newerBuild
    await saveSession(loaded!)

    const reloaded = loadSession(workspace, session.id)
    expect(reloaded?.createdByApp).toEqual(createdByApp)
    expect(reloaded?.lastUsedByApp).toEqual(newerBuild)
  })

  it('keeps legacy sessions valid when provenance is absent', async () => {
    const workspace = makeWorkspace()
    const session = await createSession(workspace)
    const loaded = loadSession(workspace, session.id)

    expect(loaded?.createdByApp).toBeUndefined()
    expect(loaded?.lastUsedByApp).toBeUndefined()
  })
})
