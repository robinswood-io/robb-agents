import { describe, expect, it } from 'bun:test'
import { KEYS, isWebEphemeralStorageKey } from './local-storage'

describe('Remote renderer local storage policy', () => {
  it('keeps host paths and session navigation ephemeral in the web runtime', () => {
    expect(isWebEphemeralStorageKey(KEYS.recentWorkingDirs)).toBe(true)
    expect(isWebEphemeralStorageKey(KEYS.sessionFilesExpandedFolders)).toBe(true)
    expect(isWebEphemeralStorageKey(KEYS.tabs)).toBe(true)
    expect(isWebEphemeralStorageKey(KEYS.workspaceUrl)).toBe(true)
    expect(isWebEphemeralStorageKey(KEYS.lastSelectedSessionId)).toBe(true)
  })

  it('still allows harmless visual preferences to persist', () => {
    expect(isWebEphemeralStorageKey(KEYS.theme)).toBe(false)
    expect(isWebEphemeralStorageKey(KEYS.sidebarWidth)).toBe(false)
    expect(isWebEphemeralStorageKey(KEYS.projectColorTreatment)).toBe(false)
  })
})
