import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sourceIntegrity = require('../../apps/electron/scripts/releaseIntegrity.cjs')
const signatureIntegrity = require('../../apps/electron/scripts/afterSign.cjs')

let fixtureDirectory: string | undefined

afterEach(() => {
  if (fixtureDirectory) {
    rmSync(fixtureDirectory, { recursive: true, force: true })
    fixtureDirectory = undefined
  }
})

function createCleanRepository(): string {
  fixtureDirectory = mkdtempSync(join(tmpdir(), 'robb-release-source-'))
  execFileSync('git', ['init', '--quiet'], { cwd: fixtureDirectory })
  execFileSync('git', ['config', 'user.name', 'Release Test'], { cwd: fixtureDirectory })
  execFileSync('git', ['config', 'user.email', 'release-test@example.invalid'], { cwd: fixtureDirectory })
  writeFileSync(join(fixtureDirectory, 'tracked.txt'), 'clean\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: fixtureDirectory })
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: fixtureDirectory })
  return fixtureDirectory
}

describe('macOS release source integrity', () => {
  it('accepts an exact clean Git commit and rejects subsequent tracked or untracked changes', () => {
    const repository = createCleanRepository()
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim()

    expect(sourceIntegrity.inspectReleaseSource(repository, {})).toBe(commit)
    expect(sourceIntegrity.inspectReleaseSource(repository, {
      ROBB_BUILD_COMMIT: commit,
      ROBB_BUILD_DIRTY: 'false',
    })).toBe(commit)
    expect(() => sourceIntegrity.inspectReleaseSource(repository, {
      ROBB_BUILD_COMMIT: '0'.repeat(40),
      ROBB_BUILD_DIRTY: 'false',
    })).toThrow('does not match checkout')

    writeFileSync(join(repository, 'untracked.txt'), 'dirty\n')
    expect(() => sourceIntegrity.inspectReleaseSource(repository, {
      ROBB_BUILD_DIRTY: 'false',
    })).toThrow('uncommitted or untracked changes')
  })

  it('does not let declared clean metadata hide dirty Git state', () => {
    expect(() => sourceIntegrity.validateReleaseSourceState({
      declaredDirty: 'false',
      gitPorcelain: ' M tracked.txt\n',
    })).toThrow('uncommitted or untracked changes')
    expect(() => sourceIntegrity.validateReleaseSourceState({
      declaredDirty: undefined,
      gitPorcelain: undefined,
    })).toThrow('clean source state could not be verified')
  })

  it('skips strict integrity only for an explicitly non-release macOS build', () => {
    const context = (forceCodeSigning: boolean, platform = 'darwin') => ({
      electronPlatformName: platform,
      packager: { platformSpecificBuildOptions: { forceCodeSigning } },
    })
    expect(sourceIntegrity.requiresMacReleaseIntegrity(context(true))).toBe(true)
    expect(sourceIntegrity.requiresMacReleaseIntegrity(context(false))).toBe(false)
    expect(sourceIntegrity.requiresMacReleaseIntegrity(context(true, 'linux'))).toBe(false)
  })
})

describe('macOS release signature integrity', () => {
  const developerIdInspection = [
    'Identifier=io.robinswood.robbagents',
    'Authority=Developer ID Application: Robinswood (ABCDE12345)',
    'TeamIdentifier=ABCDE12345',
  ].join('\n')

  it('accepts only the expected Developer ID Application identity', () => {
    expect(() => signatureIntegrity.validateDeveloperIdInspection(
      0,
      developerIdInspection,
    )).not.toThrow()
    expect(() => signatureIntegrity.validateDeveloperIdInspection(
      0,
      'Identifier=io.robinswood.robbagents\nSignature=adhoc\nTeamIdentifier=not set',
    )).toThrow('ad-hoc signed')
    expect(() => signatureIntegrity.validateDeveloperIdInspection(
      0,
      'Identifier=io.robinswood.robbagents\nAuthority=Apple Development: Dev\nTeamIdentifier=ABCDE12345',
    )).toThrow('not a Developer ID Application signature')
  })

  it('requires verifiable code, Gatekeeper notarization, and a stapled ticket', () => {
    const valid = {
      codesign: { returncode: 0, text: 'valid on disk' },
      gatekeeper: { returncode: 0, text: 'source=Notarized Developer ID' },
      stapler: { returncode: 0, text: 'The validate action worked!' },
    }
    expect(() => signatureIntegrity.validateReleaseVerificationResults(valid)).not.toThrow()
    expect(() => signatureIntegrity.validateReleaseVerificationResults({
      ...valid,
      codesign: { returncode: 1, text: 'invalid signature' },
    })).toThrow('signature verification failed')
    expect(() => signatureIntegrity.validateReleaseVerificationResults({
      ...valid,
      gatekeeper: { returncode: 0, text: 'source=Developer ID' },
    })).toThrow('Notarization assessment failed')
    expect(() => signatureIntegrity.validateReleaseVerificationResults({
      ...valid,
      stapler: { returncode: 1, text: 'ticket missing' },
    })).toThrow('ticket validation failed')
  })
})
