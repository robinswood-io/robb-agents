import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { get, type RequestOptions } from 'node:https'
import { WsRpcServer } from '../server'

let directory: string
let ca: Buffer
let serverCert: Buffer
let serverKey: Buffer
let clientCert: Buffer
let clientKey: Buffer

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'robb-mtls-test-'))
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' })
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=Audit test CA')
  for (const name of ['server', 'client']) {
    openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=Audit ${name}`)
    writeFileSync(join(directory, `${name}.ext`), name === 'server'
      ? 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n'
      : 'extendedKeyUsage=clientAuth\n')
    openssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.pem`, '-days', '1', '-extfile', `${name}.ext`)
  }
  ca = readFileSync(join(directory, 'ca.pem'))
  serverCert = readFileSync(join(directory, 'server.pem'))
  serverKey = readFileSync(join(directory, 'server.key'))
  clientCert = readFileSync(join(directory, 'client.pem'))
  clientKey = readFileSync(join(directory, 'client.key'))
}, 15_000)
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })

function request(port: number, options: RequestOptions = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = get({ hostname: '127.0.0.1', port, ca, agent: false, ...options }, response => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(new Error('TLS test timeout')))
  })
}

async function withServer(requireClientCertificate: boolean, run: (port: number) => Promise<void>) {
  const server = new WsRpcServer({
    host: '127.0.0.1', port: 0,
    tls: { cert: serverCert, key: serverKey, ...(requireClientCertificate ? { ca } : {}) },
    httpHandler: (_request, response) => { response.writeHead(200); response.end('ok') },
  })
  await server.listen()
  try { await run(server.port) } finally { server.close() }
}

describe('TLS client certificate authentication', () => {
  test('rejects a client without a certificate when a client CA is configured', async () => {
    await withServer(true, async port => { await expect(request(port)).rejects.toBeDefined() })
  })
  test('accepts a client certificate signed by the configured CA', async () => {
    await withServer(true, async port => {
      expect(await request(port, { cert: clientCert, key: clientKey })).toBe(200)
    })
  })
  test('preserves ordinary verified TLS when no client CA is configured', async () => {
    await withServer(false, async port => { expect(await request(port)).toBe(200) })
  })
})
