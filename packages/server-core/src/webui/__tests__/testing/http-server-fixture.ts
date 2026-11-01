import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebuiHttpServer } from "../../http-server";
import type { Logger } from "../../../runtime/platform";
import type { RemoteAuthMode } from "@craft-agent/shared/config/server-config";



export const SECRET = 'test-server-secret'

export const PASSWORD = 'test-password'

export const TEMP_DIRS: string[] = []

export const SERVERS: Array<{ stop: () => void }> = []


export const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} satisfies Logger


export function createTestWebuiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-webui-test-'))
  TEMP_DIRS.push(dir)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'login.html'), '<!doctype html><html><body>login</body></html>')
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>')
  writeFileSync(join(dir, 'offline.html'), '<!doctype html><html><body>offline</body></html>')
  writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("fetch", () => {})')
  writeFileSync(join(dir, 'manifest.json'), '{"name":"Robb Agents"}')
  writeFileSync(join(dir, 'favicon.ico'), 'ico')
  writeFileSync(join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(join(dir, 'apple-touch-icon.png'), 'png')
  writeFileSync(join(dir, 'icon-192.png'), 'png')
  writeFileSync(join(dir, 'icon-512.png'), 'png')
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log("app")')
  writeFileSync(join(dir, 'assets', 'app-abc123.js.map'), '{"version":3}')
  return dir
}


export async function createServer(overrides?: {
  secureCookies?: boolean
  publicWsUrl?: string
  publicWebuiUrl?: string
  hostLabel?: string
  wsProtocol?: 'ws' | 'wss'
  wsPort?: number
  onRemoteDeviceRevoked?: (deviceId: string) => void
  allowInsecureSessions?: boolean
  remoteAuthMode?: RemoteAuthMode
}) {
  const server = await startWebuiHttpServer({
    port: 0,
    webuiDir: createTestWebuiDir(),
    secret: SECRET,
    password: PASSWORD,
    secureCookies: overrides?.secureCookies,
    publicWsUrl: overrides?.publicWsUrl,
    publicWebuiUrl: overrides?.publicWebuiUrl,
    remoteAuthMode: overrides?.remoteAuthMode,
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


export function extractSessionCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie')
  expect(setCookie).toBeTruthy()
  return setCookie!.split(';')[0]!
}
