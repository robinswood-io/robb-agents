import { describe, expect, it } from 'bun:test'
import {
  REDACTED_LOG_VALUE,
  isSensitiveLogKey,
  resolveElectronLogTransportPolicy,
  safeSerializeLogValue,
} from '../log-sanitizer'

describe('Electron log transport policy', () => {
  it('keeps verbose file and console output in debug mode', () => {
    expect(resolveElectronLogTransportPolicy(true)).toEqual({
      fileLevel: 'silly',
      consoleLevel: 'debug',
    })
  })

  it('keeps only warning/error file output in production and disables the console', () => {
    expect(resolveElectronLogTransportPolicy(false)).toEqual({
      fileLevel: 'warn',
      consoleLevel: false,
    })
  })
})

describe('safeSerializeLogValue', () => {
  it('redacts sensitive keys and embedded credentials without hiding usage counters', () => {
    const apiKey = `sk-proj_${'a'.repeat(24)}`
    const bearerToken = 'b'.repeat(24)
    const refreshToken = 'refresh-secret-value'
    const value: Record<string, unknown> = {
      apiKey,
      authorization: `Bearer ${bearerToken}`,
      tokenUsage: {
        inputTokens: 12,
        outputTokens: 4,
        maxTokens: 1_024,
      },
      databaseUrl: 'postgres://alice:database-password@localhost/app',
      count: 9n,
    }
    const error = new Error(`request failed: Bearer ${bearerToken}`) as Error & {
      refreshToken?: string
    }
    error.refreshToken = refreshToken
    value.error = error
    value.self = value

    const serialized = safeSerializeLogValue(value)
    const parsed = JSON.parse(serialized) as Record<string, unknown> & {
      error: Record<string, unknown>
      tokenUsage: Record<string, number>
    }

    expect(serialized).not.toContain(apiKey)
    expect(serialized).not.toContain(bearerToken)
    expect(serialized).not.toContain(refreshToken)
    expect(serialized).not.toContain('database-password')
    expect(parsed.apiKey).toBe(REDACTED_LOG_VALUE)
    expect(parsed.authorization).toBe(REDACTED_LOG_VALUE)
    expect(parsed.error.refreshToken).toBe(REDACTED_LOG_VALUE)
    expect(parsed.tokenUsage).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      maxTokens: 1_024,
    })
    expect(parsed.count).toBe('9n')
    expect(parsed.self).toBe('[Circular]')
  })

  it('redacts structured OAuth artifacts and callback URL parameters', () => {
    const authorizationCode = 'authorization-code-value'
    const oauthState = 'oauth-state-value'
    const codeVerifier = 'oauth-code-verifier-value'
    const idToken = 'oauth-id-token-value'
    const clientInfo = 'oauth-client-identity-value'
    const sessionState = 'oauth-session-state-value'
    const serialized = safeSerializeLogValue({
      callbackUrl: `robb://auth-callback?code=${authorizationCode}&state=${oauthState}&client_info=${clientInfo}&session_state=${sessionState}&workspace=workspace-a`,
      authorizationCode,
      oauthState,
      codeVerifier,
      idToken,
      clientInfo,
      sessionState,
      state: 'ready',
      code: 'ERR_CONNECTION_RESET',
    })
    const parsed = JSON.parse(serialized) as Record<string, unknown>

    for (const secret of [authorizationCode, oauthState, codeVerifier, idToken, clientInfo, sessionState]) {
      expect(serialized).not.toContain(secret)
    }
    expect(parsed.authorizationCode).toBe(REDACTED_LOG_VALUE)
    expect(parsed.oauthState).toBe(REDACTED_LOG_VALUE)
    expect(parsed.codeVerifier).toBe(REDACTED_LOG_VALUE)
    expect(parsed.idToken).toBe(REDACTED_LOG_VALUE)
    expect(parsed.clientInfo).toBe(REDACTED_LOG_VALUE)
    expect(parsed.sessionState).toBe(REDACTED_LOG_VALUE)
    expect(parsed.state).toBe('ready')
    expect(parsed.code).toBe('ERR_CONNECTION_RESET')
    expect(parsed.callbackUrl).toContain('code=[REDACTED]')
    expect(parsed.callbackUrl).toContain('state=[REDACTED]')
    expect(parsed.callbackUrl).toContain('workspace=workspace-a')
  })

  it('does not invoke sensitive getters and survives throwing getters', () => {
    let passwordReads = 0
    const bearerToken = 'c'.repeat(24)
    const value: Record<string, unknown> = {}

    Object.defineProperty(value, 'password', {
      enumerable: true,
      get() {
        passwordReads += 1
        throw new Error('sensitive getter must not run')
      },
    })
    Object.defineProperty(value, 'details', {
      enumerable: true,
      get() {
        throw new Error(`Bearer ${bearerToken}`)
      },
    })

    const serialized = safeSerializeLogValue(value)
    const parsed = JSON.parse(serialized) as Record<string, unknown>

    expect(passwordReads).toBe(0)
    expect(parsed.password).toBe(REDACTED_LOG_VALUE)
    expect(parsed.details).toBe('[Thrown getter: [REDACTED]]')
    expect(serialized).not.toContain(bearerToken)
  })

  it('returns a diagnostic value instead of throwing for hostile objects', () => {
    const revocable = Proxy.revocable({}, {})
    revocable.revoke()

    expect(() => safeSerializeLogValue(revocable.proxy)).not.toThrow()
    expect(JSON.parse(safeSerializeLogValue(revocable.proxy))).toHaveProperty('serializationError')
  })
})

describe('isSensitiveLogKey', () => {
  it('distinguishes credentials from token accounting fields', () => {
    expect(isSensitiveLogKey('x-api-key')).toBe(true)
    expect(isSensitiveLogKey('refresh_token')).toBe(true)
    expect(isSensitiveLogKey('clientSecret')).toBe(true)
    expect(isSensitiveLogKey('authorizationCode')).toBe(true)
    expect(isSensitiveLogKey('oauthState')).toBe(true)
    expect(isSensitiveLogKey('codeVerifier')).toBe(true)
    expect(isSensitiveLogKey('idToken')).toBe(true)
    expect(isSensitiveLogKey('clientInfo')).toBe(true)
    expect(isSensitiveLogKey('sessionState')).toBe(true)
    expect(isSensitiveLogKey('relayState')).toBe(true)
    expect(isSensitiveLogKey('loginHint')).toBe(true)
    expect(isSensitiveLogKey('nonce')).toBe(true)
    expect(isSensitiveLogKey('tokenUsage')).toBe(false)
    expect(isSensitiveLogKey('state')).toBe(false)
    expect(isSensitiveLogKey('code')).toBe(false)
    expect(isSensitiveLogKey('inputTokens')).toBe(false)
    expect(isSensitiveLogKey('maxTokens')).toBe(false)
  })
})
