/** Isolated Electron recipe. Logs derived assertions only; never launches the installed app. */
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const root = resolve(import.meta.dir, '..')
const temporary = mkdtempSync(join(tmpdir(), 'robb-browser-input-test-'))
const profile = join(temporary, 'profile'); mkdirSync(profile)
const outfile = join(temporary, 'fixture.cjs')
await build({ entryPoints: [join(root, 'apps/electron/src/main/__tests__/fixtures/browser-remote-input.fixture.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], plugins: [{ name: 'fixture-logger-only', setup(b) {
  b.onResolve({ filter: /^\.\/logger$/ }, a => a.importer.endsWith('/browser-cdp.ts') ? { path: 'fixture-logger', namespace: 'fixture' } : undefined)
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const mainLog = {info(){},warn(){},error(){},debug(){}};' }))
} }] })
const require = createRequire(join(root, 'package.json'))
const executable = require('electron') as string
const child = Bun.spawn([executable, outfile], { cwd: temporary, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, CRAFT_CONFIG_DIR: join(temporary, 'craft'), ROBB_INPUT_FIXTURE_PROFILE: profile, ROBB_INPUT_FIXTURE_KEYBOARD: join(root, 'apps/electron/src/main/__tests__/fixtures/guacamole-keyboard-1.5.5.js') }, stdout: 'inherit', stderr: 'inherit' })
const timeout = setTimeout(() => child.kill(), 25_000)
const exit = await child.exited; clearTimeout(timeout)
if (exit !== 0) process.exit(exit)
