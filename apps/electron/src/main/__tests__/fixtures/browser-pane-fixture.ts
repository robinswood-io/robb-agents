import './electron-browser-mocks'
import { mock } from 'bun:test'
import type { BrowserWindow, WebContents, WebContentsView } from 'electron'
import type { CanvasBitmapReceipt } from '../../browser-canvas-capture'
import { browserFixture, createMockWebContents, createMockWebContentsView, createMockWindow, createdWindows, mockCanvasImage, mockDialogShowMessageBox, mockIpcMainHandle, mockNativeTheme, mockSessionListeners, mockShellOpenExternal } from './electron-browser-mocks'
export * from './electron-browser-mocks'

mock.module('../../browser-cdp', () => ({
  BrowserCDP: class MockBrowserCDP {
    detach = mock(() => {})
    getAccessibilitySnapshot = mock(async () => ({
      url: 'https://example.com',
      title: 'Example',
      nodes: [],
    }))
    clickElement = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    fillElement = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    selectOption = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    renderTemporaryOverlay = mock(async () => {})
    clearTemporaryOverlay = mock(async () => {})
    getViewportMetrics = mock(async () => ({ width: 1200, height: 900, dpr: 2, scrollX: 0, scrollY: 0 }))
    getElementGeometry = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    getElementGeometryBySelector = mock(async () => ({
      ref: 'selector:div.card',
      box: { x: 5, y: 5, width: 20, height: 20 },
      clickPoint: { x: 15, y: 15 },
    }))
  },
}))

export const { BrowserPaneManager } = await import('../../browser-pane-manager')

export type NativeBrowserInstance = NonNullable<ReturnType<InstanceType<typeof BrowserPaneManager>['instances']['get']>>

export type TestWebContents = Omit<WebContents,keyof ReturnType<typeof createMockWebContents>> & ReturnType<typeof createMockWebContents>

export type TestView = Omit<WebContentsView,'webContents'> & Omit<ReturnType<typeof createMockWebContentsView>,'webContents'> & {webContents:TestWebContents}

export type TestWindow = Omit<BrowserWindow,keyof ReturnType<typeof createMockWindow>> & Omit<ReturnType<typeof createMockWindow>,'webContents'> & {webContents:TestWebContents}

export type TestBrowserInstance = Omit<NativeBrowserInstance,'window'|'pageView'|'toolbarView'|'nativeOverlayView'> & {
 window:TestWindow;pageView:TestView;toolbarView:TestView;nativeOverlayView:TestView
}

export function getTestBrowserInstance(manager:InstanceType<typeof BrowserPaneManager>,id:string):TestBrowserInstance {
 const instance=manager['instances'].get(id)
 if(!instance)throw new Error('Missing test browser instance: '+id)
 // Only the Electron module is simulated; native manager and CDP contracts stay typed.
 return instance as unknown as TestBrowserInstance
}

export /** Deliberately malformed wire inputs must reach the production runtime guard. */
function invalidScreenshotOptions(value:unknown):Parameters<InstanceType<typeof BrowserPaneManager>['screenshotRegion']>[1] {
 return value as Parameters<InstanceType<typeof BrowserPaneManager>['screenshotRegion']>[1]
}

export function invalidKeyInput(value:unknown):Parameters<InstanceType<typeof BrowserPaneManager>['sendKey']>[1] {
 return value as Parameters<InstanceType<typeof BrowserPaneManager>['sendKey']>[1]
}

export function createCanvasReceipt(overrides:Partial<CanvasBitmapReceipt>={}):CanvasBitmapReceipt {
 return { dataUrl:'data:image/png;base64,UE5H',width:4,height:3,
  sourceRect:{x:0,y:0,width:4,height:3},region:{x:0,y:0,width:4,height:3},
  canvasBox:{x:0,y:0,width:4,height:3},
  viewport:{width:1200,height:900,dpr:1,scrollX:0,scrollY:0},capturedAt:1,...overrides }
}

export function invalidCapabilityRequest(value:unknown):Parameters<InstanceType<typeof BrowserPaneManager>['dispatchCapability']>[0] {
 return value as Parameters<InstanceType<typeof BrowserPaneManager>['dispatchCapability']>[0]
}

export function createBrowserPaneTestManager() {
createdWindows.length = 0
browserFixture.toolbarLoadFailuresRemaining = 0
browserFixture.emptyStateLoadError = null
mockNativeTheme.shouldUseDarkColors = false
browserFixture.canvasImage = mockCanvasImage()
mockShellOpenExternal.mockClear()
mockIpcMainHandle.mockClear()
mockDialogShowMessageBox.mockClear()
browserFixture.mockPermissionCheckHandler = null
browserFixture.mockPermissionRequestHandler = null
for (const event of Object.keys(mockSessionListeners)) delete mockSessionListeners[event]
return new BrowserPaneManager()
}
