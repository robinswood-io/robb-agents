import { PRODUCTION_APP_ID, type RobbAppChannel } from './app-channel'

// Public identifier from the Developer ID signature used for official Robb Agents builds.
export const ROBINSWOOD_APPLE_TEAM_ID = '4FWLQ2KVUY'
export const PRODUCTION_WEBAUTHN_KEYCHAIN_ACCESS_GROUP =
  `${ROBINSWOOD_APPLE_TEAM_ID}.${PRODUCTION_APP_ID}.webauthn`

interface WebAuthnAppApi {
  configureWebAuthn?: (options: {
    touchID: {
      keychainAccessGroup: string
    }
  }) => void
}

export type PlatformWebAuthnConfiguration =
  | { enabled: true; keychainAccessGroup: string }
  | {
      enabled: false
      reason: 'unsupported-platform' | 'unsigned-development-build' | 'unsupported-electron' | 'configuration-failed'
      error?: unknown
    }

export function configurePlatformWebAuthn(
  appApi: WebAuthnAppApi,
  options: {
    platform: NodeJS.Platform
    channel: RobbAppChannel
  },
): PlatformWebAuthnConfiguration {
  if (options.platform !== 'darwin') {
    return { enabled: false, reason: 'unsupported-platform' }
  }

  // The keychain access group is present only in the official production
  // entitlement. Unsigned development builds cannot access it.
  if (options.channel !== 'production') {
    return { enabled: false, reason: 'unsigned-development-build' }
  }

  if (typeof appApi.configureWebAuthn !== 'function') {
    return { enabled: false, reason: 'unsupported-electron' }
  }

  try {
    appApi.configureWebAuthn({
      touchID: {
        keychainAccessGroup: PRODUCTION_WEBAUTHN_KEYCHAIN_ACCESS_GROUP,
      },
    })
    return {
      enabled: true,
      keychainAccessGroup: PRODUCTION_WEBAUTHN_KEYCHAIN_ACCESS_GROUP,
    }
  } catch (error) {
    return { enabled: false, reason: 'configuration-failed', error }
  }
}
