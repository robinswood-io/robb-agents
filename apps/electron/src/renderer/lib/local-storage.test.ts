import { describe, expect, it } from 'bun:test'
import { KEYS, isWebEphemeralStorageKey, getKeyString } from './local-storage'

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

describe('Existing renderer storage key compatibility', () => {
  const playgroundKeys = [
    [KEYS.playgroundPreviewSize, 'playground-preview-size'],
    [KEYS.playgroundSelectedComponent, 'playground-selected-component'],
    [KEYS.playgroundVariantsSidebarOpen, 'playground-variants-sidebar-open'],
    [KEYS.playgroundExpandedCategories, 'playground-expanded-categories'],
  ] as const

  for (const [key, stored] of playgroundKeys) {
    it(`preserves the existing ${stored} key`, () => {
      expect(getKeyString(key)).toBe(stored)
    })
  }

  it('preserves desktop prefixes and workspace suffixes', () => {
    expect(getKeyString(KEYS.sidebarWidth)).toBe('craft-sidebar-width')
    expect(getKeyString(KEYS.tabs, 'qa-workspace')).toBe('craft-tabs:qa-workspace')
  })
})
