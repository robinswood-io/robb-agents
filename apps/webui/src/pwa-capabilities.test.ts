import { afterEach, describe, expect, it, mock } from 'bun:test'
import { detectPwaCapabilities } from './pwa-capabilities'

const originals = new Map<string, PropertyDescriptor | undefined>()

function replaceGlobal(name: string, value: unknown): void {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  })
}

afterEach(() => {
  for (const [name, descriptor] of [...originals].reverse()) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete (globalThis as Record<string, unknown>)[name]
  }
  originals.clear()
})

describe('PWA capability detection', () => {
  it('reports unavailable capabilities outside a secure browser context', async () => {
    replaceGlobal('window', { isSecureContext: false })
    replaceGlobal('navigator', {})
    replaceGlobal('PublicKeyCredential', undefined)
    replaceGlobal('SharedArrayBuffer', undefined)
    replaceGlobal('crossOriginIsolated', false)

    const snapshot = await detectPwaCapabilities()

    expect(snapshot.secureContext).toBe(false)
    expect(snapshot.webAuthn.api).toBe(false)
    expect(snapshot.fileSystemAccess.support).toBe('unavailable')
    expect(snapshot.badging.api).toBe(false)
    expect(snapshot.webGpu.api).toBe(false)
    expect(snapshot.webAssembly.api).toBe(true)
    expect(snapshot.webAssembly.threads).toBe(false)
  })

  it('classifies passkeys, File System Access, Badging, WebGPU, and WASM runtime support', async () => {
    class Memory64 {
      constructor(descriptor: Record<string, unknown>) {
        if (descriptor.index !== 'i64') throw new Error('expected memory64 probe')
      }
    }
    replaceGlobal('window', {
      isSecureContext: true,
      showOpenFilePicker: mock(),
      showSaveFilePicker: mock(),
      showDirectoryPicker: mock(),
    })
    replaceGlobal('navigator', {
      credentials: {},
      setAppBadge: mock(),
      clearAppBadge: mock(),
      gpu: {},
    })
    replaceGlobal('PublicKeyCredential', {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
    })
    replaceGlobal('WebAssembly', {
      Memory: Memory64,
    })
    replaceGlobal('SharedArrayBuffer', class SharedArrayBufferMock {})
    replaceGlobal('crossOriginIsolated', true)

    const snapshot = await detectPwaCapabilities()

    expect(snapshot.secureContext).toBe(true)
    expect(snapshot.webAuthn).toEqual({ api: true, platformAuthenticator: true })
    expect(snapshot.fileSystemAccess).toEqual({
      openFile: true,
      saveFile: true,
      directory: true,
      support: 'available',
    })
    expect(snapshot.badging.api).toBe(true)
    expect(snapshot.webGpu.api).toBe(true)
    expect(snapshot.webAssembly).toEqual({
      api: true,
      memory64: true,
      threads: true,
    })
  })
})
