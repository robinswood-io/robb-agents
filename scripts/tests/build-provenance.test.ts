import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseBuildDirty, resolveBuildCommit, resolveBuildDirty } from '../build-provenance'

describe('build provenance dirty-state resolution', () => {
  it('classifies clean and dirty git worktrees', () => {
    expect(resolveBuildDirty(undefined, '')).toBe(false)
    expect(resolveBuildDirty(undefined, ' M packages/shared/src/file.ts\n')).toBe(true)
  })

  it('prefers an explicit canonical-build declaration', () => {
    expect(resolveBuildDirty('clean', ' M ignored.ts')).toBe(false)
    expect(resolveBuildDirty('dirty', '')).toBe(true)
  })

  it('keeps provenance unknown when neither CI nor git can determine it', () => {
    expect(resolveBuildDirty(undefined, undefined)).toBeUndefined()
    expect(parseBuildDirty('unexpected')).toBeUndefined()
  })

  it('prefers an explicit revision, then the checkout, then CI', () => {
    expect(resolveBuildCommit(' explicit ', 'checkout', 'ci')).toBe('explicit')
    expect(resolveBuildCommit(undefined, ' checkout ', 'ci')).toBe('checkout')
    expect(resolveBuildCommit(undefined, undefined, ' ci ')).toBe('ci')
    expect(resolveBuildCommit(undefined, undefined, undefined)).toBeUndefined()
  })

  it('bakes commit, channel, and dirty state into the canonical Electron build', () => {
    const buildScript = readFileSync(join(import.meta.dir, '..', 'electron-build-main.ts'), 'utf8')
    expect(buildScript).toContain('"ROBB_BUILD_COMMIT"')
    expect(buildScript).toContain('"ROBB_BUILD_CHANNEL"')
    expect(buildScript).toContain('"ROBB_BUILD_DIRTY"')
    expect(buildScript).toContain('git", ["rev-parse", "HEAD"]')
    expect(buildScript).toContain('git", ["status", "--porcelain"]')
  })

  it('covers development, direct package, and legacy Windows main builds', () => {
    const devScript = readFileSync(join(import.meta.dir, '..', 'electron-dev.ts'), 'utf8')
    const electronPackage = readFileSync(join(import.meta.dir, '..', '..', 'apps/electron/package.json'), 'utf8')
    const windowsScript = readFileSync(join(import.meta.dir, '..', 'build/win32.ts'), 'utf8')
    expect(devScript).toContain('process.env.ROBB_BUILD_COMMIT')
    expect(devScript).toContain('process.env.ROBB_BUILD_DIRTY')
    expect(electronPackage).toContain('electron-build-main.ts --main-only')
    expect(windowsScript).toContain('process.env.ROBB_BUILD_COMMIT')
    expect(windowsScript).toContain('process.env.ROBB_BUILD_DIRTY')
  })
})
