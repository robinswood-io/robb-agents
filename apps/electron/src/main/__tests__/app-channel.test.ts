import { describe, expect, it } from 'bun:test'
import {
  DEVELOPMENT_APP_ID,
  DEVELOPMENT_APP_NAME,
  DEVELOPMENT_DEEPLINK_SCHEME,
  PRODUCTION_APP_ID,
  PRODUCTION_APP_NAME,
  PRODUCTION_DEEPLINK_SCHEME,
  canUseStableUpdater,
  getDefaultAppId,
  getDefaultAppName,
  getDefaultDeepLinkScheme,
  isStableReleaseVersion,
  resolveAppChannel,
} from '../app-channel'

describe('Robb application channels', () => {
  it('identifies source launches as development', () => {
    expect(resolveAppChannel(false, undefined)).toBe('development')
  })

  it('keeps packaged builds on production unless the dev build declares itself', () => {
    expect(resolveAppChannel(true, undefined)).toBe('production')
    expect(resolveAppChannel(true, 'development')).toBe('development')
  })

  it('assigns disjoint names, bundle identifiers and deep-link schemes', () => {
    expect(getDefaultAppName('production')).toBe(PRODUCTION_APP_NAME)
    expect(getDefaultAppName('development')).toBe(DEVELOPMENT_APP_NAME)
    expect(getDefaultAppId('production')).toBe(PRODUCTION_APP_ID)
    expect(getDefaultAppId('development')).toBe(DEVELOPMENT_APP_ID)
    expect(getDefaultDeepLinkScheme('production')).toBe(PRODUCTION_DEEPLINK_SCHEME)
    expect(getDefaultDeepLinkScheme('development')).toBe(DEVELOPMENT_DEEPLINK_SCHEME)

    expect(DEVELOPMENT_APP_NAME).not.toBe(PRODUCTION_APP_NAME)
    expect(DEVELOPMENT_APP_ID).not.toBe(PRODUCTION_APP_ID)
    expect(DEVELOPMENT_DEEPLINK_SCHEME).not.toBe(PRODUCTION_DEEPLINK_SCHEME)
  })

  it('enables the updater only in packaged production', () => {
    expect(canUseStableUpdater(true, 'production')).toBe(true)
    expect(canUseStableUpdater(false, 'production')).toBe(false)
    expect(canUseStableUpdater(true, 'development')).toBe(false)
    expect(canUseStableUpdater(false, 'development')).toBe(false)
  })

  it('accepts stable semantic versions and rejects prereleases', () => {
    expect(isStableReleaseVersion('1.2.3')).toBe(true)
    expect(isStableReleaseVersion('1.2.3-beta.1')).toBe(false)
    expect(isStableReleaseVersion('v1.2.3')).toBe(false)
  })
})
