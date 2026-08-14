const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

export function resolveSecureRemoteHost(
  requestedHost: string,
  tlsAvailable: boolean,
): { host: string; networkBindRejected: boolean } {
  if (tlsAvailable || isLoopbackHost(requestedHost)) {
    return { host: requestedHost, networkBindRejected: false }
  }
  return { host: '127.0.0.1', networkBindRejected: true }
}
