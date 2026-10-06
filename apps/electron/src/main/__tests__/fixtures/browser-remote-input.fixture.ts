import { app, BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { strict as assert } from 'node:assert'
import { BrowserCDP } from '../../browser-cdp'
import { isBrowserPanePermissionAllowed } from '../../browser-pane-permissions'
import { executeBrowserToolCommand } from '../../../../../../packages/shared/src/agent/browser-tool-runtime'
import type { BrowserPaneFns } from '../../../../../../packages/shared/src/agent/browser-tools'

app.setName('Robb Browser Input Fixture')
app.setPath('userData', process.env.ROBB_INPUT_FIXTURE_PROFILE!)
app.commandLine.appendSwitch('disable-background-networking')
const deadline = setTimeout(() => app.exit(2), 20_000)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { partition: 'remote-input-fixture', backgroundThrottling: false, sandbox: true, nodeIntegration: false, contextIsolation: true } })
  let permissionRequests = 0
  let clipboardChecks = 0
  window.webContents.session.setPermissionCheckHandler((_wc, permission) => { if (permission.startsWith('clipboard')) clipboardChecks++; return isBrowserPanePermissionAllowed(permission) })
  window.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => { permissionRequests++; callback(isBrowserPanePermissionAllowed(permission)) })
  const keyboard = readFileSync(process.env.ROBB_INPUT_FIXTURE_KEYBOARD!, 'utf8')
  const html = `<canvas tabindex="0"></canvas><textarea></textarea><script>${keyboard}
    window.received=[]; window.released=[]; window.keys=[];
    const receiver=new Guacamole.Keyboard(document.querySelector('canvas'));
    receiver.onkeydown=k=>{received.push(k);return false}; receiver.onkeyup=k=>released.push(k);
    document.addEventListener('keydown',e=>keys.push({key:e.key,trusted:e.isTrusted}));
    document.querySelector('canvas').focus();</script>`
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  // Keyboard receiver recipe is isolated from page permissions and native focus UI.
  await window.loadURL('data:text/html,' + encodeURIComponent(html))
  const cdp = new BrowserCDP(window.webContents)
  const fns = {
    sendKey: async (args) => { assert.equal(args.key, 'Unidentified'); assert.equal(args.modifiers, undefined); await cdp.typeKeys(args.text!) },
    type: (text) => cdp.typeText(text),
    evaluate: (expression) => window.webContents.executeJavaScript(expression),
    setClipboard: (text) => cdp.setClipboard(text),
    getClipboard: () => cdp.getClipboard(),
  } as BrowserPaneFns
  await assert.rejects(() => executeBrowserToolCommand({ command: ['type', 'not lost silently'], fns, sessionId: 'fixture' }), /type-keys/)
  await window.webContents.debugger.sendCommand('Input.insertText', { text: 'baseline' })
  assert.equal(await window.webContents.executeJavaScript('received.length'), 0)
  const requested = 'AZERTY azerty qQ mM éèàçùœ € @#{}[]~^|\\ "\' :;,.!?% &=+-_'
  const beforeKeyboard = permissionRequests
  const beforeKeyboardChecks = clipboardChecks
  // The isolated fixture stays hidden; emulate a focused document, as required by this explicit input mode.
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await window.webContents.executeJavaScript('document.querySelector("canvas").focus()')
  assert.equal(await window.webContents.executeJavaScript('document.activeElement.tagName'), 'CANVAS')
  const receipt = await executeBrowserToolCommand({ command: ['type-keys', requested], fns, sessionId: 'fixture' })
  assert.match(receipt.output, /not verified/)
  const got = await window.webContents.executeJavaScript('({received,released,keys})')
  const rendered = got.received.map((k: number) => String.fromCodePoint(k >= 0x1000000 ? k - 0x1000000 : k)).join('')
  if (rendered !== requested) console.log(JSON.stringify({ fixtureDebug: true, activeTag: await window.webContents.executeJavaScript('document.activeElement.tagName'), keyEvents: got.keys.length, receivedCount: got.received.length, permissionRequests, clipboardChecks }))
  assert.equal(rendered, requested)
  assert.deepEqual(got.released, got.received)
  assert(got.keys.every((k: { trusted: boolean }) => k.trusted))
  assert(!got.keys.some((k: { key: string }) => ['Enter','Control','Meta','Alt'].includes(k.key)))
  assert.equal(permissionRequests, beforeKeyboard)
  assert.equal(clipboardChecks, beforeKeyboardChecks)
  await window.webContents.executeJavaScript('document.querySelector("textarea").focus()')
  await executeBrowserToolCommand({ command: ['type', 'DOM é €'], fns, sessionId: 'fixture' })
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("textarea").value'), 'DOM é €')
  await window.webContents.executeJavaScript(`new Promise(resolve => {
    const frame = document.createElement('iframe');
    frame.srcdoc = '<textarea></textarea>';
    frame.onload = () => { frame.contentDocument.querySelector('textarea').focus(); resolve(true) };
    document.body.append(frame);
  })`)
  await executeBrowserToolCommand({ command: ['type', 'Iframe é €'], fns, sessionId: 'fixture' })
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("iframe").contentDocument.querySelector("textarea").value'), 'Iframe é €')
  await assert.rejects(() => executeBrowserToolCommand({ command: ['type-keys', 'no iframe keys'], fns, sessionId: 'fixture' }), /partial/)
  // A separate secure loopback document exercises real clipboard policy denials.
  await window.loadURL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
  assert.equal(await window.webContents.executeJavaScript('typeof navigator.clipboard?.writeText'), 'function')
  const keysBeforeDeniedClipboard = await window.webContents.executeJavaScript('keys.length')
  // Real Chromium rejection response (exceptionDetails), without reading the OS clipboard.
  await assert.rejects(() => executeBrowserToolCommand({ command: ['paste', 'never paste this'], fns, sessionId: 'fixture' }), /Clipboard write failed/)
  await assert.rejects(() => cdp.getClipboard(), /Clipboard read failed/)
  assert.equal(await window.webContents.executeJavaScript('keys.length'), keysBeforeDeniedClipboard)
  console.log(JSON.stringify({ passed: true, receiver: 'Apache Guacamole.Keyboard 1.5.5', exactUnicodeRoundTrip: true, balancedKeyReleases: true, trustedKeyboardEvents: true, enterOrModifierEvents: 0, keyboardClipboardRequests: 0, deniedClipboardHasNoShortcut: true, clipboardPolicyRequests: permissionRequests, clipboardContext: 'isolated loopback HTTP', keyboardContext: 'isolated data document with emulated focus', nativeWindowFocusQualified: false, domAndCanvasDistinguished: true, remoteServerOrERPAccess: false }))
  cdp.detach(); window.destroy(); server.close(); clearTimeout(deadline); app.quit()
}).catch(error => { console.error(error); app.exit(1) })
