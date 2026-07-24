import { describe, expect, it } from 'bun:test'
import {
  mergeThemeOverrides,
  themeToCSS,
  type ThemeOverrides,
} from '../theme'

const robinswoodPreset: ThemeOverrides = {
  background: '#FAF9FB',
  foreground: '#1A1625',
  accent: '#8B5CF6',
  paper: '#FAF9FB',
  navigator: '#FAF9FB',
  input: '#F5F4F6',
  popover: '#FAF9FB',
  dark: {
    background: '#1E1D21',
    foreground: '#F5F5F7',
    accent: '#A78BFA',
    paper: '#1E1D21',
    navigator: '#1E1D21',
    input: '#1E1D21',
    popover: '#1E1D21',
  },
}

describe('theme override merging', () => {
  it('preserves the complete dark preset when an app theme overrides only its accent', () => {
    const appTheme: ThemeOverrides = {
      dark: {
        accent: '#A855F7',
      },
    }

    const merged = mergeThemeOverrides(robinswoodPreset, appTheme)

    expect(merged.dark).toEqual({
      ...robinswoodPreset.dark,
      accent: '#A855F7',
    })

    const darkCSS = themeToCSS(merged, true)
    expect(darkCSS).toContain('--background: #1E1D21;')
    expect(darkCSS).toContain('--foreground: #F5F5F7;')
    expect(darkCSS).toContain('--accent: #A855F7;')
    expect(darkCSS).toContain('--navigator: #1E1D21;')
    expect(darkCSS).not.toContain('--background: #FAF9FB;')
  })
})
