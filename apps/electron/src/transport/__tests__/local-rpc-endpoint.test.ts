import { describe, expect, it } from 'bun:test'
import { createLocalRpcEndpoint } from '../local-rpc-endpoint'

describe('createLocalRpcEndpoint', () => {
  it('uses plaintext WebSocket for a plaintext embedded server', () => {
    expect(createLocalRpcEndpoint(3210, false)).toEqual({
      url: 'ws://127.0.0.1:3210',
      tlsRejectUnauthorized: true,
    })
  })

  it('uses WebSocket TLS and accepts the embedded self-signed certificate', () => {
    expect(createLocalRpcEndpoint(9100, true)).toEqual({
      url: 'wss://127.0.0.1:9100',
      tlsRejectUnauthorized: false,
    })
  })
})
