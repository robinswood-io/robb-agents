// run-workspace-tests.sh gives .isolated.ts suites a fresh process: the manager
// suite mocks both BrowserCDP and electron, while this suite needs their real exports.
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { CANVAS_CAPTURE_LIMITS, validateCanvasBitmapReceipt, type CanvasBitmapReceipt } from '../browser-canvas-capture'
mock.module('../logger', () => ({ mainLog: { info() {}, warn() {}, error() {}, debug() {} } }))
const { BrowserCDP } = await import('../browser-cdp')
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function receipt(): CanvasBitmapReceipt {
  return { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', width: 1, height: 1,
    sourceRect: { x: 0, y: 0, width: 1, height: 1 }, region: { x: 0, y: 0, width: 1, height: 1 }, canvasBox: { x: 0, y: 0, width: 1, height: 1 },
    viewport: { width: 100, height: 100, dpr: 2, scrollX: 0, scrollY: 0 }, capturedAt: 123 }
}
function transport(hook: (method: string, call: number) => any = () => undefined) {
  const calls: Array<{ method: string; args: any }> = []
  let url = 'https://fixture.invalid/'
  const cdp = new BrowserCDP({ getURL: () => url, debugger: { isAttached: () => true, attach() {}, detach() {}, on() {}, async sendCommand(method: string, args: any) {
    calls.push({ method, args }); const result = hook(method, calls.length); if (result !== undefined) return result
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'document' } } }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 }
    return { result: { value: receipt() } }
  } } } as any)
  cleanups.push(() => cdp.detach())
  return { cdp, calls, navigate: () => { url += 'new' } }
}
describe('canvas bitmap receipt and document boundaries', () => {
  it('reads with a fixed isolated-world expression and validates PNG dimensions', async () => {
    const { cdp, calls } = transport()
    const result = await cdp.captureCanvasBitmap('#screen')
    expect(result.receipt.width).toBe(1)
    expect(calls.find(c => c.method === 'Page.createIsolatedWorld')?.args.grantUniveralAccess).toBe(false)
    expect(calls.find(c => c.method === 'Runtime.evaluate')?.args.contextId).toBe(42)
    expect(calls.some(c => /Input\.|captureScreenshot|capturePage/.test(c.method))).toBe(false)
  })
  it('rejects invalid selector transport before any CDP call', async () => {
    for (const selector of ['', 'x'.repeat(1025), ['canvas'], {}, null]) {
      const { cdp, calls } = transport()
      await expect(cdp.captureCanvasBitmap(selector as string)).rejects.toThrow('bounded')
      expect(calls).toHaveLength(0)
    }
  })
  it('does not return page errors or fabricated empty images', async () => {
    const { cdp } = transport(method => method === 'Runtime.evaluate' ? { exceptionDetails: { text: 'PRIVATE_PAGE_ERROR' } } : undefined)
    await expect(cdp.captureCanvasBitmap('canvas')).rejects.toThrow('Canvas capture unavailable')
    try { await cdp.captureCanvasBitmap('canvas') } catch (error) { expect(String(error)).not.toContain('PRIVATE_PAGE_ERROR') }
  })
  it('rejects a same-URL document replacement after encoding', async () => {
    let frames = 0
    const { cdp } = transport(method => method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'frame', loaderId: ++frames === 1 ? 'old' : 'new' } } } : undefined)
    await expect(cdp.captureCanvasBitmap('canvas')).rejects.toThrow('document changed')
  })
  it('rechecks ownership after each awaited step before returning pixels', async () => {
    for (const stopAfter of [1, 2, 3, 4]) {
      let current = true
      const { cdp, calls } = transport((_method, call) => { if (call === stopAfter) current = false })
      await expect(cdp.captureCanvasBitmap('canvas', () => current)).rejects.toThrow('target changed')
      expect(calls).toHaveLength(stopAfter)
    }
  })
  it('rejects navigation and malformed receipts without returning pixels', async () => {
    let navigate = () => {}
    const f = transport(method => { if (method === 'Runtime.evaluate') navigate() }); navigate = f.navigate
    await expect(f.cdp.captureCanvasBitmap('canvas')).rejects.toThrow('target changed')
    for (const change of [ { width: 10000 }, { height: 0 }, { sourceRect: { x: -1, y: 0, width: 1, height: 1 } }, { dataUrl: 'data:,' }, { dataUrl: 'data:image/png;base64,' + 'A'.repeat(Math.ceil(CANVAS_CAPTURE_LIMITS.pngBytes / 3) * 4 + 4) } ]) {
      expect(() => validateCanvasBitmapReceipt({ ...receipt(), ...change })).toThrow('bitmap receipt')
    }
    expect(() => validateCanvasBitmapReceipt({ ...receipt(), width: 2 })).toThrow('bitmap receipt')
  })
})

it('captures real hidden Electron canvases without capturePage, page mutation or a real profile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robb-canvas-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const bundle = join(dir, 'fixture.cjs')
  await build({ entryPoints: [join(import.meta.dir, 'browser-canvas-capture.electron-fixture.ts')], outfile: bundle, platform: 'node', format: 'cjs', bundle: true, external: ['electron'], plugins: [{ name: 'fixture-no-profile-logger', setup(b) {
    b.onLoad({ filter: /[/\\]logger\.ts$/ }, () => ({ contents: 'export const mainLog={info(){},warn(){},error(){},debug(){}};', loader: 'ts' }))
  } }] })
  const require = createRequire(import.meta.url)
  const electron = require('electron') as string
  const child = Bun.spawn([electron, bundle, dir], { cwd: resolve(import.meta.dir, '..'), env: { ...process.env, CRAFT_CONFIG_DIR: join(dir, 'craft-profile') }, stdout: 'pipe', stderr: 'pipe' })
  const timeout = setTimeout(() => child.kill(), 35_000)
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  clearTimeout(timeout)
  const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'))
  expect({ exit, result, stderr: exit === 0 ? '' : stderr.slice(-1500) }).toMatchObject({ exit: 0, result: { ok: true, realProfileUsed: false } })
  expect(result.checks.length).toBeGreaterThanOrEqual(18)
  process.stdout.write(`Canvas Electron fixture receipt: ${JSON.stringify(result)}\n`)
}, 45_000)
