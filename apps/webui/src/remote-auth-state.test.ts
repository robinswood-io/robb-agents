import { describe, expect, test } from 'bun:test'
import type { TransportConnectionState } from '../../electron/src/transport/client'
import { isTerminalRemoteAuthState } from './remote-auth-state'

function state(
  overrides: Partial<TransportConnectionState>,
): Pick<TransportConnectionState, 'mode' | 'lastError' | 'lastClose'> {
  return {
    mode: 'remote',
    lastError: undefined,
    lastClose: undefined,
    ...overrides,
  }
}

describe('Remote terminal authentication state', () => {
  test('recognizes an authentication failure during the handshake', () => {
    expect(isTerminalRemoteAuthState(state({
      lastError: { kind: 'auth', message: 'redacted test detail' },
    }))).toBe(true)
  })

  test('recognizes a paired-device revocation after connection', () => {
    expect(isTerminalRemoteAuthState(state({
      lastClose: { code: 4005, reason: 'revoked', wasClean: true },
    }))).toBe(true)
  })

  test('does not erase data for protocol errors or local-mode failures', () => {
    expect(isTerminalRemoteAuthState(state({
      lastClose: { code: 4004, reason: 'protocol', wasClean: true },
    }))).toBe(false)
    expect(isTerminalRemoteAuthState(state({
      mode: 'local',
      lastError: { kind: 'auth', message: 'local failure' },
    }))).toBe(false)
  })
})
