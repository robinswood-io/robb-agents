import { describe, expect, it } from 'bun:test'
import {
  remoteServerNeedsRestart,
  resolveAllowedSessionCookieOrigins,
  resolveRemoteServerUrls,
  resolveSecureRemoteHost,
  type RunningRemoteServerState,
} from '../remote-access-security'

const RUNNING_SERVER: RunningRemoteServerState = {
  enabled: true,
  host: '127.0.0.1',
  port: 9100,
  tls: false,
  token: 'server-token',
  publicWebuiUrl: 'https://remote.example.com/',
  publicWsUrl: 'wss://remote.example.com/rpc',
  tunnelProvider: 'ssh-reverse',
  remoteAuthMode: 'pairing-code',
}

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

describe('resolveRemoteServerUrls', () => {
  it('publishes explicit reverse-proxy URLs instead of the loopback bind', () => {
    expect(resolveRemoteServerUrls(RUNNING_SERVER, '127.0.0.1', true)).toEqual({
      url: 'wss://remote.example.com/rpc',
      webUrl: 'https://remote.example.com/',
    })
  })

  it('falls back to direct runtime URLs and omits an unavailable WebUI', () => {
    const direct = { ...RUNNING_SERVER, tls: true, publicWebuiUrl: undefined, publicWsUrl: undefined }
    expect(resolveRemoteServerUrls(direct, '192.0.2.10', true)).toEqual({
      url: 'wss://192.0.2.10:9100',
      webUrl: 'https://192.0.2.10:9100',
    })
    expect(resolveRemoteServerUrls(direct, '192.0.2.10', false).webUrl).toBeUndefined()
  })
})

describe('remoteServerNeedsRestart', () => {
  const matchingSaved = {
    enabled: true,
    port: 9100,
    token: 'server-token',
    publicWebuiUrl: 'https://remote.example.com/',
    publicWsUrl: 'wss://remote.example.com/rpc',
    tunnelProvider: 'ssh-reverse',
    remoteAuthMode: 'pairing-code',
  }

  it('does not request a restart for the running public endpoints', () => {
    expect(remoteServerNeedsRestart(matchingSaved, RUNNING_SERVER)).toBe(false)
  })

  it('compares canonical public URLs after a manually written config is normalized at startup', () => {
    expect(remoteServerNeedsRestart({
      ...matchingSaved,
      publicWebuiUrl: ' https://remote.example.com ',
      publicWsUrl: ' wss://remote.example.com/rpc ',
    }, RUNNING_SERVER)).toBe(false)
  })

  it('requests a restart when either public endpoint changes', () => {
    expect(remoteServerNeedsRestart({
      ...matchingSaved,
      publicWebuiUrl: 'https://other.example.com/',
    }, RUNNING_SERVER)).toBe(true)
    expect(remoteServerNeedsRestart({
      ...matchingSaved,
      publicWsUrl: 'wss://other.example.com/rpc',
    }, RUNNING_SERVER)).toBe(true)
  })

  it('requests a restart when tunnel or authentication mode changes', () => {
    expect(remoteServerNeedsRestart({
      ...matchingSaved,
      tunnelProvider: 'cloudflare',
    }, RUNNING_SERVER)).toBe(true)
    expect(remoteServerNeedsRestart({
      ...matchingSaved,
      remoteAuthMode: 'server-token',
    }, RUNNING_SERVER)).toBe(true)
  })

  it('ignores dormant details while server mode stays disabled', () => {
    expect(remoteServerNeedsRestart({
      ...matchingSaved,
      enabled: false,
      publicWebuiUrl: 'https://other.example.com/',
    }, { ...RUNNING_SERVER, enabled: false })).toBe(false)
  })
})

describe('resolveAllowedSessionCookieOrigins', () => {
  it('allows the configured HTTPS proxy origin without leaking a path', () => {
    expect(resolveAllowedSessionCookieOrigins('https://remote.example.com/')).toEqual([
      'https://remote.example.com',
    ])
  })

  it('leaves direct transports on the server origin policy', () => {
    expect(resolveAllowedSessionCookieOrigins(undefined)).toBeUndefined()
  })
})
