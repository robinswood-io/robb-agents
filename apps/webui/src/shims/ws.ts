/**
 * ws shim — browser uses native WebSocket.
 *
 * The WsRpcServer imports WebSocketServer from 'ws' but is never
 * instantiated in the browser. This shim satisfies the bundler.
 */

export class WebSocketServer {
  constructor(_opts?: unknown) {
    throw new Error('WebSocketServer is not available in the browser')
  }
  on<Arguments extends unknown[]>(_event: string, _fn: (...args: Arguments) => unknown) { return this }
  close() {}
  address() { return null }
}

// Re-export native WebSocket for the client
export const WebSocket = globalThis.WebSocket
export type { WebSocket as default }
