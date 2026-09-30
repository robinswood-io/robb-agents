import { afterEach, describe, expect, it, mock } from 'bun:test'
mock.module('../logger', () => ({ mainLog: { info() {}, warn() {}, error() {}, debug() {} } }))
const { BrowserCDP } = await import('../browser-cdp')
const instances: InstanceType<typeof BrowserCDP>[] = []
afterEach(() => { for (const cdp of instances.splice(0)) cdp.detach() })
function fixture(handler?: (method: string, args: any) => unknown) {
  const calls: Array<{ method: string; args: any }> = []
  let url = 'https://rdp.example.test/'
  const wc = { getURL: () => url, debugger: { attach() {}, detach() {}, on() {},
    async sendCommand(method: string, args: any) {
      calls.push({ method, args })
      const response = handler?.(method, args)
      if (response !== undefined) return response
      if (method === 'Runtime.evaluate') return { result: { type: 'object', objectId: 'focused-canvas' } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: true } }
      return {}
    },
  } }
  const cdp = new BrowserCDP(wc as any); instances.push(cdp)
  return { cdp, calls, navigate: () => { url = 'https://other.example.test/' } }
}
const denied = { result: { type: 'object', subtype: 'error' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'NotAllowedError: PRIVATE_VALUE' } } }
describe('browser input receipts', () => {
  it('rejects a denied clipboard write without exposing the input or exception payload', async () => {
    const { cdp } = fixture(() => denied)
    await expect(cdp.setClipboard('PRIVATE_VALUE')).rejects.toThrow('Clipboard write failed')
    try { await cdp.setClipboard('PRIVATE_VALUE') } catch (error) { expect(String(error)).not.toContain('PRIVATE_VALUE') }
  })
  it('does not turn a rejected clipboard read into an empty clipboard', async () => {
    const { cdp } = fixture(() => denied)
    await expect(cdp.getClipboard()).rejects.toThrow('Clipboard read failed')
  })
  it('distinguishes a confirmed empty clipboard from an absent receipt', async () => {
    const good = fixture(() => ({ result: { type: 'string', value: '' } }))
    expect(await good.cdp.getClipboard()).toBe('')
    const bad = fixture(() => ({}))
    await expect(bad.cdp.getClipboard()).rejects.toThrow('Clipboard read failed')
    await expect(bad.cdp.setClipboard('text')).rejects.toThrow('Clipboard write failed')
  })
  it('refuses a canvas/body DOM insertion before reporting typed text', async () => {
    const { cdp, calls } = fixture(() => ({ result: { value: false } }))
    await expect(cdp.typeText('do not silently lose this')).rejects.toThrow('type-keys')
    expect(calls.some(x => x.method === 'Input.insertText')).toBe(false)
  })
  it('dispatches printable text as balanced character events, never paste or Enter', async () => {
    const { cdp, calls } = fixture()
    await cdp.typeKeys('Az é€\\[]')
    const events = calls.filter(x => x.method === 'Input.dispatchKeyEvent').map(x => x.args)
    expect(events.filter(x => x.type === 'keyDown').map(x => x.key).join('')).toBe('Az é€\\[]')
    expect(events.filter(x => x.type === 'keyUp').map(x => x.key).join('')).toBe('Az é€\\[]')
    expect(events.every(x => x.key !== 'Enter' && !x.modifiers)).toBe(true)
    expect(calls.some(x => JSON.stringify(x.args).includes('clipboard'))).toBe(false)
  })
  it('rejects controls, newlines, surrogate characters and overlong text before any event', async () => {
    for (const text of ['', 'a\nb', 'a\tb', '\u007f', '\u0085', '\u2028', '\u2029', '\u202e', '\u200b', '😀', 'a'.repeat(257)]) {
      const { cdp, calls } = fixture()
      await expect(cdp.typeKeys(text)).rejects.toThrow('printable')
      expect(calls).toHaveLength(0)
    }
  })
  it('rejects non-string transport payloads before any CDP command (including an Enter array)', async () => {
    for (const value of [['Enter'], ['a', 'b'], 42, true, {}, null, undefined]) {
      const { cdp, calls } = fixture()
      await expect(cdp.typeKeys(value as unknown as string)).rejects.toThrow('printable')
      expect(calls).toHaveLength(0)
    }
  })
  it('releases a key on transport failure and does not replay the remaining text', async () => {
    const { cdp, calls } = fixture((method, args) => {
      if (method === 'Input.dispatchKeyEvent' && args.type === 'keyDown') throw new Error('transport failed')
    })
    await expect(cdp.typeKeys('ab')).rejects.toThrow('partial')
    expect(calls.filter(x => x.method === 'Input.dispatchKeyEvent').map(x => [x.args.type, x.args.key])).toEqual([['keyDown', 'a'], ['keyUp', 'a']])
  })
  it('stops after navigation without replaying the prefix', async () => {
    let navigate = () => {}
    const f = fixture((method, args) => { if (method === 'Input.dispatchKeyEvent' && args.type === 'keyDown') navigate() })
    navigate = f.navigate
    await expect(f.cdp.typeKeys('ab')).rejects.toThrow('partial')
    expect(f.calls.filter(x => x.method === 'Input.dispatchKeyEvent').map(x => x.args.key)).toEqual(['a', 'a'])
  })
  it('rechecks ownership after focus observation before pressing a key', async () => {
    let current = true
    const { cdp, calls } = fixture(method => {
      if (method === 'Runtime.callFunctionOn') { current = false; return { result: { value: true } } }
    })
    await expect(cdp.typeKeys('abc', () => current)).rejects.toThrow('partial')
    expect(calls.some(x => x.method === 'Input.dispatchKeyEvent')).toBe(false)
  })
  it('stops when the original focused element is replaced', async () => {
    let checks = 0
    const { cdp, calls } = fixture((method) => { if (method === 'Runtime.callFunctionOn') return { result: { value: ++checks === 1 } } })
    await expect(cdp.typeKeys('ab')).rejects.toThrow('partial')
    expect(calls.filter(x => x.method === 'Input.dispatchKeyEvent').map(x => x.args.key)).toEqual(['a', 'a'])
  })
})
