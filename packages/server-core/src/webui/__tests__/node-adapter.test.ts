import { afterEach, describe, expect, it } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { nodeHttpAdapter, type NodeHttpAdapterErrorContext } from '../node-adapter'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener')
  return `http://127.0.0.1:${address.port}`
}

describe('nodeHttpAdapter', () => {
  it('returns 500 and reports only sanitized error metadata when a handler throws', async () => {
    let reported: NodeHttpAdapterErrorContext | undefined
    const server = createServer(nodeHttpAdapter(
      async () => {
        throw new TypeError('pairing=secret-ticket cookie=secret-cookie body=secret-body')
      },
      {
        onError: (context) => {
          reported = context
        },
      },
    ))
    const baseUrl = await listen(server)

    const response = await fetch(`${baseUrl}/api/remote/device?pairing=secret-ticket`, {
      method: 'POST',
      headers: {
        Cookie: 'craft_session=secret-cookie',
        'X-Private-Header': 'secret-header',
      },
      body: 'secret-body',
    })

    expect(response.status).toBe(500)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe('Internal Server Error')
    expect(reported).toEqual({
      errorName: 'TypeError',
      method: 'POST',
      pathname: '/api/remote/device',
    })
    expect(Object.keys(reported ?? {}).sort()).toEqual(['errorName', 'method', 'pathname'])
    expect(JSON.stringify(reported)).not.toContain('secret')
  })

  it('still returns 500 when the diagnostic callback itself throws', async () => {
    const server = createServer(nodeHttpAdapter(
      () => {
        throw new Error('handler failure')
      },
      {
        onError: () => {
          throw new Error('logger failure')
        },
      },
    ))
    const baseUrl = await listen(server)

    const response = await fetch(`${baseUrl}/remote?secret=query-value`)

    expect(response.status).toBe(500)
    expect(await response.text()).toBe('Internal Server Error')
  })
})
