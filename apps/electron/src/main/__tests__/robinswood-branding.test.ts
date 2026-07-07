import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROBINSWOOD_APP_NAME, ROBINSWOOD_NOTICE } from '@craft-agent/shared/robinswood-branding'

const repoRoot = join(import.meta.dir, '..', '..', '..', '..', '..')

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf-8')
}

describe('Robinswood visible branding', () => {
  it('defines the Robinswood app name in shared branding constants', () => {
    expect(ROBINSWOOD_APP_NAME).toBe('Robinswood Agents')
    expect(ROBINSWOOD_NOTICE).toContain('private Robinswood distribution')
  })

  it('uses Robinswood Agents as the default Electron app name', () => {
    const main = readRepoFile('apps/electron/src/main/index.ts')
    expect(main).toContain('app.setName(process.env.CRAFT_APP_NAME || ROBINSWOOD_APP_NAME)')
    expect(main).not.toContain("app.setName(process.env.CRAFT_APP_NAME || 'Craft Agents')")
  })

  it('uses Robinswood Agents in the visible macOS app menu', () => {
    const menu = readRepoFile('apps/electron/src/main/menu.ts')
    expect(menu).toContain('label: ROBINSWOOD_APP_NAME')
    expect(menu).toContain('About ${ROBINSWOOD_APP_NAME}')
    expect(menu).toContain('Hide ${ROBINSWOOD_APP_NAME}')
    expect(menu).toContain('Quit ${ROBINSWOOD_APP_NAME}')
  })

  it('keeps fork attribution and upstream trademark clarity in NOTICE', () => {
    const notice = readRepoFile('NOTICE')
    expect(notice).toContain('Robinswood Agents')
    expect(notice).toContain('not an official Craft Docs Ltd. distribution')
    expect(notice).toContain('Craft, Craft Agents')
  })
})
