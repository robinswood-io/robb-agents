import { describe, expect, test } from 'bun:test'
import { readBunLockWorkspaceVersion } from '../validate-workspace-versions.ts'

describe('workspace version lockfile contract', () => {
  test('reads the version from the exact workspace entry', () => {
    const lockfile = `{
  "workspaces": {
    "apps/cli": {
      "name": "@craft-agent/cli",
      "version": "0.12.3",
      "dependencies": {},
    },
    "apps/electron": {
      "name": "@craft-agent/electron",
      "version": "0.12.4",
    },
  },
}`

    expect(readBunLockWorkspaceVersion(lockfile, 'apps/cli')).toBe('0.12.3')
    expect(readBunLockWorkspaceVersion(lockfile, 'apps/electron')).toBe('0.12.4')
  })

  test('fails closed when the workspace or its version is absent', () => {
    const lockfile = `{
  "workspaces": {
    "packages/shared": {
      "name": "@craft-agent/shared",
    },
  },
}`

    expect(readBunLockWorkspaceVersion(lockfile, 'packages/shared')).toBeUndefined()
    expect(readBunLockWorkspaceVersion(lockfile, 'packages/server')).toBeUndefined()
  })
})
