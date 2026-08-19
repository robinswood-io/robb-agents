import { describe, expect, it } from 'bun:test'
import { createElectronPlatform } from '../platform'

describe('Electron platform build provenance', () => {
  it('exposes the packaged app version and canonical build metadata', () => {
    const platform = createElectronPlatform({
      app: {
        isPackaged: true,
        getAppPath: () => '/Applications/Robb Agents.app',
        getVersion: () => '0.11.7',
        quit() {},
      } as never,
      nativeImage: {} as never,
      shell: {} as never,
      nativeTheme: { shouldUseDarkColors: false } as never,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      isDebugMode: false,
      buildCommit: ' abc123 ',
      buildChannel: ' production ',
      buildDirty: false,
    })

    expect(platform.appVersion).toBe('0.11.7')
    expect(platform.isPackaged).toBe(true)
    expect(platform.buildCommit).toBe('abc123')
    expect(platform.buildChannel).toBe('production')
    expect(platform.buildDirty).toBe(false)
  })
})
