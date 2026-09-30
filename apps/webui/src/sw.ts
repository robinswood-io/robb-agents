const CACHE_PREFIX = 'robb-agents-pwa-'
const SHELL_CACHE = `${CACHE_PREFIX}shell-${import.meta.env.PWA_CACHE_VERSION}`
const SHELL_READY_URL = '/__robb_pwa_shell_ready__'
const NAVIGATION_TIMEOUT_MS = 8_000

const PRECACHE_URLS = [
  '/index.html',
  '/offline.html',
  '/manifest.json',
  '/favicon.ico',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
] as const

interface ExtendableWorkerEvent extends Event {
  waitUntil(promise: Promise<unknown>): void
}

interface FetchWorkerEvent extends ExtendableWorkerEvent {
  request: Request
  respondWith(response: Promise<Response> | Response): void
}

interface MessageWorkerEvent extends ExtendableWorkerEvent {
  data?: unknown
}

interface ServiceWorkerRuntime {
  location: Location
  caches: CacheStorage
  clients: { claim(): Promise<void> }
  skipWaiting(): Promise<void>
  addEventListener(type: string, listener: (event: Event) => void): void
}

const worker = globalThis as unknown as ServiceWorkerRuntime

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPrivateNetworkPath(pathname: string): boolean {
  return pathname === '/api'
    || pathname.startsWith('/api/')
    || pathname === '/ws'
    || pathname.startsWith('/ws/')
}

function isCacheableShellPath(pathname: string): boolean {
  if (PRECACHE_URLS.includes(pathname as typeof PRECACHE_URLS[number])) return true
  if (!pathname.startsWith('/assets/')) return false
  return /\.(?:css|js|mjs|woff2?|ttf|png|svg|ico)$/i.test(pathname)
    && !pathname.endsWith('.map')
}

function normalizeWarmUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value, worker.location.origin)
    if (url.origin !== worker.location.origin || !isCacheableShellPath(url.pathname)) return null
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

async function cacheResponse(cache: Cache, request: Request): Promise<void> {
  const response = await fetch(request)
  if (!response.ok || response.type === 'opaque') {
    throw new Error(`Unable to cache ${new URL(request.url).pathname}`)
  }
  await cache.put(request, response)
}

async function precacheShell(): Promise<void> {
  const cache = await worker.caches.open(SHELL_CACHE)
  await Promise.all(PRECACHE_URLS.map((path) => cacheResponse(
    cache,
    new Request(path, { cache: 'reload', credentials: 'same-origin' }),
  )))
}

async function warmShellResources(
  values: readonly unknown[],
  requiredValues: readonly unknown[],
): Promise<void> {
  const requiredUrls = [...new Set(requiredValues
    .map(normalizeWarmUrl)
    .filter((value): value is string => value !== null))]
  const urls = [...new Set([
    ...values.map(normalizeWarmUrl).filter((value): value is string => value !== null),
    ...requiredUrls,
  ])]
  const cache = await worker.caches.open(SHELL_CACHE)

  // A navigation may use index.html offline only after every JS/CSS entry
  // referenced by that document is cached. Otherwise the standalone offline
  // page is safer than an app shell stuck forever on its loading state.
  const hasRequiredScript = requiredUrls.some((value) => /\.(?:js|mjs)$/i.test(new URL(value).pathname))
  const hasRequiredStylesheet = requiredUrls.some((value) => /\.css$/i.test(new URL(value).pathname))
  const canBecomeReady = hasRequiredScript && hasRequiredStylesheet
  if (canBecomeReady) await cache.delete(SHELL_READY_URL)

  await Promise.allSettled(urls.map(async (url) => {
    const request = new Request(url, { cache: 'reload', credentials: 'same-origin' })
    const existing = await cache.match(request, { ignoreSearch: true, ignoreVary: true })
    if (!existing) await cacheResponse(cache, request)
  }))

  if (!canBecomeReady) return
  const requiredResponses = await Promise.all(requiredUrls.map((url) => cache.match(
    new Request(url, { credentials: 'same-origin' }),
    { ignoreSearch: true, ignoreVary: true },
  )))
  if (requiredResponses.every(Boolean)) {
    await cache.put(SHELL_READY_URL, new Response('ready', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    }))
  }
}

async function cleanOldCaches(): Promise<void> {
  const names = await worker.caches.keys()
  await Promise.all(names
    .filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE)
    .map((name) => worker.caches.delete(name)))
}

async function fetchNavigation(request: Request): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS)

  try {
    return await fetch(request, { signal: controller.signal })
  } catch {
    const cache = await worker.caches.open(SHELL_CACHE)
    const shellReady = await cache.match(SHELL_READY_URL)
    return (shellReady ? await cache.match('/index.html') : null)
      ?? await cache.match('/offline.html')
      ?? new Response('Robb Agents is offline', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchShellAsset(request: Request): Promise<Response> {
  const cache = await worker.caches.open(SHELL_CACHE)
  // Build assets are public, immutable, same-origin resources. Some reverse
  // proxies add `Vary: Origin`; ignoring that transport-only header lets the
  // cached response satisfy the browser's later `crossorigin` module request.
  const cached = await cache.match(request, { ignoreSearch: true, ignoreVary: true })
  if (cached) return cached

  const response = await fetch(request)
  if (response.ok && response.type !== 'opaque') {
    await cache.put(request, response.clone())
  }
  return response
}

worker.addEventListener('install', (rawEvent) => {
  const event = rawEvent as ExtendableWorkerEvent
  event.waitUntil(precacheShell())
})

worker.addEventListener('activate', (rawEvent) => {
  const event = rawEvent as ExtendableWorkerEvent
  event.waitUntil(Promise.all([cleanOldCaches(), worker.clients.claim()]))
})

worker.addEventListener('message', (rawEvent) => {
  const event = rawEvent as MessageWorkerEvent
  if (!isRecord(event.data) || typeof event.data.type !== 'string') return

  if (event.data.type === 'SKIP_WAITING') {
    event.waitUntil(worker.skipWaiting())
    return
  }

  if (event.data.type === 'WARM_SHELL' && Array.isArray(event.data.urls)) {
    event.waitUntil(warmShellResources(
      event.data.urls,
      Array.isArray(event.data.requiredUrls) ? event.data.requiredUrls : [],
    ))
  }
})

worker.addEventListener('fetch', (rawEvent) => {
  const event = rawEvent as FetchWorkerEvent
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== worker.location.origin || isPrivateNetworkPath(url.pathname)) return

  if (request.mode === 'navigate') {
    event.respondWith(fetchNavigation(request))
    return
  }

  if (isCacheableShellPath(url.pathname)) {
    event.respondWith(fetchShellAsset(request))
  }
})
