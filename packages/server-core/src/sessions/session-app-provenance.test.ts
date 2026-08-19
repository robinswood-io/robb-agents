import { describe, expect, it } from 'bun:test'
import type { PlatformServices } from '../runtime/platform'
import type { SessionAppProvenance } from '@craft-agent/shared/sessions'
import {
  getPlatformSessionAppProvenance,
  resolveImportedSessionAppProvenance,
  toRoutingMetaAppProvenance,
} from './session-app-provenance'

function platform(overrides: Partial<PlatformServices> = {}): PlatformServices {
  return {
    appRootPath: '/app',
    resourcesPath: '/resources',
    isPackaged: true,
    appVersion: ' 0.11.7 ',
    buildCommit: ' abc123 ',
    buildChannel: ' production ',
    buildDirty: false,
    imageProcessor: {
      async getMetadata() { return null },
      async process() { return Buffer.alloc(0) },
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    isDebugMode: false,
    ...overrides,
  }
}

const sourceBuild: SessionAppProvenance = {
  appVersion: '0.11.6',
  buildCommit: 'old456',
  buildChannel: 'production',
  buildDirty: true,
  isPackaged: true,
}

describe('session app provenance resolution', () => {
  it('normalizes platform metadata and preserves an explicit clean flag', () => {
    const provenance = getPlatformSessionAppProvenance(platform())
    expect(provenance).toEqual({
      appVersion: '0.11.7',
      buildCommit: 'abc123',
      buildChannel: 'production',
      buildDirty: false,
      isPackaged: true,
    })
    expect(toRoutingMetaAppProvenance(provenance)).toEqual(provenance!)
  })

  it('preserves origin on move and assigns a new origin on fork', () => {
    const currentApp = getPlatformSessionAppProvenance(platform())!
    const source = { createdByApp: sourceBuild, lastUsedByApp: sourceBuild }

    expect(resolveImportedSessionAppProvenance('move', source, currentApp)).toEqual({
      createdByApp: sourceBuild,
      lastUsedByApp: currentApp,
    })
    expect(resolveImportedSessionAppProvenance('fork', source, currentApp)).toEqual({
      createdByApp: currentApp,
      lastUsedByApp: currentApp,
    })
  })

  it('does not fabricate provenance without a valid app version', () => {
    expect(getPlatformSessionAppProvenance(null)).toBeUndefined()
    expect(getPlatformSessionAppProvenance(platform({ appVersion: ' ' }))).toBeUndefined()
  })
})
