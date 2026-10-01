export interface LocalRpcEndpoint {
  url: string
  tlsRejectUnauthorized: boolean
}

/** Build the renderer's loopback endpoint from the server that actually started. */
export function createLocalRpcEndpoint(port: number, tlsEnabled: boolean): LocalRpcEndpoint {
  return {
    url: `${tlsEnabled ? 'wss' : 'ws'}://127.0.0.1:${port}`,
    // Embedded TLS commonly uses a self-signed certificate. This exception is
    // scoped to the fixed loopback URL above and is never applied remotely.
    tlsRejectUnauthorized: !tlsEnabled,
  }
}
