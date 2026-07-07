import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROBINSWOOD_APP_NAME, ROBINSWOOD_BACKEND_NAME, ROBINSWOOD_NOTICE } from '@craft-agent/shared/robinswood-branding'

const repoRoot = join(import.meta.dir, '..', '..', '..', '..', '..')

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf-8')
}

function sha256(relativePath: string): string {
  return createHash('sha256').update(readFileSync(join(repoRoot, relativePath))).digest('hex')
}

describe('Robinswood visible branding', () => {
  it('defines the Robinswood app name in shared branding constants', () => {
    expect(ROBINSWOOD_APP_NAME).toBe('Robinswood Agents')
    expect(ROBINSWOOD_BACKEND_NAME).toBe('Robinswood Agents Backend')
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

  it('uses Robinswood packaging metadata and does not publish against official Craft endpoints', () => {
    const builder = readRepoFile('apps/electron/electron-builder.yml')
    expect(builder).toContain('appId: io.robinswood.agents')
    expect(builder).toContain('productName: Robinswood Agents')
    expect(builder).toContain('artifactName: "Robinswood-Agents-${arch}.dmg"')
    expect(builder).toContain('artifactName: "Robinswood-Agents-${arch}.${ext}"')
    expect(builder).toContain('icon: resources/robinswood-icon.icns')
    expect(builder).toContain('icon: resources/robinswood-icon.ico')
    expect(builder).toContain('icon: resources/robinswood-icon.png')
    expect(builder).toContain('https://agents.robinswood.io/electron/latest')
    expect(builder).not.toContain('https://agents.craft.do/electron/latest')
    expect(builder).not.toContain('productName: Craft Agents')
  })

  it('uses Robinswood artifact names in release scripts and dynamic bundle name in afterPack', () => {
    expect(readRepoFile('apps/electron/scripts/build-dmg.sh')).toContain('Robinswood-Agents-${ARCH}.dmg')
    expect(readRepoFile('apps/electron/scripts/build-linux.sh')).toContain('Robinswood-Agents-${ARCH}.AppImage')
    expect(readRepoFile('apps/electron/scripts/build-win.ps1')).toContain('Building Robinswood Agents Windows Installer')
    const afterPack = readRepoFile('apps/electron/scripts/afterPack.cjs')
    expect(afterPack).toContain('productFilename')
    expect(afterPack).toContain('robinswood-Assets.car')
    expect(afterPack).not.toContain("'Craft Agents.app'")
    expect(afterPack).not.toContain("resources', 'Assets.car'")
  })

  it('ships Robinswood icon assets for packaged builds', () => {
    for (const relativePath of [
      'apps/electron/resources/robinswood-icon.svg',
      'apps/electron/resources/robinswood-icon.png',
      'apps/electron/resources/robinswood-icon.icns',
      'apps/electron/resources/robinswood-icon.ico',
      'apps/electron/resources/robinswood-icon.icon/icon.json',
      'apps/electron/resources/robinswood-icon.icon/Assets/icon.svg',
    ]) {
      const absolutePath = join(repoRoot, relativePath)
      expect(existsSync(absolutePath)).toBe(true)
      expect(statSync(absolutePath).size).toBeGreaterThan(100)
    }
  })

  it('does not ship a Robinswood Assets.car that is just the upstream Craft asset catalog', () => {
    const robinswoodAssetsCar = join(repoRoot, 'apps/electron/resources/robinswood-Assets.car')
    if (existsSync(robinswoodAssetsCar)) {
      expect(sha256('apps/electron/resources/robinswood-Assets.car')).not.toEqual(sha256('apps/electron/resources/Assets.car'))
    }
  })

  it('uses Robinswood labels in visible locale values and provider labels', () => {
    const en = readRepoFile('packages/shared/src/i18n/locales/en.json')
    const fr = readRepoFile('packages/shared/src/i18n/locales/fr.json')
    expect(en).toContain('Welcome to Robinswood Agents')
    expect(fr).toContain('Bienvenue dans Robinswood Agents')
    expect(en).toContain('Robinswood Agents Backend')
    expect(fr).toContain('Robinswood Agents Backend')
    expect(readRepoFile('apps/electron/src/renderer/components/app-shell/input/model-picker-helpers.ts')).toContain('ROBINSWOOD_BACKEND_NAME')
    expect(readRepoFile('apps/electron/src/renderer/lib/provider-icons.ts')).toContain('ROBINSWOOD_BACKEND_NAME')
  })

  it('uses Robinswood Agents in renderer, WebUI, and viewer document titles', () => {
    expect(readRepoFile('apps/electron/src/renderer/index.html')).toContain('<title>Robinswood Agents</title>')
    expect(readRepoFile('apps/electron/src/renderer/playground.html')).toContain('Design System Playground - Robinswood Agents')
    expect(readRepoFile('apps/webui/src/index.html')).toContain('<title>Robinswood Agents</title>')
    expect(readRepoFile('apps/webui/src/login.html')).toContain('<title>Robinswood Agents — Login</title>')
    expect(readRepoFile('apps/webui/src/login.html')).toContain('<h1>Robinswood Agents</h1>')
    expect(readRepoFile('apps/viewer/index.html')).toContain('<title>Robinswood Agents Session Viewer</title>')
    expect(readRepoFile('apps/viewer/src/components/Header.tsx')).toContain('https://agents.robinswood.io')
  })

  it('uses an isolated Robinswood config directory while preserving explicit env overrides', () => {
    const paths = readRepoFile('packages/shared/src/config/paths.ts')
    expect(paths).toContain('process.env.CRAFT_CONFIG_DIR')
    expect(paths).toContain("'.robinswood-agents'")
    expect(paths).not.toContain("join(homedir(), '.craft-agent')")

    const windowState = readRepoFile('apps/electron/src/main/window-state.ts')
    expect(windowState).toContain("@craft-agent/shared/config/paths")
    expect(windowState).not.toContain("join(homedir(), '.craft-agent')")

    const electronDev = readRepoFile('scripts/electron-dev.ts')
    expect(electronDev).toContain('Robinswood Agents')
    expect(electronDev).toContain('.robinswood-agents-${instanceNum}')
    expect(electronDev).toContain('CRAFT_DEEPLINK_SCHEME: process.env.CRAFT_DEEPLINK_SCHEME || "craftagents"')
  })

  it('uses Robinswood Agents in visible runtime guidance outside the desktop shell', () => {
    expect(readRepoFile('packages/messaging-gateway/src/access-control.ts')).toContain('Robinswood Agents app')
    expect(readRepoFile('packages/messaging-gateway/src/commands.ts')).toContain('Robinswood Agents app')
    expect(readRepoFile('packages/messaging-whatsapp-worker/src/worker.ts')).toContain("Browsers.macOS('Robinswood Agents')")
    expect(readRepoFile('packages/server-core/src/sessions/RemoteBrowserPaneManager.ts')).toContain('Robinswood Agents desktop app')
    expect(readRepoFile('packages/shared/src/sources/builtin-sources.ts')).toContain('Upstream Craft Agents OSS Docs')
  })

  it('keeps fork attribution and upstream trademark clarity in NOTICE', () => {
    const notice = readRepoFile('NOTICE')
    expect(notice).toContain('Robinswood Agents')
    expect(notice).toContain('not an official Craft Docs Ltd. distribution')
    expect(notice).toContain('Craft, Craft Agents')
  })
})
