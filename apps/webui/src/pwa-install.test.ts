import { afterEach, describe, expect, it } from 'bun:test'
import { isAppleMobileDevice } from './pwa-install'

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function setNavigator(userAgent: string, maxTouchPoints = 0): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent, maxTouchPoints },
  })
}

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else delete (globalThis as Record<string, unknown>).navigator
})

describe('isAppleMobileDevice', () => {
  it('recognizes classic iPhone and iPad user agents', () => {
    setNavigator('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')
    expect(isAppleMobileDevice()).toBe(true)

    setNavigator('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')
    expect(isAppleMobileDevice()).toBe(true)
  })

  it('recognizes iPadOS desktop-mode user agents by touch capability', () => {
    setNavigator('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)
    expect(isAppleMobileDevice()).toBe(true)
  })

  it('does not classify a Mac or another touch device as Apple mobile', () => {
    setNavigator('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6)', 0)
    expect(isAppleMobileDevice()).toBe(false)

    setNavigator('Mozilla/5.0 (Linux; Android 15)', 5)
    expect(isAppleMobileDevice()).toBe(false)
  })
})
