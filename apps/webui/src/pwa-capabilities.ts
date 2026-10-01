export type CapabilitySupport = 'available' | 'partial' | 'unavailable'

export interface PwaCapabilities {
  secureContext: boolean
  webAuthn: {
    api: boolean
    platformAuthenticator: boolean | null
  }
  fileSystemAccess: {
    openFile: boolean
    saveFile: boolean
    directory: boolean
    support: CapabilitySupport
  }
  badging: {
    api: boolean
  }
  webGpu: {
    api: boolean
  }
  webAssembly: {
    api: boolean
    memory64: boolean
    threads: boolean
  }
}

type WebAuthnPublicKeyCredential = typeof PublicKeyCredential & {
  isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>
}

type FileSystemWindow = Window & {
  showOpenFilePicker?: unknown
  showSaveFilePicker?: unknown
  showDirectoryPicker?: unknown
}

type BadgeNavigator = Navigator & {
  setAppBadge?: unknown
  clearAppBadge?: unknown
}

function getWindow(): FileSystemWindow | null {
  return typeof window === 'undefined' ? null : window as FileSystemWindow
}

function getNavigator(): BadgeNavigator | null {
  return typeof navigator === 'undefined' ? null : navigator as BadgeNavigator
}

function supportsWebAssemblyMemory64(): boolean {
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.Memory !== 'function') return false
  try {
    const Memory = WebAssembly.Memory as unknown as new (descriptor: Record<string, unknown>) => WebAssembly.Memory
    new Memory({ initial: 1, maximum: 1, index: 'i64' })
    return true
  } catch {
    return false
  }
}

function classifyFileSystemAccess(input: {
  openFile: boolean
  saveFile: boolean
  directory: boolean
}): CapabilitySupport {
  if (input.openFile && input.saveFile && input.directory) return 'available'
  if (input.openFile || input.saveFile || input.directory) return 'partial'
  return 'unavailable'
}

async function detectPlatformAuthenticator(): Promise<boolean | null> {
  if (typeof PublicKeyCredential === 'undefined') return null
  const credential = PublicKeyCredential as WebAuthnPublicKeyCredential
  if (typeof credential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return null
  try {
    return await credential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return null
  }
}

export async function detectPwaCapabilities(): Promise<PwaCapabilities> {
  const runtimeWindow = getWindow()
  const runtimeNavigator = getNavigator()
  const secureContext = runtimeWindow?.isSecureContext ?? false
  const openFile = typeof runtimeWindow?.showOpenFilePicker === 'function'
  const saveFile = typeof runtimeWindow?.showSaveFilePicker === 'function'
  const directory = typeof runtimeWindow?.showDirectoryPicker === 'function'

  return {
    secureContext,
    webAuthn: {
      api: secureContext
        && typeof runtimeNavigator?.credentials === 'object'
        && typeof PublicKeyCredential !== 'undefined',
      platformAuthenticator: secureContext ? await detectPlatformAuthenticator() : null,
    },
    fileSystemAccess: {
      openFile,
      saveFile,
      directory,
      support: classifyFileSystemAccess({ openFile, saveFile, directory }),
    },
    badging: {
      api: typeof runtimeNavigator?.setAppBadge === 'function'
        && typeof runtimeNavigator.clearAppBadge === 'function',
    },
    webGpu: {
      api: secureContext && Boolean((runtimeNavigator as Navigator & { gpu?: unknown } | null)?.gpu),
    },
    webAssembly: {
      api: typeof WebAssembly === 'object',
      memory64: supportsWebAssemblyMemory64(),
      threads: typeof SharedArrayBuffer !== 'undefined'
        && Boolean((globalThis as typeof globalThis & { crossOriginIsolated?: boolean }).crossOriginIsolated),
    },
  }
}
