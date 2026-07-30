import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWebuiHttpServer } from '../http-server'
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

  it('infers secure cookies from proxy https headers when no override is set', async () => {
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
    expect(res.headers.get('set-cookie')).toContain('Secure')
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
    const { baseUrl } = await createServer({
      publicWebuiUrl: 'https://remote.example.com',
      hostLabel: 'Studio Mac',
      wsProtocol: 'wss',
      wsPort: 9100,
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
    expect(pairing.pairingUrl.startsWith('https://remote.example.com/remote?pairing=')).toBe(true)
    expect(pairing.pairingUrl).not.toContain(SECRET)
    expect(pairing.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(pairing.hostLabel).toBe('Studio Mac')

    const pairingTicket = new URL(pairing.pairingUrl).searchParams.get('pairing')
    expect(pairingTicket).toBeTruthy()
    const paired = await fetch(`${baseUrl}/api/remote/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: pairingTicket, deviceName: 'Test Phone' }),
    })
    expect(paired.status).toBe(200)
    expect(paired.headers.get('set-cookie')).toContain('Max-Age=2592000')
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
    expect(config.session.deviceId).toBeTruthy()

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
})
