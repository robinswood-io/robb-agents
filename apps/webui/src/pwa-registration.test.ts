import { describe, expect, it } from 'bun:test'
import {
  isCorePwaResourceUrl,
  shouldReloadForControllerChange,
  snapshotCorePwaResources,
} from './pwa-registration'

type WorkerEventListener = (event: Event) => void

function replaceGlobal(name: string, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  })
  return () => {
    if (original) Object.defineProperty(globalThis, name, original)
    else delete (globalThis as Record<string, unknown>)[name]
  }
}

describe('PWA core resource filtering', () => {
  const origin = 'https://remote.example.com'

  it('accepts only cacheable same-origin build assets', () => {
    for (const value of [
      '/assets/app-abc123.js',
      '/assets/app-abc123.css?version=1#theme',
      'https://remote.example.com/assets/font.woff2',
      './assets/icon.png',
    ]) {
      expect(isCorePwaResourceUrl(value, origin)).toBe(true)
    }
  })

  it('excludes APIs, source maps, cross-origin URLs, and non-build resources', () => {
    for (const value of [
      '/api/config',
      '/api/config.js',
      '/assets/../api/config.js',
      '/assets/app-abc123.js.map',
      'https://cdn.example.com/assets/app-abc123.js',
      '//cdn.example.com/assets/app-abc123.css',
      '/login-assets/login.js',
      '/assets/no-extension',
      'data:text/javascript,console.log(1)',
      'http://[invalid',
    ]) {
      expect(isCorePwaResourceUrl(value, origin)).toBe(false)
    }
  })

  it('returns no browser resource snapshot outside a DOM environment', () => {
    expect(snapshotCorePwaResources()).toEqual([])
  })
})

describe('PWA multi-tab update activation', () => {
  it('reloads the requesting tab and every sibling tab that already had a controller', () => {
    expect(shouldReloadForControllerChange(true, true, false)).toBe(true)
    expect(shouldReloadForControllerChange(false, true, false)).toBe(true)
  })

  it('does not reload on first install or more than once', () => {
    expect(shouldReloadForControllerChange(false, false, false)).toBe(false)
    expect(shouldReloadForControllerChange(true, true, true)).toBe(false)
  })

  it('reloads on a later sibling update after an initially uncontrolled first install', () => {
    let hasEverBeenControlled = false
    expect(shouldReloadForControllerChange(false, hasEverBeenControlled, false)).toBe(false)

    hasEverBeenControlled = true
    expect(shouldReloadForControllerChange(false, hasEverBeenControlled, false)).toBe(true)
  })
})

describe('PWA service worker fetch boundary', () => {
  it('keeps private traffic out of CacheStorage and falls back to the standalone page until every entrypoint is warm', async () => {
    const origin = 'https://remote.example.com'
    const listeners = new Map<string, WorkerEventListener>()
    const cachedResponses = new Map<string, Response>([
      ['/index.html', new Response('application shell')],
      ['/offline.html', new Response('standalone offline page')],
    ])
    const cacheKey = (value: RequestInfo | URL) => {
      const raw = value instanceof Request ? value.url : String(value)
      return new URL(raw, origin).pathname
    }
    const cache = {
      match: async (value: RequestInfo | URL) => cachedResponses.get(cacheKey(value))?.clone(),
      put: async (value: RequestInfo | URL, response: Response) => {
        cachedResponses.set(cacheKey(value), response.clone())
      },
      delete: async (value: RequestInfo | URL) => cachedResponses.delete(cacheKey(value)),
    }
    let failStylesheet = true
    const restoreGlobals = [
      replaceGlobal('location', new URL(origin)),
      replaceGlobal('addEventListener', (type: string, listener: WorkerEventListener) => {
        listeners.set(type, listener)
      }),
      replaceGlobal('caches', {
        open: async () => cache,
      }),
      replaceGlobal('fetch', async (value: RequestInfo | URL) => {
        const raw = value instanceof Request
          ? value.url
          : typeof value === 'object' && value !== null && 'url' in value
            ? String(value.url)
            : String(value)
        const path = new URL(raw, origin).pathname
        if (path === '/') throw new TypeError('offline')
        if (path.endsWith('.css') && failStylesheet) throw new TypeError('offline')
        return new Response(`network ${path}`, { status: 200 })
      }),
    ]

    try {
      await import('./sw')
      const fetchListener = listeners.get('fetch')
      expect(fetchListener).toBeDefined()
      if (!fetchListener) throw new Error('Service worker did not register a fetch listener')
      const registeredFetchListener = fetchListener

      async function responseFor(url: string, method = 'GET'): Promise<Response | null> {
        let response: Promise<Response> | Response | null = null
        registeredFetchListener({
          request: new Request(url, { method }),
          respondWith(value: Promise<Response> | Response) {
            response = value
          },
        } as unknown as Event)
        return response ? await response : null
      }

      expect(await responseFor(`${origin}/api/config`)).toBeNull()
      expect(await responseFor(`${origin}/api/config.js`)).toBeNull()
      expect(await responseFor(`${origin}/ws`)).toBeNull()
      expect(await responseFor(`${origin}/assets/app.js.map`)).toBeNull()
      expect(await responseFor('https://cdn.example.com/assets/app.js')).toBeNull()
      expect(await responseFor(`${origin}/assets/app.js`, 'POST')).toBeNull()
      expect(await responseFor(`${origin}/assets/app.js`)).not.toBeNull()

      const messageListener = listeners.get('message')
      expect(messageListener).toBeDefined()
      if (!messageListener) throw new Error('Service worker did not register a message listener')
      const warm = async () => {
        let work = Promise.resolve()
        messageListener({
          data: {
            type: 'WARM_SHELL',
            urls: [`${origin}/assets/main.js`, `${origin}/assets/main.css`],
            requiredUrls: [`${origin}/assets/main.js`, `${origin}/assets/main.css`],
          },
          waitUntil(value: Promise<unknown>) {
            work = value.then(() => undefined)
          },
        } as unknown as Event)
        await work
      }
      const offlineNavigation = async () => {
        return await new Promise<Response>((resolve, reject) => {
          let intercepted = false
          registeredFetchListener({
            request: { method: 'GET', mode: 'navigate', url: `${origin}/` },
            respondWith(value: Promise<Response> | Response) {
              intercepted = true
              Promise.resolve(value).then(resolve, reject)
            },
          } as unknown as Event)
          if (!intercepted) reject(new Error('Navigation was not intercepted'))
        })
      }

      await warm()
      expect(await (await offlineNavigation()).text()).toBe('standalone offline page')

      failStylesheet = false
      await warm()
      expect(await (await offlineNavigation()).text()).toBe('application shell')
      expect([...cachedResponses.keys()].some((key) => key.startsWith('/api'))).toBe(false)
    } finally {
      for (const restore of restoreGlobals.reverse()) restore()
    }
  })
})
