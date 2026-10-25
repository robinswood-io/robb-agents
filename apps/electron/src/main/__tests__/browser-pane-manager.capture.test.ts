import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { browserFixture, createBrowserPaneTestManager, createCanvasReceipt, getTestBrowserInstance, invalidScreenshotOptions } from './fixtures/browser-pane-fixture'
import type { CapturedImage } from './fixtures/browser-pane-fixture'

describe('BrowserPaneManager', () => {
let manager: ReturnType<typeof createBrowserPaneTestManager>
beforeEach(() => { manager = createBrowserPaneTestManager() })
it('captures an explicit canvas crop without capturePage, overlay changes, focus or clipboard', async () => {
    manager.createInstance('canvas-image', { ownerType: 'session', ownerSessionId: 'task', workspaceId: 'ws' })
    const instance = getTestBrowserInstance(manager, 'canvas-image')
    instance.cdp.captureCanvasBitmap = mock(async (_selector: string, current: () => boolean = () => true) => {
      expect(current()).toBe(true)
      return { png: Buffer.from('validated-source-png'), receipt: createCanvasReceipt({
        width: 120, height: 90, sourceRect: { x: 0, y: 0, width: 80, height: 60 },
        region: { x: 10, y: 20, width: 40, height: 30 }, canvasBox: { x: 10, y: 20, width: 60, height: 45 },
        viewport: { width: 1200, height: 852, dpr: 2, scrollX: 0, scrollY: 0 }, capturedAt: 123,
      }) }
    })
    const result = await manager.screenshotRegion('canvas-image', { source: 'canvas', selector: 'canvas' })
    expect(result.metadata?.source).toBe('canvas-bitmap')
    expect(result.metadata?.imageToViewport).toEqual({ x: 10, y: 20, scaleX: 0.5, scaleY: 0.5 })
    expect(browserFixture.canvasImage.crop).toHaveBeenCalledWith({ x: 0, y: 0, width: 80, height: 60 })
    expect(result.imageBuffer.toString()).toBe('canvas-png')
    expect(instance.pageView.webContents.capturePage).not.toHaveBeenCalled()
    expect(instance.pageView.webContents.focus).not.toHaveBeenCalled()
    expect(instance.cdp.renderTemporaryOverlay).not.toHaveBeenCalled()
  })

it('rejects a canvas image after its owner changes during the read', async () => {
    manager.createInstance('canvas-race', { ownerType: 'session', ownerSessionId: 'task', workspaceId: 'ws' })
    const instance = getTestBrowserInstance(manager, 'canvas-race')
    instance.cdp.captureCanvasBitmap = mock(async () => { instance.ownerSessionId = 'other'; return { png: Buffer.alloc(0), receipt: createCanvasReceipt({}) } })
    await expect(manager.screenshotRegion('canvas-race', { source: 'canvas', selector: 'canvas' })).rejects.toThrow('ownership changed')
  })

it('does not widen the remote browser owner gate for canvas capture', async () => {
    manager.createInstance('canvas-owner', { ownerType: 'session', ownerSessionId: 'remote:ws:other', workspaceId: 'ws' })
    const instance = getTestBrowserInstance(manager, 'canvas-owner')
    instance.cdp.captureCanvasBitmap = mock(async () => { throw Error('must not read') })
    await expect(manager['dispatchCapability']({ v: 1, workspaceId: 'ws', sessionId: 'task', method: 'screenshotRegion', args: ['canvas-owner', { source: 'canvas', selector: 'canvas' }] })).rejects.toThrow('not owned')
    expect(instance.cdp.captureCanvasBitmap).not.toHaveBeenCalled()
  })

it('rejects ambiguous or unbounded transport options without attempting a canvas read', async () => {
    manager.createInstance('canvas-args')
    const instance = getTestBrowserInstance(manager, 'canvas-args')
    instance.cdp.captureCanvasBitmap = mock(async () => { throw Error('must not read') })
    for (const extra of [{ padding: 0 }, { ref: '@e1' }, { x: 1 }, { selector: ['canvas'] }, { format: 'jpeg' }, { source: true }]) {
      await expect(manager.screenshotRegion('canvas-args', invalidScreenshotOptions({ source: 'canvas', selector: 'canvas', ...extra }))).rejects.toThrow('Canvas capture requires')
    }
    expect(instance.cdp.captureCanvasBitmap).not.toHaveBeenCalled()
  })

it('does not turn an empty/transparent bitmap or oversized encoding into a successful screenshot', async () => {
    manager.createInstance('canvas-empty')
    const instance = getTestBrowserInstance(manager, 'canvas-empty')
    instance.cdp.captureCanvasBitmap = mock(async () => ({ png: Buffer.from('validated-source'), receipt: createCanvasReceipt({
      width: 120, height: 90, sourceRect: { x: 0, y: 0, width: 80, height: 60 },
    }) }))
    browserFixture.canvasImage.crop = mock(() => ({ isEmpty: () => false, toBitmap: () => Buffer.alloc(4), toPNG: () => Buffer.from('data') }))
    await expect(manager.screenshotRegion('canvas-empty', { source: 'canvas', selector: 'canvas' })).rejects.toThrow('does not prove')
    browserFixture.canvasImage.crop = mock(() => ({ isEmpty: () => false, toBitmap: () => Buffer.from([0, 0, 0, 255]), toPNG: () => Buffer.alloc(4 * 1024 * 1024 + 1) }))
    await expect(manager.screenshotRegion('canvas-empty', { source: 'canvas', selector: 'canvas' })).rejects.toThrow('image limit')
    expect(instance.pageView.webContents.capturePage).not.toHaveBeenCalled()
  })

it('throws when screenshot capture returns empty NativeImage', async () => {
    manager.createInstance('screenshot-empty-image')
    const instance = getTestBrowserInstance(manager, 'screenshot-empty-image')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: function(this: CapturedImage) { return this },
      toPNG: () => Buffer.from('ignored'),
      toJPEG: () => Buffer.from('ignored'),
    }))

    await expect(manager.screenshot('screenshot-empty-image')).rejects.toThrow('Failed to capture screenshot: empty image buffer')
  })

it('throws when screenshot capture returns empty PNG buffer', async () => {
    manager.createInstance('screenshot-empty-png')
    const instance = getTestBrowserInstance(manager, 'screenshot-empty-png')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2400, height: 1800 }),
      resize: function(this: CapturedImage) { return this },
      toPNG: () => Buffer.alloc(0),
      toJPEG: () => Buffer.alloc(0),
    }))

    await expect(manager.screenshot('screenshot-empty-png')).rejects.toThrow('Failed to capture screenshot: empty image buffer')
  })

it('recovers screenshot via non-disruptive inactive reveal and restores hidden state', async () => {
    manager.createInstance('screenshot-rescue-success')
    const instance = getTestBrowserInstance(manager, 'screenshot-rescue-success')

    let captureCalls = 0
    instance.pageView.webContents.capturePage = mock(async () => {
      captureCalls += 1
      if (captureCalls <= 3) {
        return {
          isEmpty: () => true,
          getSize: () => ({ width: 0, height: 0 }),
          resize: function(this: CapturedImage) { return this },
          toPNG: () => Buffer.alloc(0),
          toJPEG: () => Buffer.alloc(0),
        }
      }

      const img = {
        isEmpty: () => false,
        getSize: () => ({ width: 2400, height: 1800 }),
        resize: () => img,
        toPNG: () => Buffer.from('rescued-png'),
        toJPEG: (_q: number) => Buffer.from('rescued-jpeg'),
      }
      return img
    })

    const result = await manager.screenshot('screenshot-rescue-success', { includeMetadata: true })

    expect(result.imageBuffer.toString()).toBe('rescued-png')
    expect(instance.window.showInactive).toHaveBeenCalledTimes(1)
    expect(instance.window.focus).not.toHaveBeenCalled()
    expect(instance.window.hide).toHaveBeenCalled()
    expect(result.metadata?.warnings?.some((w: string) => w.includes('temporary inactive reveal'))).toBe(true)
  })

it('throws when region screenshot capture returns empty NativeImage', async () => {
    manager.createInstance('region-empty-image')
    const instance = getTestBrowserInstance(manager, 'region-empty-image')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: function(this: CapturedImage) { return this },
      toPNG: () => Buffer.from('ignored'),
      toJPEG: () => Buffer.from('ignored'),
    }))

    await expect(manager.screenshotRegion('region-empty-image', { x: 10, y: 20, width: 120, height: 80 })).rejects.toThrow(
      'Failed to capture region screenshot: empty image buffer'
    )
  })

it('throws when region screenshot capture returns empty PNG buffer', async () => {
    manager.createInstance('region-empty-png')
    const instance = getTestBrowserInstance(manager, 'region-empty-png')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2400, height: 1800 }),
      resize: function(this: CapturedImage) { return this },
      toPNG: () => Buffer.alloc(0),
      toJPEG: () => Buffer.alloc(0),
    }))

    await expect(manager.screenshotRegion('region-empty-png', { x: 10, y: 20, width: 120, height: 80 })).rejects.toThrow(
      'Failed to capture region screenshot: empty image buffer'
    )
  })

it('captures screenshot region from ref target', async () => {
    manager.createInstance('region-ref')
    const result = await manager.screenshotRegion('region-ref', { ref: '@e1' })

    expect(result.imageBuffer).toBeInstanceOf(Buffer)
    expect(result.metadata?.targetMode).toBe('ref')
  })

it('captures screenshot region from selector target', async () => {
    manager.createInstance('region-selector')
    const result = await manager.screenshotRegion('region-selector', { selector: 'div.card', padding: 4 })

    expect(result.imageBuffer).toBeInstanceOf(Buffer)
    expect(result.metadata?.targetMode).toBe('selector')
  })

it('throws for ambiguous screenshot region target modes', async () => {
    manager.createInstance('region-ambiguous')

    await expect(
      manager.screenshotRegion('region-ambiguous', { ref: '@e1', selector: 'div.card' })
    ).rejects.toThrow('Region screenshot target is ambiguous')
  })

it('throws when selector target cannot be resolved', async () => {
    manager.createInstance('region-selector-missing')
    const instance = getTestBrowserInstance(manager, 'region-selector-missing')
    instance.cdp.getElementGeometryBySelector = mock(async () => {
      throw new Error('No element found for selector "div.missing"')
    })

    await expect(
      manager.screenshotRegion('region-selector-missing', { selector: 'div.missing' })
    ).rejects.toThrow('No element found for selector "div.missing"')
  })

it('throws when resolved region is outside viewport', async () => {
    manager.createInstance('region-oob')

    await expect(
      manager.screenshotRegion('region-oob', { x: 5000, y: 5000, width: 100, height: 100 })
    ).rejects.toThrow('Resolved screenshot region is outside the current viewport')
  })
})
