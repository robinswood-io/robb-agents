import type { RobbAppChannel } from './app-channel'

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
      reason:
        | 'unsupported-platform'
        | 'unsigned-development-build'
        | 'missing-provisioning-profile'
        | 'unsupported-electron'
        | 'configuration-failed'
      error?: unknown
    }

export function configurePlatformWebAuthn(
  appApi: WebAuthnAppApi,
  options: {
    platform: NodeJS.Platform
    channel: RobbAppChannel
    /**
     * Only provide this when the signed app embeds a provisioning profile that
     * authorizes the matching keychain-access-groups entitlement.
     */
    keychainAccessGroup?: string
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

  // keychain-access-groups is a restricted entitlement. A Developer ID
  // signature alone does not authorize it, and macOS kills such an app during
  // launch. Keep Touch ID disabled until the distribution build embeds a
  // matching Developer ID provisioning profile.
  if (!options.keychainAccessGroup) {
    return { enabled: false, reason: 'missing-provisioning-profile' }
  }

  if (typeof appApi.configureWebAuthn !== 'function') {
    return { enabled: false, reason: 'unsupported-electron' }
  }

  try {
    appApi.configureWebAuthn({
      touchID: {
        keychainAccessGroup: options.keychainAccessGroup,
      },
    })
    return {
      enabled: true,
      keychainAccessGroup: options.keychainAccessGroup,
    }
  } catch (error) {
    return { enabled: false, reason: 'configuration-failed', error }
  }
}
