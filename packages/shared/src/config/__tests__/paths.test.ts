import { describe, expect, it } from 'bun:test'
import { resolveConfigDir } from '../paths.ts'

describe('resolveConfigDir()', () => {
  it('uses the established Craft Agents root by default so no data migration is needed', () => {
    expect(resolveConfigDir(undefined, '/Users/example')).toBe('/Users/example/.craft-agent')
  })

  it('keeps CRAFT_CONFIG_DIR as an explicit isolated-profile override', () => {
    expect(resolveConfigDir('/tmp/robb-isolated-profile', '/Users/example')).toBe('/tmp/robb-isolated-profile')
  })
})
