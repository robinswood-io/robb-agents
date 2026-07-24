import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  DEVELOPMENT_CONFIG_DIR_NAME,
  PRODUCTION_CONFIG_DIR_NAME,
  resolveBuildChannel,
  resolveConfigDir,
} from '../paths.ts'

describe('resolveConfigDir()', () => {
  let originalCraftConfigDir: string | undefined

  beforeEach(() => {
    originalCraftConfigDir = process.env.CRAFT_CONFIG_DIR
    delete process.env.CRAFT_CONFIG_DIR
  })

  afterEach(() => {
    if (originalCraftConfigDir === undefined) {
      delete process.env.CRAFT_CONFIG_DIR
    } else {
      process.env.CRAFT_CONFIG_DIR = originalCraftConfigDir
    }
  })

  it('uses the established Craft Agents root by default so no data migration is needed', () => {
    expect(resolveConfigDir(undefined, '/Users/example', 'production')).toBe(
      `/Users/example/${PRODUCTION_CONFIG_DIR_NAME}`,
    )
  })

  it('uses an isolated profile for development builds', () => {
    expect(resolveConfigDir(undefined, '/Users/example', 'development')).toBe(
      `/Users/example/${DEVELOPMENT_CONFIG_DIR_NAME}`,
    )
  })

  it('keeps CRAFT_CONFIG_DIR as an explicit isolated-profile override', () => {
    expect(resolveConfigDir('/tmp/robb-isolated-profile', '/Users/example', 'development')).toBe(
      '/tmp/robb-isolated-profile',
    )
  })

  it('fails closed to production for unknown build-channel values', () => {
    expect(resolveBuildChannel('preview')).toBe('production')
    expect(resolveBuildChannel(undefined)).toBe('production')
  })
})
