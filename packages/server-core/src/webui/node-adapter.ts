/**
 * Node HTTP ↔ Web Standard adapter.
 *
 * Bridges Node.js `(IncomingMessage, ServerResponse)` callbacks to
 * the web-standard `(Request) => Response` handler used by the WebUI.
 * This lets us serve the WebUI from the same HTTPS server that the
 * WsRpcServer creates for WebSocket connections.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

type WebHandler = (req: Request) => Promise<Response> | Response
const MAX_REQUEST_BODY_BYTES = 64 * 1024

/**
 * Deliberately minimal request metadata exposed when a handler fails.
 *
 * Do not add the raw URL, headers, cookies, query parameters, or body here:
 * this event is intended for production logs and must remain safe to record.
 */
export interface NodeHttpAdapterErrorContext {
  readonly method: string
  readonly pathname: string
  /** Coarse, allow-listed classification. The thrown value and its message are never exposed. */
  readonly errorName: string
}

export interface NodeHttpAdapterOptions {
  onError?: (context: NodeHttpAdapterErrorContext) => void
}

const nodeRequestRemoteAddresses = new WeakMap<Request, string>()

/** Returns the transport peer captured by the Node adapter, if any. */
export function getNodeRequestRemoteAddress(request: Request): string | null {
  return nodeRequestRemoteAddresses.get(request) ?? null
}

/**
 * Wrap a web-standard fetch handler as a Node HTTP request listener.
 * WebSocket upgrade requests are NOT routed through this adapter —
 * the `ws` library intercepts them at the 'upgrade' event level.
 */
export function nodeHttpAdapter(
  handler: WebHandler,
  options: NodeHttpAdapterOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  return (nodeReq, nodeRes) => {
    handleRequest(handler, nodeReq, nodeRes).catch((error) => {
      reportHandlerError(error, nodeReq, options.onError)
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(500, {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        })
      }
      nodeRes.end('Internal Server Error')
    })
  }
}

function reportHandlerError(
  error: unknown,
  request: IncomingMessage,
  onError: NodeHttpAdapterOptions['onError'],
): void {
  const context = Object.freeze({
    method: request.method ?? 'UNKNOWN',
    pathname: requestPathname(request.url),
    errorName: safeErrorName(error),
  })

  if (onError) {
    try {
      onError(context)
      return
    } catch {
      // A diagnostic callback must never change the HTTP failure response.
    }
  }

  console.error('[webui-adapter] Unhandled request error', context)
}

function safeErrorName(error: unknown): string {
  if (error instanceof EvalError) return 'EvalError'
  if (error instanceof RangeError) return 'RangeError'
  if (error instanceof ReferenceError) return 'ReferenceError'
  if (error instanceof SyntaxError) return 'SyntaxError'
  if (error instanceof TypeError) return 'TypeError'
  if (error instanceof URIError) return 'URIError'
  if (error instanceof Error) return 'Error'
  return 'NonErrorThrow'
}

function requestPathname(requestTarget: string | undefined): string {
  try {
    return new URL(requestTarget ?? '/', 'http://localhost').pathname || '/'
  } catch {
    return '/'
  }
}

async function handleRequest(
  handler: WebHandler,
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
): Promise<void> {
  // Build web-standard Request from Node IncomingMessage
  const encrypted = Boolean((nodeReq.socket as typeof nodeReq.socket & { encrypted?: boolean }).encrypted)
  const protocol = encrypted ? 'https' : 'http'
  const host = nodeReq.headers.host ?? 'localhost'
  const url = `${protocol}://${host}${nodeReq.url ?? '/'}`

  const headers = new Headers()
  const raw = nodeReq.rawHeaders
  for (let i = 0; i < raw.length; i += 2) {
    headers.append(raw[i], raw[i + 1])
  }

  let body: Buffer | null = null
  if (nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD') {
    const chunks: Buffer[] = []
    let totalBytes = 0
    for await (const chunk of nodeReq) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      totalBytes += buffer.byteLength
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        nodeRes.writeHead(413, {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        })
        nodeRes.end('Payload Too Large')
        nodeReq.destroy()
        return
      }
      chunks.push(buffer)
    }
    body = Buffer.concat(chunks)
  }

  const request = new Request(url, {
    method: nodeReq.method,
    headers,
    body: body ? new Uint8Array(body) : null,
  })
  const remoteAddress = nodeReq.socket.remoteAddress
  if (remoteAddress) nodeRequestRemoteAddresses.set(request, remoteAddress)

  const response = await handler(request)

  // Write web-standard Response back to Node ServerResponse.
  // Headers.forEach iterates each value separately, which correctly
  // handles multi-value headers like Set-Cookie.
  const resHeaders: Record<string, string | string[]> = {}
  response.headers.forEach((value, key) => {
    const existing = resHeaders[key]
    if (existing) {
      resHeaders[key] = Array.isArray(existing)
        ? [...existing, value]
        : [existing, value]
    } else {
      resHeaders[key] = value
    }
  })

  nodeRes.writeHead(response.status, resHeaders)

  if (response.body) {
    const buffer = Buffer.from(await response.arrayBuffer())
    nodeRes.end(buffer)
  } else {
    nodeRes.end()
  }
}
