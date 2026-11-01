import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { createWebuiHandler } from "../http-server";
import { PASSWORD, SECRET, SERVERS, TEMP_DIRS, createServer, createTestWebuiDir, logger } from "./testing/http-server-fixture.ts";

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
});
