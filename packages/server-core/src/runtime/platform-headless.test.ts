import { afterEach, describe, expect, it } from 'bun:test'
import { createHeadlessPlatform } from './platform-headless'

const ENV_KEYS = [
  'CRAFT_VERSION',
  'CRAFT_BUILD_COMMIT',
  'ROBB_BUILD_COMMIT',
  'GITHUB_SHA',
  'CRAFT_BUILD_CHANNEL',
  'ROBB_BUILD_CHANNEL',
  'CRAFT_BUILD_DIRTY',
  'ROBB_BUILD_DIRTY',
] as const
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('headless platform build provenance', () => {
  it('exposes explicit build metadata supplied by the host', () => {
    for (const key of ENV_KEYS) delete process.env[key]
    const platform = createHeadlessPlatform({
      appVersion: '0.11.7',
      buildCommit: 'abc123',
      buildChannel: 'server',
      buildDirty: true,
    })

    expect(platform.appVersion).toBe('0.11.7')
    expect(platform.buildCommit).toBe('abc123')
    expect(platform.buildChannel).toBe('server')
    expect(platform.buildDirty).toBe(true)
  })

  it('lets canonical environment metadata override host defaults', () => {
    process.env.CRAFT_VERSION = '0.12.0'
    process.env.CRAFT_BUILD_COMMIT = 'def456'
    process.env.CRAFT_BUILD_CHANNEL = 'production'
    process.env.CRAFT_BUILD_DIRTY = 'false'

    const platform = createHeadlessPlatform({
      appVersion: 'ignored',
      buildCommit: 'ignored',
      buildChannel: 'ignored',
      buildDirty: true,
    })

    expect(platform.appVersion).toBe('0.12.0')
    expect(platform.buildCommit).toBe('def456')
    expect(platform.buildChannel).toBe('production')
    expect(platform.buildDirty).toBe(false)
  })
})
