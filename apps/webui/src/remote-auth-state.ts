import type { TransportConnectionState } from '../../electron/src/transport/client'

/**
 * Remote authentication can fail either during the handshake or after a
 * connected device is revoked. Only those terminal authentication signals
 * justify erasing device-scoped offline data.
 */
export function isTerminalRemoteAuthState(
  state: Pick<TransportConnectionState, 'mode' | 'lastError' | 'lastClose'>,
): boolean {
  return state.mode === 'remote'
    && (state.lastError?.kind === 'auth' || state.lastClose?.code === 4005)
}
