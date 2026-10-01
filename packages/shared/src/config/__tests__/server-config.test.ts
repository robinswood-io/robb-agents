import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_SERVER_CONFIG,
  normalizeServerConfigPublicUrls,
  type ServerConfig,
} from '../server-config'

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { ...DEFAULT_SERVER_CONFIG, ...overrides }
}

describe('normalizeServerConfigPublicUrls', () => {
  it('keeps public reverse-proxy URLs optional', () => {
    expect(normalizeServerConfigPublicUrls(config())).toEqual(config())
    expect(normalizeServerConfigPublicUrls(config({
      publicWebuiUrl: '  ',
      publicWsUrl: '',
    }))).toEqual(config({
      publicWebuiUrl: undefined,
      publicWsUrl: undefined,
    }))
  })

  it('defaults manual tunnel setup to one-time pairing without an extra login', () => {
    const normalized = normalizeServerConfigPublicUrls({ enabled: true, port: 9100 })
    expect(normalized.tunnelProvider).toBe('manual')
    expect(normalized.remoteAuthMode).toBe('pairing-code')
  })

  it('preserves an explicit tunnel provider and authentication mode', () => {
    expect(normalizeServerConfigPublicUrls(config({
      tunnelProvider: 'ssh-reverse',
      remoteAuthMode: 'email-code',
    }))).toMatchObject({
      tunnelProvider: 'ssh-reverse',
      remoteAuthMode: 'email-code',
    })
  })

  it('normalizes a complete HTTPS and WSS pair without mutating its input', () => {
    const input = config({
      publicWebuiUrl: ' https://remote.example.com ',
      publicWsUrl: ' wss://remote.example.com/rpc ',
    })

    expect(normalizeServerConfigPublicUrls(input)).toEqual(config({
      publicWebuiUrl: 'https://remote.example.com/',
      publicWsUrl: 'wss://remote.example.com/rpc',
    }))
    expect(input.publicWebuiUrl).toBe(' https://remote.example.com ')
  })

  it('requires the public URLs to be configured together', () => {
    expect(() => normalizeServerConfigPublicUrls(config({
      publicWebuiUrl: 'https://remote.example.com',
    }))).toThrow('configured together')
    expect(() => normalizeServerConfigPublicUrls(config({
      publicWsUrl: 'wss://remote.example.com/rpc',
    }))).toThrow('configured together')
  })

  it('requires the host-only session cookie and WebSocket endpoint to share a hostname', () => {
    expect(() => normalizeServerConfigPublicUrls(config({
      publicWebuiUrl: 'https://remote.example.com',
      publicWsUrl: 'wss://rpc.example.com/rpc',
    }))).toThrow('same hostname')

    expect(normalizeServerConfigPublicUrls(config({
      publicWebuiUrl: 'https://remote.example.com:8443',
      publicWsUrl: 'wss://remote.example.com:9443/rpc',
    }))).toMatchObject({
      publicWebuiUrl: 'https://remote.example.com:8443/',
      publicWsUrl: 'wss://remote.example.com:9443/rpc',
    })
  })

  it('fails closed on plaintext protocols', () => {
    expect(() => normalizeServerConfigPublicUrls(config({
      publicWebuiUrl: 'http://remote.example.com',
      publicWsUrl: 'wss://remote.example.com/rpc',
    }))).toThrow('must use HTTPS')
    expect(() => normalizeServerConfigPublicUrls(config({
      publicWebuiUrl: 'https://remote.example.com',
      publicWsUrl: 'ws://remote.example.com/rpc',
    }))).toThrow('must use WSS')
  })

  it('rejects a Web UI base path that the pairing route cannot preserve', () => {
    expect(() => normalizeServerConfigPublicUrls(config({
      publicWebuiUrl: 'https://remote.example.com/robb',
      publicWsUrl: 'wss://remote.example.com/rpc',
    }))).toThrow('must not contain a path')
  })

  it.each([
    ['credentials', 'https://owner:secret@remote.example.com', 'wss://remote.example.com/rpc'],
    ['Web UI query', 'https://remote.example.com?token=secret', 'wss://remote.example.com/rpc'],
    ['Web UI fragment', 'https://remote.example.com#token=secret', 'wss://remote.example.com/rpc'],
    ['WebSocket query', 'https://remote.example.com', 'wss://remote.example.com/rpc?token=secret'],
    ['WebSocket fragment', 'https://remote.example.com', 'wss://remote.example.com/rpc#token=secret'],
  ])('rejects %s so credentials cannot leak into public URLs', (_name, publicWebuiUrl, publicWsUrl) => {
    expect(() => normalizeServerConfigPublicUrls(config({
      publicWebuiUrl,
      publicWsUrl,
    }))).toThrow()
  })
})
