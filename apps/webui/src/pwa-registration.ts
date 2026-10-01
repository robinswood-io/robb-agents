export type PwaUpdateListener = (registration: ServiceWorkerRegistration | null) => void

const CORE_ASSET_PATTERN = /\.(?:css|js|mjs|woff2?|ttf|png|svg|ico)$/i
const updateListeners = new Set<PwaUpdateListener>()
let waitingRegistration: ServiceWorkerRegistration | null = null
let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null
let reloadForUpdate = false
let hasReloadedForUpdate = false
const controlledAtStartup = typeof navigator !== 'undefined'
  && 'serviceWorker' in navigator
  && Boolean(navigator.serviceWorker.controller)
let hasEverBeenControlled = controlledAtStartup

export function shouldReloadForControllerChange(
  updateRequested: boolean,
  wasControlledAtStartup: boolean,
  alreadyReloaded: boolean,
): boolean {
  return !alreadyReloaded && (updateRequested || wasControlledAtStartup)
}

function publishUpdate(): void {
  for (const listener of updateListeners) listener(waitingRegistration)
}

export function isCorePwaResourceUrl(value: string, origin: string): boolean {
  try {
    const url = new URL(value, origin)
    return url.origin === origin
      && url.pathname.startsWith('/assets/')
      && CORE_ASSET_PATTERN.test(url.pathname)
      && !url.pathname.endsWith('.map')
  } catch {
    return false
  }
}

export function snapshotCorePwaResources(): string[] {
  if (typeof window === 'undefined' || typeof document === 'undefined') return []
  const urls = new Set<string>()
  const add = (value: string | null | undefined) => {
    if (value && isCorePwaResourceUrl(value, window.location.origin)) {
      const url = new URL(value, window.location.origin)
      url.search = ''
      url.hash = ''
      urls.add(url.toString())
    }
  }

  for (const element of document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[rel="stylesheet"][href]')) {
    add(element instanceof HTMLScriptElement ? element.src : element.href)
  }
  for (const entry of performance.getEntriesByType('resource')) add(entry.name)
  return [...urls]
}

function snapshotCorePwaEntrypoints(): string[] {
  if (typeof window === 'undefined' || typeof document === 'undefined') return []
  const urls = new Set<string>()
  for (const element of document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[rel="stylesheet"][href]')) {
    const value = element instanceof HTMLScriptElement ? element.src : element.href
    if (!isCorePwaResourceUrl(value, window.location.origin)) continue
    const url = new URL(value, window.location.origin)
    url.search = ''
    url.hash = ''
    urls.add(url.toString())
  }
  return [...urls]
}

const initialCoreResources = snapshotCorePwaResources()
const initialCoreEntrypoints = snapshotCorePwaEntrypoints()

function setWaitingRegistration(registration: ServiceWorkerRegistration | null): void {
  waitingRegistration = registration
  publishUpdate()
}

function watchRegistration(registration: ServiceWorkerRegistration): void {
  if (registration.waiting && navigator.serviceWorker.controller) {
    setWaitingRegistration(registration)
  }

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing
    if (!installing) return
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        setWaitingRegistration(registration)
      }
    })
  })
}

function warmShell(registration: ServiceWorkerRegistration): void {
  const activeWorker = registration.active ?? navigator.serviceWorker.controller
  activeWorker?.postMessage({
    type: 'WARM_SHELL',
    urls: initialCoreResources,
    requiredUrls: initialCoreEntrypoints,
  })
}

export function registerPwa(): Promise<ServiceWorkerRegistration | null> {
  if (registrationPromise) return registrationPromise
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) {
    registrationPromise = Promise.resolve(null)
    return registrationPromise
  }

  registrationPromise = navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
    .then(async (registration) => {
      watchRegistration(registration)
      const readyRegistration = await navigator.serviceWorker.ready
      warmShell(readyRegistration)
      return registration
    })
    .catch((error: unknown) => {
      console.warn('[pwa] Service worker registration failed', error instanceof Error ? error.name : 'UnknownError')
      return null
    })
  return registrationPromise
}

export function subscribeToPwaUpdate(listener: PwaUpdateListener): () => void {
  updateListeners.add(listener)
  listener(waitingRegistration)
  return () => updateListeners.delete(listener)
}

export function activatePwaUpdate(): boolean {
  const waiting = waitingRegistration?.waiting
  if (!waiting) return false
  reloadForUpdate = true
  waiting.postMessage({ type: 'SKIP_WAITING' })
  return true
}

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Every tab that was already controlled reloads when a user activates the
    // waiting worker. This prevents sibling tabs from keeping old lazy chunks
    // after the newly activated worker removes the previous cache version.
    // A first-ever install does not reload a tab that had no controller.
    const shouldReload = shouldReloadForControllerChange(
      reloadForUpdate,
      hasEverBeenControlled,
      hasReloadedForUpdate,
    )
    // An initially uncontrolled tab becomes a sibling-controlled tab after
    // the first install claims it, so a later update must reload it too.
    hasEverBeenControlled = true
    if (!shouldReload) return
    hasReloadedForUpdate = true
    setWaitingRegistration(null)
    window.location.reload()
  })
}
