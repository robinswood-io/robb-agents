import { afterEach, describe, expect, it } from 'bun:test'
import {
  applyPwaBadge,
  computePwaBadgeValue,
  publishPwaBadgeState,
  supportsAppBadging,
} from './pwa-badging'

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value,
  })
}

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else delete (globalThis as Record<string, unknown>).navigator
})

describe('PWA app badging', () => {
  it('prioritizes actionable counts and falls back to an update flag', () => {
    expect(computePwaBadgeValue({ unreadCount: 0, offlineItemCount: 0, updateAvailable: false })).toBeNull()
    expect(computePwaBadgeValue({ unreadCount: 0, offlineItemCount: 0, updateAvailable: true })).toBe('flag')
    expect(computePwaBadgeValue({ unreadCount: 2, offlineItemCount: 3, updateAvailable: true })).toBe(5)
    expect(computePwaBadgeValue({ unreadCount: 80, offlineItemCount: 80, updateAvailable: false })).toBe(99)
  })

  it('detects App Badging API support', () => {
    setNavigator({})
    expect(supportsAppBadging()).toBe(false)

    setNavigator({
      setAppBadge: async () => {},
      clearAppBadge: async () => {},
    })
    expect(supportsAppBadging()).toBe(true)
  })

  it('applies badge numbers, flags, and clearing through the navigator API', async () => {
    const calls: Array<[string, number?]> = []
    setNavigator({
      setAppBadge: async (value?: number) => {
        calls.push(['set', value])
      },
      clearAppBadge: async () => {
        calls.push(['clear'])
      },
    })

    expect(await applyPwaBadge(7)).toBe(true)
    expect(await applyPwaBadge('flag')).toBe(true)
    expect(await applyPwaBadge(null)).toBe(true)
    expect(calls).toEqual([['set', 7], ['set', undefined], ['clear']])
  })

  it('publishes aggregate state incrementally', async () => {
    const calls: Array<number | undefined | 'clear'> = []
    setNavigator({
      setAppBadge: async (value?: number) => {
        calls.push(value)
      },
      clearAppBadge: async () => {
        calls.push('clear')
      },
    })

    await publishPwaBadgeState({ unreadCount: 4, offlineItemCount: 0, updateAvailable: false })
    await publishPwaBadgeState({ offlineItemCount: 2 })
    await publishPwaBadgeState({ unreadCount: 0, offlineItemCount: 0, updateAvailable: true })
    await publishPwaBadgeState({ updateAvailable: false })

    expect(calls).toEqual([4, 6, undefined, 'clear'])
  })
})
