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
    expect(ROBINSWOOD_APP_NAME).toBe('Robb Agents')
    expect(ROBINSWOOD_BACKEND_NAME).toBe('Robb Agents Backend')
    expect(ROBINSWOOD_NOTICE).toContain('open-source Robinswood distribution')
  })

  it('selects the Electron app name from the isolated runtime channel', () => {
    const main = readRepoFile('apps/electron/src/main/index.ts')
    expect(main).toContain('app.setName(process.env.CRAFT_APP_NAME || getDefaultAppName(APP_CHANNEL))')
    expect(main).not.toContain("app.setName(process.env.CRAFT_APP_NAME || 'Craft Agents')")
  })

  it('uses the active production or development name in the macOS app menu', () => {
    const menu = readRepoFile('apps/electron/src/main/menu.ts')
    expect(menu).toContain('const appName = app.getName()')
    expect(menu).toContain('label: appName')
    expect(menu).toContain('About ${appName}')
    expect(menu).toContain('Hide ${appName}')
    expect(menu).toContain('Quit ${appName}')
  })

  it('uses production packaging metadata and the public stable GitHub update feed', () => {
    const builder = readRepoFile('apps/electron/electron-builder.yml')
    expect(builder).toContain('appId: io.robinswood.robbagents')
    expect(builder).toContain('productName: Robb Agents')
    expect(builder).toContain('artifactName: "Robb-Agents-${arch}.dmg"')
    expect(builder).toContain('artifactName: "Robb-Agents-${arch}.${ext}"')
    expect(builder).toContain('icon: resources/robinswood-icon.icns')
    expect(builder).toContain('icon: resources/robinswood-icon.ico')
    expect(builder).toContain('icon: resources/robinswood-icon.png')
    expect(builder).toContain('provider: github')
    expect(builder).toContain('owner: robinswood-io')
    expect(builder).toContain('repo: robb-agents')
    expect(builder).toContain('channel: latest')
    expect(builder).toContain('releaseType: release')
    expect(builder).not.toContain('https://agents.robinswood.io/electron/latest')
    expect(builder).not.toContain('https://agents.craft.do/electron/latest')
    expect(builder).not.toContain('productName: Craft Agents')
  })

  it('packages development with a disjoint name and bundle identifier', () => {
    const builder = readRepoFile('apps/electron/electron-builder.dev.yml')
    expect(builder).toContain('appId: io.robinswood.robbagents.dev')
    expect(builder).toContain('productName: Robb Agents Dev')
    expect(builder).toContain('publish: null')
    expect(builder).toContain('output: release-dev')
    expect(builder).toContain('Robb-Agents-Dev-${arch}')
  })

  it('uses Robinswood artifact names in release scripts and dynamic bundle name in afterPack', () => {
    expect(readRepoFile('apps/electron/scripts/build-dmg.sh')).toContain('Robb-Agents-${ARCH}.dmg')
    expect(readRepoFile('apps/electron/scripts/build-linux.sh')).toContain('Robb-Agents-${ARCH}.AppImage')
    expect(readRepoFile('apps/electron/scripts/build-win.ps1')).toContain('Building Robb Agents Windows Installer')
    const afterPack = readRepoFile('apps/electron/scripts/afterPack.cjs')
    expect(afterPack).toContain('productFilename')
    expect(afterPack).toContain('robinswood-Assets.car')
    expect(afterPack).not.toContain("'Craft Agents.app'")
    expect(afterPack).not.toContain("resources', 'Assets.car'")
  })

  it('ships Robinswood icon assets for packaged builds', () => {
    for (const relativePath of [
      'apps/electron/resources/robinswood-icon.svg',
      'apps/electron/resources/robinswood-icon-monochrome.svg',
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
    expect(en).toContain('Welcome to Robb Agents')
    expect(fr).toContain('Bienvenue dans Robb Agents')
    expect(en).toContain('Robb Agents Backend')
    expect(fr).toContain('Robb Agents Backend')
    expect(readRepoFile('apps/electron/src/renderer/components/app-shell/input/model-picker-helpers.ts')).toContain('ROBINSWOOD_BACKEND_NAME')
    expect(readRepoFile('apps/electron/src/renderer/lib/provider-icons.ts')).toContain('ROBINSWOOD_BACKEND_NAME')
  })

  it('uses Robb Agents in renderer, WebUI, and viewer document titles', () => {
    expect(readRepoFile('apps/electron/src/renderer/index.html')).toContain('<title>Robb Agents</title>')
    expect(readRepoFile('apps/electron/src/renderer/playground.html')).toContain('Design System Playground - Robb Agents')
    expect(readRepoFile('apps/webui/src/index.html')).toContain('<title>Robb Agents</title>')
    expect(readRepoFile('apps/webui/src/login.html')).toContain('<title>Robb Agents — Login</title>')
    expect(readRepoFile('apps/webui/src/login.html')).toContain('<h1>Robb Agents</h1>')
    expect(readRepoFile('apps/viewer/index.html')).toContain('<title>Robb Agents Session Viewer</title>')
    expect(readRepoFile('apps/viewer/src/components/Header.tsx')).toContain('https://github.com/robinswood-io/robb-agents')
    expect(readRepoFile('apps/viewer/src/components/Header.tsx')).not.toContain('https://agents.robinswood.io')
  })

  it('keeps production data compatible and isolates every development launch', () => {
    const paths = readRepoFile('packages/shared/src/config/paths.ts')
    expect(paths).toContain('process.env.CRAFT_CONFIG_DIR')
    expect(paths).toContain("PRODUCTION_CONFIG_DIR_NAME = '.craft-agent'")
    expect(paths).toContain("DEVELOPMENT_CONFIG_DIR_NAME = '.craft-agent-dev'")
    expect(paths).toContain("channel === 'development'")
    expect(paths).not.toContain("join(homedir(), '.robb-agents')")

    const windowState = readRepoFile('apps/electron/src/main/window-state.ts')
    expect(windowState).toContain("@craft-agent/shared/config/paths")
    expect(windowState).not.toContain("join(homedir(), '.craft-agent')")

    const logger = readRepoFile('apps/electron/src/main/logger.ts')
    expect(logger).toContain("join(CONFIG_DIR, 'logs', 'messaging-gateway.log')")
    expect(logger).toContain("join(CONFIG_DIR, 'logs', 'auto-update.log')")
    expect(logger).not.toContain("join(homedir(), '.craft-agent', 'logs'")

    const electronDev = readRepoFile('scripts/electron-dev.ts')
    expect(electronDev).toContain('Robb Agents Dev.app')
    expect(electronDev).toContain('io.robinswood.robbagents.dev')
    expect(electronDev).toContain('.craft-agent-dev')
    expect(electronDev).toContain('CRAFT_DEEPLINK_SCHEME: process.env.CRAFT_DEEPLINK_SCHEME || "robbagentsdev"')
    expect(electronDev).toContain('Development profile isolation refused')
  })

  it('keeps update checks manual and removes every menu shortcut', () => {
    const updater = readRepoFile('apps/electron/src/main/auto-update.ts')
    expect(updater).toContain('autoUpdater.autoDownload = false')
    expect(updater).toContain('autoUpdater.autoInstallOnAppQuit = false')
    expect(updater).toContain('autoUpdater.allowPrerelease = false')
    expect(updater).toContain('await autoUpdater.downloadUpdate()')
    expect(updater).not.toContain('checkForUpdatesOnLaunch')

    const menu = readRepoFile('apps/electron/src/main/menu.ts')
    const menuSchema = readRepoFile('apps/electron/src/shared/menu-schema.ts')
    expect(menu).not.toContain("import('./auto-update')")
    expect(menuSchema).not.toContain("id: 'checkForUpdates'")
    expect(menuSchema).not.toContain("id: 'installUpdate'")

    const workflow = readRepoFile('.github/workflows/release.yml')
    expect(workflow).toContain('generate-github-update-manifests.ts')
    expect(workflow).toContain('--verify-tag')
    expect(workflow).toContain('--latest')
  })

  it('uses Robb Agents in visible runtime guidance outside the desktop shell', () => {
    expect(readRepoFile('packages/messaging-gateway/src/access-control.ts')).toContain('Robb Agents app')
    expect(readRepoFile('packages/messaging-gateway/src/commands.ts')).toContain('Robb Agents app')
    expect(readRepoFile('packages/messaging-whatsapp-worker/src/worker.ts')).toContain("Browsers.macOS('Robb Agents')")
    expect(readRepoFile('packages/server-core/src/sessions/RemoteBrowserPaneManager.ts')).toContain('Robb Agents desktop app')
    expect(readRepoFile('packages/shared/src/sources/builtin-sources.ts')).toContain('Upstream Craft Agents OSS Docs')
  })

  it('keeps MIT licensing, Apache upstream attribution, and trademark clarity', () => {
    const license = readRepoFile('LICENSE')
    const apache = readRepoFile('LICENSE-APACHE')
    const notice = readRepoFile('NOTICE')
    expect(license).toContain('MIT License')
    expect(apache).toContain('Apache License')
    expect(notice).toContain('Robb Agents')
    expect(notice).toContain('open-source Robinswood distribution')
    expect(notice).toContain('MIT License')
    expect(notice).toContain('LICENSE-APACHE')
    expect(notice).toContain('not an official Craft Docs Ltd. distribution')
    expect(notice).toContain('Craft, Craft Agents')
    expect(notice).toContain('private Robinswood-hosted proxy/update endpoint')
  })
})
