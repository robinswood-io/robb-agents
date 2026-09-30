/** Runs only in a temporary Electron profile, with fixture pages and a loopback PNG server. */
import { app, BrowserWindow, nativeImage } from 'electron'
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { BrowserCDP } from '../browser-cdp'

const root = process.argv[2]!
if (!root || !root.includes('robb-canvas-test-')) throw new Error('Isolated fixture path required')
app.setName('Robb Canvas Fixture')
app.setPath('userData', join(root, 'electron-profile'))
const checks: string[] = []
let window: BrowserWindow | undefined
let cdp: BrowserCDP | undefined
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'image/png' })
  res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'))
})

async function run() {
  await app.whenReady()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  window = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { sandbox: true, contextIsolation: true } })
  let capturePageCalls = 0
  window.webContents.capturePage = async () => { capturePageCalls++; throw Error('capturePage is unavailable in this fixture') }
  window.webContents.session.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
  cdp = new BrowserCDP(window.webContents)
  const load = async (style = '', extra = '', paint = true) => {
    await window!.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>html,body{margin:0}#clip{position:absolute;left:10px;top:20px;width:80px;height:60px;overflow:hidden}canvas{display:block;width:120px;height:90px}${style}</style><div id="clip"><canvas id="screen" width="120" height="90"></canvas>${extra}</div><script>${paint ? 'let c=document.querySelector("canvas");let x=c.getContext("2d");x.fillStyle="#c02040";x.fillRect(0,0,c.width,c.height);' : ''}</script>`))
  }
  const capture = () => cdp!.captureCanvasBitmap('#screen')
  const reject = async (label: string, style: string, extra = '') => {
    await load(style, extra)
    await assert.rejects(capture(), /Canvas capture unavailable/)
    checks.push(label)
  }
  await load()
  const before = await window.webContents.executeJavaScript('document.documentElement.outerHTML')
  const result = await capture()
  assert.deepEqual(result.receipt.sourceRect, { x: 0, y: 0, width: 80, height: 60 })
  assert.deepEqual(result.receipt.region, { x: 10, y: 20, width: 80, height: 60 })
  const cropped = nativeImage.createFromBuffer(result.png).crop(result.receipt.sourceRect)
  assert.deepEqual(cropped.getSize(), { width: 80, height: 60 })
  assert.equal(await window.webContents.executeJavaScript('document.documentElement.outerHTML'), before)
  checks.push('real canvas bitmap, rectangular overflow crop, exact PNG size, DOM unchanged')
  await load('#clip{transform:scale(.5);transform-origin:0 0}')
  const scaled = await capture()
  assert.deepEqual(scaled.receipt.sourceRect, { x: 0, y: 0, width: 80, height: 60 })
  assert.equal(scaled.receipt.region.width, 40)
  checks.push('positive CSS scale preserves intrinsic-pixel to viewport mapping')
  await load('#clip{left:-10px;top:-5px}')
  const clipped = await capture()
  assert.deepEqual(clipped.receipt.sourceRect, { x: 10, y: 5, width: 70, height: 55 })
  checks.push('negative viewport origin clips inwards')
  // Real Guacamole topology: out-of-flow desktop, zero-height BODY, BODY overflow
  // propagated to the viewport because HTML overflow remains visible.
  const loadDesktop = async (extraStyle = '') => window!.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><style>html,body{margin:0}body{overflow:hidden}#desktop{position:absolute;inset:0;overflow:hidden}#layer{width:100%;height:100%;overflow:hidden;transform:matrix(1,0,0,1,0,0)}canvas{display:block}${extraStyle}</style><div><guac-viewport><div id="desktop"><div id="layer"><canvas id="screen" width="1216" height="896"></canvas></div></div></guac-viewport></div><script>let c=document.querySelector('canvas'),x=c.getContext('2d');x.fillStyle='#c02040';x.fillRect(0,0,c.width,c.height)</script>`))
  await loadDesktop()
  const desktopGeometry = await window.webContents.executeJavaScript('({bodyHeight:document.body.offsetHeight,htmlOverflow:getComputedStyle(document.documentElement).overflow,bodyOverflow:getComputedStyle(document.body).overflow,width:innerWidth,height:innerHeight})')
  assert.equal(desktopGeometry.bodyHeight, 0)
  assert.equal(desktopGeometry.htmlOverflow, 'visible')
  assert.equal(desktopGeometry.bodyOverflow, 'hidden')
  assert.equal(await window.webContents.executeJavaScript('document.elementFromPoint(10,10) === document.querySelector("#screen")'), true)
  const desktop = await cdp.captureCanvasBitmap('canvas[width="1216"][height="896"]')
  assert.deepEqual(desktop.receipt.sourceRect, { x: 0, y: 0, width: desktopGeometry.width, height: desktopGeometry.height })
  const desktopPng = nativeImage.createFromBuffer(desktop.png).crop(desktop.receipt.sourceRect).toPNG()
  checks.push('Guacamole zero-height BODY overflow propagates to viewport; exact bounded bitmap crop')
  await loadDesktop('html{overflow:hidden}body{overflow:visible}')
  assert.deepEqual((await capture()).receipt.sourceRect, desktop.receipt.sourceRect)
  checks.push('root overflow uses viewport rather than zero-height HTML box')
  await loadDesktop('html{overflow:hidden}body{position:relative;width:75px;height:55px}')
  assert.deepEqual((await capture()).receipt.sourceRect, { x: 0, y: 0, width: 75, height: 55 })
  checks.push('BODY clips its actual box when HTML overflow does not permit propagation')
  await loadDesktop('#desktop{width:75px;height:55px}')
  assert.deepEqual((await capture()).receipt.sourceRect, { x: 0, y: 0, width: 75, height: 55 })
  checks.push('ordinary ancestor clipping remains effective under propagated BODY overflow')
  for (const [label, style] of [
    ['BODY paint containment', 'body{contain:paint}'],
    ['HTML containment disables BODY propagation', 'html{contain:style}'],
    ['BODY containment disables its propagation', 'body{contain:style}'],
    ['zero-height ordinary clipping ancestor', '#desktop{height:0}'],
    ['BODY visual filter', 'body{filter:blur(1px)}'],
    ['rotated document', 'html{transform:rotate(5deg)}'],
  ]) {
    await loadDesktop(style)
    await assert.rejects(capture(), /Canvas capture unavailable/)
    checks.push(`${label} is not bypassed by viewport overflow handling`)
  }
  await load('', '<canvas></canvas>')
  await assert.rejects(cdp.captureCanvasBitmap('canvas'), /Canvas capture unavailable/)
  checks.push('ambiguous selector rejected')
  await assert.rejects(cdp.captureCanvasBitmap('#clip'), /Canvas capture unavailable/)
  checks.push('noncanvas rejected')
  await reject('hidden canvas rejected', 'canvas{display:none}')
  await reject('hidden ancestor rejected', '#clip{visibility:hidden}')
  await reject('partial opacity rejected', '#clip{opacity:.5}')
  await reject('rotated ancestor rejected', '#clip{transform:rotate(5deg)}')
  await reject('perspective rejected', '#clip{perspective:400px}')
  await reject('rounded overflow clipping rejected', '#clip{border-radius:5px}')
  await reject('clip path rejected', '#clip{clip-path:inset(2px)}')
  await reject('CSS filter rejected', 'canvas{filter:blur(2px)}')
  await reject('offscreen canvas rejected', '#clip{left:2000px}')
  await load()
  await window.webContents.executeJavaScript('document.querySelector("canvas").width=9000')
  await assert.rejects(capture(), /Canvas capture unavailable/)
  checks.push('dimension limit rejected before image allocation')
  await load()
  await window.webContents.executeJavaScript('document.querySelector("canvas").width=4000;document.querySelector("canvas").height=4000')
  await assert.rejects(capture(), /Canvas capture unavailable/)
  checks.push('pixel limit rejected before encoding')
  await load()
  await window.webContents.executeJavaScript('HTMLCanvasElement.prototype.toDataURL=()=>{throw Error("PAGE_OVERRIDE")};Element.prototype.getBoundingClientRect=()=>{throw Error("PAGE_OVERRIDE")};true')
  assert.equal((await capture()).receipt.width, 120)
  checks.push('isolated world ignores page prototype replacements')
  await load()
  const port = (server.address() as { port: number }).port
  await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>{document.querySelector('canvas').getContext('2d').drawImage(i,0,0);resolve(true)};i.onerror=reject;i.src='http://127.0.0.1:${port}/pixel.png'})`)
  await assert.rejects(capture(), /Canvas capture unavailable/)
  checks.push('origin-tainted bitmap rejected; no origin bypass')
  await load()
  await window.webContents.executeJavaScript(`(()=>{const c=document.querySelector('canvas');c.width=1400;c.height=1000;const x=c.getContext('2d'),d=x.createImageData(c.width,c.height);for(let p=0;p<d.data.length;p+=65536)crypto.getRandomValues(d.data.subarray(p,Math.min(p+65536,d.data.length)));x.putImageData(d,0,0)})()`)
  await assert.rejects(capture(), /Canvas capture unavailable/)
  checks.push('encoded PNG byte limit enforced')
  assert.equal(capturePageCalls, 0)
  writeFileSync(join(root, 'result.json'), JSON.stringify({ ok: true, checks, hiddenWindow: true, realProfileUsed: false, capturePageCalls,
    sample: { sourceSize: { width: result.receipt.width, height: result.receipt.height }, crop: result.receipt.sourceRect, pngSha256: createHash('sha256').update(cropped.toPNG()).digest('hex') },
    guacamoleTopology: { geometry: desktopGeometry, sourceSize: { width: desktop.receipt.width, height: desktop.receipt.height }, crop: desktop.receipt.sourceRect,
      browserHitTestVisible: true, pngBytes: desktopPng.length, pngSha256: createHash('sha256').update(desktopPng).digest('hex') } }))
}

async function main() {
  // Remaining cases share the same browser without touching a user profile.
  try { await run() } catch (error) {
    writeFileSync(join(root, 'result.json'), JSON.stringify({ ok: false, checks, error: String(error) }))
    throw error
  }
}

main().then(() => finish(0), () => finish(1))
function finish(code: number) { cdp?.detach(); window?.destroy(); server.close(); app.exit(code) }
