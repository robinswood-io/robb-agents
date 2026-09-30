import { describe, expect, it, mock } from 'bun:test'
import { configurePlatformWebAuthn } from '../webauthn'

const PROVISIONED_KEYCHAIN_ACCESS_GROUP = 'TEAMID.io.robinswood.robbagents.webauthn'

describe('platform WebAuthn configuration', () => {
  it('configures the macOS Touch ID authenticator for production builds', () => {
    const configureWebAuthn = mock(() => {})

    const result = configurePlatformWebAuthn(
      { configureWebAuthn },
      {
        platform: 'darwin',
        channel: 'production',
        keychainAccessGroup: PROVISIONED_KEYCHAIN_ACCESS_GROUP,
      },
    )

    expect(result).toEqual({
      enabled: true,
      keychainAccessGroup: PROVISIONED_KEYCHAIN_ACCESS_GROUP,
    })
    expect(configureWebAuthn).toHaveBeenCalledWith({
      touchID: {
        keychainAccessGroup: PROVISIONED_KEYCHAIN_ACCESS_GROUP,
      },
    })
  })

  it('does not request a restricted entitlement without a provisioning profile', () => {
    const configureWebAuthn = mock(() => {})

    const result = configurePlatformWebAuthn(
      { configureWebAuthn },
      { platform: 'darwin', channel: 'production' },
    )

    expect(result).toEqual({ enabled: false, reason: 'missing-provisioning-profile' })
    expect(configureWebAuthn).not.toHaveBeenCalled()
  })

  it('does not configure a keychain group in unsigned development builds', () => {
    const configureWebAuthn = mock(() => {})

    const result = configurePlatformWebAuthn(
      { configureWebAuthn },
      { platform: 'darwin', channel: 'development' },
    )

    expect(result).toEqual({ enabled: false, reason: 'unsigned-development-build' })
    expect(configureWebAuthn).not.toHaveBeenCalled()
  })

  it('does not configure macOS WebAuthn on other platforms', () => {
    const configureWebAuthn = mock(() => {})

    const result = configurePlatformWebAuthn(
      { configureWebAuthn },
      { platform: 'win32', channel: 'production' },
    )

    expect(result).toEqual({ enabled: false, reason: 'unsupported-platform' })
    expect(configureWebAuthn).not.toHaveBeenCalled()
  })
})
