import { mock } from 'bun:test'
import type { WebContents, Rectangle, NativeImage } from 'electron'

export type Listener = (...args: unknown[]) => void

export type CapturedImage = NativeImage
export function completeCapturedImage(
  overrides: Pick<NativeImage, 'isEmpty' | 'getSize' | 'resize' | 'toPNG' | 'toJPEG'>,
): NativeImage {
  const unexpected = (): never => { throw new Error('Unexpected image operation in capture test') }
  return {
    addRepresentation: unexpected,
    crop: unexpected,
    getAspectRatio: unexpected,
    getBitmap: unexpected,
    getNativeHandle: unexpected,
    getScaleFactors: unexpected,
    isTemplateImage: unexpected,
    setTemplateImage: unexpected,
    toBitmap: unexpected,
    toDataURL: unexpected,
    isMacTemplateImage: false,
    ...overrides,
  }
}
export type WindowOpenDetails = Parameters<Parameters<WebContents['setWindowOpenHandler']>[0]>[0]

export type WindowOpenHandler = (details: Pick<WindowOpenDetails,'url'> & Partial<WindowOpenDetails>) => ReturnType<Parameters<WebContents['setWindowOpenHandler']>[0]>

export const createdWindows: ReturnType<typeof createUnregisteredMockWindow>[] = []

export const mockShellOpenExternal = mock(async (_url: string, _options?: {activate?:boolean}) => {})

export const mockIpcMainHandle = mock((_channel:string,_listener:(...args:unknown[])=>unknown) => {})

export const mockDialogShowMessageBox = mock(async (..._args:unknown[]) => ({ response: 0, checkboxChecked: false }))

export const mockSessionListeners: Record<string, Listener[]> = {}

export const mockNativeTheme = { shouldUseDarkColors: false }

export const mockCanvasImage = () => ({
  isEmpty: () => false, getSize: () => ({ width: 120, height: 90 }),
  crop: mock((_rect: unknown) => ({ isEmpty: () => false, toBitmap: () => Buffer.from([0, 0, 255, 255]), toPNG: () => Buffer.from('canvas-png') })),
})

interface BrowserFixtureState {
  toolbarLoadFailuresRemaining: number
  emptyStateLoadError: Error | null
  nextMockWebContentsId: number
  mockPermissionCheckHandler: ((...args: unknown[]) => boolean) | null
  mockPermissionRequestHandler: ((...args: unknown[]) => void) | null
  canvasImage: ReturnType<typeof mockCanvasImage>
}
export const browserFixture: BrowserFixtureState = {
  toolbarLoadFailuresRemaining: 0,
  emptyStateLoadError: null,
  nextMockWebContentsId: 0,
  mockPermissionCheckHandler: null,
  mockPermissionRequestHandler: null,
  canvasImage: mockCanvasImage()
}

export function createMockWebContents() {
  const listeners: Record<string, Listener[]> = {}
  let currentUrl = 'about:blank'
  return {
    id: ++browserFixture.nextMockWebContentsId,
    userAgent: 'Mock Chrome Electron/99.0.0',
    session: {},
    isDestroyed: mock(() => false),
    on: (event: string, cb: Listener) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    once: (event: string, cb: Listener) => {
      const wrapped = (...args: unknown[]) => {
        listeners[event] = (listeners[event] || []).filter(listener => listener !== wrapped)
        cb(...args)
      }
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(wrapped)
    },
    removeListener: (event: string, cb: Listener) => {
      listeners[event] = (listeners[event] || []).filter(listener => listener !== cb)
    },
    loadURL: mock(async (url: string) => {
      currentUrl = url
      if (url.includes('browser-empty-state.html') && browserFixture.emptyStateLoadError) {
        const error = browserFixture.emptyStateLoadError
        browserFixture.emptyStateLoadError = null
        throw error
      }
      const isToolbarUrl = typeof url === 'string' && url.includes('browser-toolbar.html')
      if (isToolbarUrl && browserFixture.toolbarLoadFailuresRemaining > 0) {
        browserFixture.toolbarLoadFailuresRemaining--
        throw new Error('mock toolbar load failure')
      }
    }),
    loadFile: mock(async (path: string, _opts?: unknown) => {
      const isToolbarUrl = typeof path === 'string' && path.includes('browser-toolbar.html')
      if (isToolbarUrl && browserFixture.toolbarLoadFailuresRemaining > 0) {
        browserFixture.toolbarLoadFailuresRemaining--
        throw new Error('mock toolbar load failure')
      }
    }),
    getTitle: mock(() => 'Test Page'),
    getURL: mock(() => currentUrl),
    canGoBack: mock(() => false),
    canGoForward: mock(() => false),
    goBack: mock(() => {}),
    goForward: mock(() => {}),
    reload: mock(() => {}),
    stop: mock(() => {}),
    setUserAgent: mock(() => {}),
    capturePage: mock(async (_rect?: Rectangle): Promise<CapturedImage> => {
      const img: CapturedImage = completeCapturedImage({
        isEmpty: () => false,
        getSize: () => ({ width: 2400, height: 1800 }),
        resize: (_opts: unknown) => img,
        toPNG: () => Buffer.from('fake-png'),
        toJPEG: (_quality: number) => Buffer.from('fake-jpeg'),
      })
      return img
    }),
    executeJavaScript: mock(async (expr: string): Promise<unknown> => {
      const result: unknown = eval(expr);
      return result;
    }),
    focus: mock(() => {}),
    setWindowOpenHandler: mock((_handler: WindowOpenHandler) => {}),
    send: mock((_channel: string, _payload?: unknown) => {}),
    debugger: {
      attach: mock(() => {}),
      detach: mock(() => {}),
      sendCommand: mock(async () => ({ nodes: [] })),
      on: mock(() => {}),
    },
    _listeners: listeners,
    _emit: (event: string, ...args: unknown[]) => {
      for (const cb of listeners[event] || []) {
        if (event === 'did-create-window') {
          cb(...args)
        } else {
          cb({}, ...args)
        }
      }
    },
  }
}

export function createMockWebContentsView() {
  const webContents = createMockWebContents()
  return {
    webContents,
    setBounds: mock((_bounds:Rectangle) => {}),
    setBackgroundColor: mock((_color: string) => {}),
  }
}

export function createUnregisteredMockWindow(opts?: { width?: number; height?: number; minWidth?: number; minHeight?: number }) {
  const listeners: Record<string, Listener[]> = {}
  const webContents = createMockWebContents()
  let contentWidth = opts?.width ?? 1200
  let contentHeight = opts?.height ?? 900
  const minWidth = opts?.minWidth ?? 0
  const minHeight = opts?.minHeight ?? 0
  const childViews: ReturnType<typeof createMockWebContentsView>[] = []
  let destroyed = false
  let resizable = true

  const win = {
    webContents,
    contentView: {
      children: childViews,
      addChildView: mock((view: ReturnType<typeof createMockWebContentsView>, index?: number) => {
        const existingIndex = childViews.indexOf(view)
        if (existingIndex >= 0) childViews.splice(existingIndex, 1)
        if (typeof index === 'number') childViews.splice(index, 0, view)
        else childViews.push(view)
      }),
      removeChildView: mock((view: ReturnType<typeof createMockWebContentsView>) => {
        const existingIndex = childViews.indexOf(view)
        if (existingIndex >= 0) childViews.splice(existingIndex, 1)
      }),
    },
    on: (event: string, cb: Listener) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    once: (event: string, cb: Listener) => {
      const wrapped = (...args: unknown[]) => {
        listeners[event] = (listeners[event] || []).filter(fn => fn !== wrapped)
        cb(...args)
      }
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(wrapped)
    },
    _emit: (event: string, ...args: unknown[]) => {
      for (const cb of listeners[event] || []) cb(...args)
    },
    isDestroyed: mock(() => destroyed),
    isResizable: mock(() => {
      if (destroyed) throw new TypeError('Object has been destroyed')
      return resizable
    }),
    setResizable: mock((value: boolean) => {
      if (destroyed) throw new TypeError('Object has been destroyed')
      resizable = value
    }),
    isMinimized: mock(() => false),
    restore: mock(() => {}),
    show: mock(() => {}),
    showInactive: mock(() => {}),
    setWindowButtonVisibility: mock((_visible: boolean) => {}),
    hide: mock(() => {
      win._emit('hide')
    }),
    focus: mock(() => {}),
    destroy: mock(() => {
      destroyed = true
      win._emit('closed')
    }),
    getContentSize: mock(() => [contentWidth, contentHeight]),
    setContentSize: mock((width: number, height: number) => {
      contentWidth = Math.max(minWidth, Math.floor(width))
      contentHeight = Math.max(minHeight, Math.floor(height))
    }),
    loadURL: mock(async (_url: string) => {}),
  }
  return win
}

export function createMockWindow(opts?: Parameters<typeof createUnregisteredMockWindow>[0]) {
  const win = createUnregisteredMockWindow(opts)
  createdWindows.push(win)
  return win
}

mock.module('electron', () => ({
  app: {
    getName: mock(() => 'Robb Agents'),
    getPath: mock((name: string) => name === 'downloads' ? '/tmp/mock-downloads' : `/tmp/mock-${name}`),
  },
  BrowserWindow: class MockBrowserWindow {
    webContents: ReturnType<typeof createMockWebContents>
    constructor(opts?: Parameters<typeof createMockWindow>[0]) {
      const win = createMockWindow(opts)
      this.webContents = win.webContents
      Object.assign(this, win)
    }
  },
  WebContentsView: class MockWebContentsView {
    webContents: ReturnType<typeof createMockWebContents>
    constructor(_opts?: unknown) {
      const view = createMockWebContentsView()
      this.webContents = view.webContents
      Object.assign(this, view)
    }
  },
  dialog: {
    showMessageBox: mockDialogShowMessageBox,
  },
  ipcMain: {
    handle: mockIpcMainHandle,
  },
  Menu: {
    buildFromTemplate: mock(() => ({
      popup: mock(() => {}),
    })),
  },
  nativeTheme: mockNativeTheme,
  nativeImage: { createFromBuffer: () => browserFixture.canvasImage },
  shell: {
    openExternal: mockShellOpenExternal,
  },
  session: {
    fromPartition: mock(() => ({
      setPermissionCheckHandler: mock((handler: (...args: unknown[]) => boolean) => {
        browserFixture.mockPermissionCheckHandler = handler
      }),
      setPermissionRequestHandler: mock((handler: (...args: unknown[]) => void) => {
        browserFixture.mockPermissionRequestHandler = handler
      }),
      webRequest: {
        onBeforeRequest: mock((_cb: Listener) => {}),
        onCompleted: mock((_cb: Listener) => {}),
        onErrorOccurred: mock((_cb: Listener) => {}),
      },
      on: mock((event: string, cb: Listener) => {
        if (!mockSessionListeners[event]) mockSessionListeners[event] = []
        mockSessionListeners[event].push(cb)
      }),
    })),
  },
}))

mock.module('../../logger', () => {
  const stubLog = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  return {
    mainLog: stubLog,
    sessionLog: stubLog,
    handlerLog: stubLog,
    windowLog: stubLog,
    agentLog: stubLog,
    searchLog: stubLog,
    isDebugMode: false,
    getLogFilePath: () => '/tmp/main.log',
  }
})
