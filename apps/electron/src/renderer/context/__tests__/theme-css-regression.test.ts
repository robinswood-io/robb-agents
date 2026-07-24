import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const cssPath = resolve(import.meta.dir, '../../index.css')

describe('theme CSS regressions', () => {
  it('keeps Tailwind dark utilities bound to the html.dark class', () => {
    const css = readFileSync(cssPath, 'utf-8')

    expect(css).toContain('@custom-variant dark')
    expect(css).toContain('&:where(.dark, .dark *)')
  })

  it('scans the singular renderer/context directory that owns ThemeContext', () => {
    const css = readFileSync(cssPath, 'utf-8')

    expect(css).toContain('@source "../renderer/context/**/*.{ts,tsx,jsx}"')
  })
})
