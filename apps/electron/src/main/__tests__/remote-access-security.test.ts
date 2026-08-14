import { describe, expect, it } from 'bun:test'
import { resolveSecureRemoteHost } from '../remote-access-security'

describe('resolveSecureRemoteHost', () => {
  it('fails closed to loopback when TLS is unavailable', () => {
    expect(resolveSecureRemoteHost('0.0.0.0', false)).toEqual({
      host: '127.0.0.1',
      networkBindRejected: true,
    })
    expect(resolveSecureRemoteHost('::', false)).toEqual({
      host: '127.0.0.1',
      networkBindRejected: true,
    })
  })

  it('keeps loopback available for the local desktop app without TLS', () => {
    expect(resolveSecureRemoteHost('127.0.0.1', false)).toEqual({
      host: '127.0.0.1',
      networkBindRejected: false,
    })
  })

  it('allows the requested network bind only when TLS is available', () => {
    expect(resolveSecureRemoteHost('0.0.0.0', true)).toEqual({
      host: '0.0.0.0',
      networkBindRejected: false,
    })
  })
})
