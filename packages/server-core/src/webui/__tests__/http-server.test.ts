import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebuiHandler, startWebuiHttpServer } from '../http-server'
import type { Logger } from '../../runtime/platform'

const SECRET = 'test-server-secret'
const PASSWORD = 'test-password'
const TEMP_DIRS: string[] = []
const SERVERS: Array<{ stop: () => void }> = []

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} satisfies Logger

function createTestWebuiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-webui-test-'))
  TEMP_DIRS.push(dir)
  writeFileSync(join(dir, 'login.html'), '<!doctype html><html><body>login</body></html>')
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>')
  return dir
}

async function createServer(overrides?: {
  secureCookies?: boolean
  publicWsUrl?: string
  publicWebuiUrl?: string
  hostLabel?: string
  wsProtocol?: 'ws' | 'wss'
  wsPort?: number
  onRemoteDeviceRevoked?: (deviceId: string) => void
  allowInsecureSessions?: boolean
}) {
  const server = await startWebuiHttpServer({
    port: 0,
    webuiDir: createTestWebuiDir(),
    secret: SECRET,
    password: PASSWORD,
    secureCookies: overrides?.secureCookies,
    publicWsUrl: overrides?.publicWsUrl,
    publicWebuiUrl: overrides?.publicWebuiUrl,
    hostLabel: overrides?.hostLabel,
    wsProtocol: overrides?.wsProtocol ?? 'wss',
    wsPort: overrides?.wsPort ?? 9100,
    getHealthCheck: () => ({ status: 'ok' }),
    logger,
    getRemoteWorkspaceIds: () => ['workspace-1'],
    onRemoteDeviceRevoked: overrides?.onRemoteDeviceRevoked,
    allowInsecureSessions: overrides?.allowInsecureSessions ?? true,
  })

  SERVERS.push(server)

  return {
    server,
    baseUrl: `http://127.0.0.1:${server.port}`,
  }
}

function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie')
  expect(setCookie).toBeTruthy()
  return setCookie!.split(';')[0]!
}

afterEach(() => {
  while (SERVERS.length > 0) {
    SERVERS.pop()?.stop()
  }

  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('startWebuiHttpServer', () => {
  it('lets the trusted desktop owner issue and revoke a device-scoped pairing', async () => {
    const revoked: string[] = []
    const handler = createWebuiHandler({
      webuiDir: createTestWebuiDir(),
      secret: SECRET,
      wsProtocol: 'ws',
      wsPort: 9100,
      getHealthCheck: () => ({ status: 'ok' }),
      logger,
      getRemoteWorkspaceIds: () => ['workspace-1', 'workspace-2'],
      onRemoteDeviceRevoked: (deviceId) => revoked.push(deviceId),
      allowInsecureSessions: true,
    })
    SERVERS.push({ stop: handler.dispose })

    const pairing = handler.createRemotePairing('http://192.168.1.20:9100', 'Studio Mac')
    expect(pairing.pairingUrl.startsWith('http://192.168.1.20:9100/remote#pairing=')).toBe(true)
    expect(pairing.pairingUrl).not.toContain(SECRET)
    expect(pairing.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)

    const pairingUrl = new URL(pairing.pairingUrl)
    const ticket = new URLSearchParams(pairingUrl.hash.slice(1)).get('pairing')
    expect(pairingUrl.search).toBe('')
    const paired = await handler.fetch(new Request('http://192.168.1.20:9100/api/remote/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket, deviceName: 'iPhone' }),
    }))
    expect(paired.status).toBe(200)
    const device = (await paired.json()) as { deviceId: string }
    expect(handler.listRemoteDevices()[0]?.allowedWorkspaceIds).toEqual(['workspace-1', 'workspace-2'])
    expect(handler.revokeRemoteDevice(device.deviceId)).toBe(true)
    expect(revoked).toEqual([device.deviceId])
  })

  it('allows plain-http login even when the RPC transport is wss', async () => {
    const { baseUrl } = await createServer({ wsProtocol: 'wss', wsPort: 9100 })

    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })

    expect(authRes.status).toBe(200)
    const setCookie = authRes.headers.get('set-cookie')
    expect(setCookie).toContain('craft_session=')
    expect(setCookie).not.toContain('Secure')

    const configRes = await fetch(`${baseUrl}/api/config`, {
      headers: {
        cookie: extractSessionCookie(authRes),
      },
    })

    expect(configRes.status).toBe(200)
    const config = await configRes.json() as {
      wsUrl: string
      hostLabel: string
      session: { kind: string; deviceId: string | null }
    }
    expect(config.wsUrl).toBe('wss://127.0.0.1:9100')
    expect(config.hostLabel).toBe('127.0.0.1')
    expect(config.session).toMatchObject({ kind: 'owner', deviceId: null })
  })

  it('rejects invalid credentials', async () => {
    const { baseUrl } = await createServer()

    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' }),
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid credentials' })
  })

  it('rejects non-JSON and oversized authentication bodies', async () => {
    const { baseUrl } = await createServer()

    const wrongType = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(wrongType.status).toBe(415)

    const oversized = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'x'.repeat(17 * 1024) }),
    })
    expect(oversized.status).toBe(413)
  })

  it('honors an explicit secure-cookie override', async () => {
    const { baseUrl } = await createServer({ secureCookies: true, wsProtocol: 'ws', wsPort: 9100 })

    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('does not trust a spoofed proxy header for the Secure cookie attribute', async () => {
    const { baseUrl } = await createServer({ wsProtocol: 'wss', wsPort: 9100 })

    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ password: PASSWORD }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).not.toContain('Secure')
  })

  it('derives a browser-facing websocket URL from forwarded public host headers', async () => {
    const { baseUrl } = await createServer({ wsProtocol: 'wss', wsPort: 9100 })

    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'craft.example.com:3100',
      },
      body: JSON.stringify({ password: PASSWORD }),
    })

    const configRes = await fetch(`${baseUrl}/api/config`, {
      headers: {
        cookie: extractSessionCookie(authRes),
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'craft.example.com:3100',
      },
    })

    expect(configRes.status).toBe(200)
    const config = await configRes.json() as { wsUrl: string; hostLabel: string }
    expect(config.wsUrl).toBe('wss://craft.example.com:9100')
    expect(config.hostLabel).toBe('craft.example.com')
  })

  it('returns an explicit public websocket URL override from /api/config', async () => {
    const { baseUrl } = await createServer({
      publicWsUrl: 'wss://craft.example.com/ws',
      wsProtocol: 'wss',
      wsPort: 9100,
    })

    const authRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })

    const configRes = await fetch(`${baseUrl}/api/config`, {
      headers: {
        cookie: extractSessionCookie(authRes),
      },
    })

    expect(configRes.status).toBe(200)
    const config = await configRes.json() as { wsUrl: string }
    expect(config.wsUrl).toBe('wss://craft.example.com/ws')
  })

  it('pairs a mobile device with a one-time ticket and returns a device session', async () => {
    const revokedDevices: string[] = []
    const { baseUrl } = await createServer({
      publicWebuiUrl: 'https://remote.example.com',
      hostLabel: 'Studio Mac',
      wsProtocol: 'wss',
      wsPort: 9100,
      onRemoteDeviceRevoked: (deviceId) => revokedDevices.push(deviceId),
    })
    const login = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    const ownerCookie = extractSessionCookie(login)

    const createPairing = await fetch(`${baseUrl}/api/remote/pairing`, {
      method: 'POST',
      headers: { cookie: ownerCookie },
    })
    expect(createPairing.status).toBe(200)
    const pairing = await createPairing.json() as {
      pairingUrl: string
      code: string
      expiresAt: string
      hostLabel: string
    }
    expect(pairing.pairingUrl.startsWith('https://remote.example.com/remote#pairing=')).toBe(true)
    expect(pairing.pairingUrl).not.toContain(SECRET)
    expect(pairing.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(pairing.hostLabel).toBe('Studio Mac')

    const pairingTicket = new URLSearchParams(new URL(pairing.pairingUrl).hash.slice(1)).get('pairing')
    expect(pairingTicket).toBeTruthy()
    const paired = await fetch(`${baseUrl}/api/remote/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: pairingTicket, deviceName: 'Test Phone' }),
    })
    expect(paired.status).toBe(200)
    expect(paired.headers.get('set-cookie')).toContain('Max-Age=604800')
    const remoteCookie = extractSessionCookie(paired)

    const configRes = await fetch(`${baseUrl}/api/config`, {
      headers: { cookie: remoteCookie },
    })
    const config = await configRes.json() as {
      hostLabel: string
      session: { kind: string; deviceId: string | null }
    }
    expect(config.hostLabel).toBe('Studio Mac')
    expect(config.session.kind).toBe('remote-device')
    const remoteDeviceId = config.session.deviceId
    expect(remoteDeviceId).toBeTruthy()
    if (!remoteDeviceId) throw new Error('Pairing response did not include a Remote device ID')

    const devicesRes = await fetch(`${baseUrl}/api/remote/devices`, {
      headers: { cookie: ownerCookie },
    })
    expect(devicesRes.status).toBe(200)
    const devices = await devicesRes.json() as {
      devices: Array<{ id: string; allowedWorkspaceIds: string[] }>
    }
    expect(devices.devices).toHaveLength(1)
    expect(devices.devices[0]?.allowedWorkspaceIds).toEqual(['workspace-1'])

    const remoteCannotPair = await fetch(`${baseUrl}/api/remote/pairing`, {
      method: 'POST',
      headers: { cookie: remoteCookie },
    })
    expect(remoteCannotPair.status).toBe(403)

    const replay = await fetch(`${baseUrl}/api/remote/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: pairingTicket }),
    })
    expect(replay.status).toBe(409)

    const revoke = await fetch(`${baseUrl}/api/remote/devices/${remoteDeviceId}`, {
      method: 'DELETE',
      headers: { cookie: ownerCookie },
    })
    expect(revoke.status).toBe(200)
    expect(revokedDevices).toEqual([remoteDeviceId])
    expect((await fetch(`${baseUrl}/api/config`, { headers: { cookie: remoteCookie } })).status).toBe(401)
  })

  it('supports a manual pairing code and serves the mobile route without authentication', async () => {
    const { baseUrl } = await createServer()
    const remotePage = await fetch(`${baseUrl}/remote`)
    expect(remotePage.status).toBe(200)
    expect(await remotePage.text()).toContain('<body>app</body>')

    const login = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    const createPairing = await fetch(`${baseUrl}/api/remote/pairing`, {
      method: 'POST',
      headers: { cookie: extractSessionCookie(login) },
    })
    const pairing = await createPairing.json() as { code: string }
    const paired = await fetch(`${baseUrl}/api/remote/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pairing.code.toLowerCase() }),
    })
    expect(paired.status).toBe(200)
  })

  it('fails closed for session APIs and pairing links without HTTPS', async () => {
    const handler = createWebuiHandler({
      webuiDir: createTestWebuiDir(),
      secret: SECRET,
      wsProtocol: 'ws',
      wsPort: 9100,
      getHealthCheck: () => ({ status: 'ok' }),
      logger,
      getRemoteWorkspaceIds: () => ['workspace-1'],
    })
    SERVERS.push({ stop: handler.dispose })

    expect(() => handler.createRemotePairing('http://192.168.1.20:9100'))
      .toThrow('HTTPS and WSS are required')

    const response = await handler.fetch(new Request('http://192.168.1.20:9100/api/auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ password: PASSWORD }),
    }))
    expect(response.status).toBe(426)
    expect(response.headers.get('upgrade')).toBe('TLS/1.2')
  })

  it('accepts an explicit HTTPS proxy only with Secure cookies and keeps tickets out of the query', async () => {
    const handler = createWebuiHandler({
      webuiDir: createTestWebuiDir(),
      secret: SECRET,
      password: PASSWORD,
      secureCookies: true,
      publicWebuiUrl: 'https://remote.example.com',
      publicWsUrl: 'wss://remote.example.com',
      wsProtocol: 'ws',
      wsPort: 9100,
      getHealthCheck: () => ({ status: 'ok' }),
      logger,
      getRemoteWorkspaceIds: () => ['workspace-1'],
    })
    SERVERS.push({ stop: handler.dispose })

    const login = await handler.fetch(new Request('http://127.0.0.1:9100/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    }))
    expect(login.status).toBe(200)
    expect(login.headers.get('set-cookie')).toContain('Secure')

    const pairing = handler.createRemotePairing('https://remote.example.com', 'Studio Mac')
    const pairingUrl = new URL(pairing.pairingUrl)
    expect(pairingUrl.search).toBe('')
    const ticket = new URLSearchParams(pairingUrl.hash.slice(1)).get('pairing')
    expect(ticket).toBeTruthy()

    const paired = await handler.fetch(new Request('http://127.0.0.1:9100/api/remote/pair', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://remote.example.com',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: JSON.stringify({ ticket, deviceName: 'Test phone' }),
    }))
    expect(paired.status).toBe(200)
    const deviceCookie = paired.headers.get('set-cookie') ?? ''
    expect(deviceCookie).toContain('HttpOnly')
    expect(deviceCookie).toContain('SameSite=Strict')
    expect(deviceCookie).toContain('Secure')
    expect(deviceCookie).toContain('Path=/')
  })

  it('rejects cross-origin state-changing requests and adds browser hardening headers', async () => {
    const { baseUrl } = await createServer({
      publicWebuiUrl: 'https://remote.example.com',
      secureCookies: true,
      allowInsecureSessions: false,
    })

    const response = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ password: PASSWORD }),
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })
})
