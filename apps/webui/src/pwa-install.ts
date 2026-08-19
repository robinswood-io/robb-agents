export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type InstallPromptListener = (prompt: BeforeInstallPromptEvent | null) => void

let installPrompt: BeforeInstallPromptEvent | null = null
const listeners = new Set<InstallPromptListener>()

function publish(): void {
  for (const listener of listeners) listener(installPrompt)
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    installPrompt = event as BeforeInstallPromptEvent
    publish()
  })

  window.addEventListener('appinstalled', () => {
    installPrompt = null
    publish()
  })
}

export function getInstallPrompt(): BeforeInstallPromptEvent | null {
  return installPrompt
}

export function subscribeToInstallPrompt(listener: InstallPromptListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function clearInstallPrompt(): void {
  installPrompt = null
  publish()
}

export function isRunningAsInstalledApp(): boolean {
  if (typeof window === 'undefined') return false
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean }
  return window.matchMedia('(display-mode: standalone)').matches || standaloneNavigator.standalone === true
}

export function isAppleMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iPhone|iPad|iPod/i.test(navigator.userAgent)
}
