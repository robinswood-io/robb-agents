import {
  RemoteEnvelopeAuthenticationError,
  RemoteEnvelopeReplayError,
  RemoteEnvelopeVerifier,
  createSignedRemoteEnvelope,
  type RemoteAction,
  type RemoteActionRequest,
  type RemoteActionResponse,
  type RemoteProjectionRequest,
  type RemoteProjectionResponse,
  type RemoteSupervisionSignedEnvelope,
  type RemoteSupervisorIdentity,
  type RemoteTaskProjection,
} from '@craft-agent/shared/remote-supervision'
import {
  RemoteSupervisionService,
} from './remote-supervision-service'

const MAX_REMOTE_SUPERVISION_BODY_BYTES = 64 * 1024
const DEFAULT_REMOTE_SUPERVISION_REQUESTS_PER_MINUTE = 120

export interface RemoteSupervisionPeer {
  keyId: string
  sharedSecret: string
  identity: RemoteSupervisorIdentity
}

export interface RemoteSupervisionHttpGatewayOptions {
  resolvePeer(keyId: string): RemoteSupervisionPeer | null
  resolveService(workspaceId: string): RemoteSupervisionService | null
  executeAction(input: {
    workspaceId: string
    action: RemoteAction
    identity: RemoteSupervisorIdentity
    targetId?: string
  }): Promise<void> | void
  now?: () => Date
  maxRequestsPerMinute?: number
}

export interface RemoteSupervisionHttpServerOptions extends RemoteSupervisionHttpGatewayOptions {
  hostname?: string
  port?: number
}

export interface RemoteSupervisionHttpServerHandle {
  url: string
  stop(): void
}

export function createRemoteSupervisionHttpGateway(
  options: RemoteSupervisionHttpGatewayOptions,
): (request: Request) => Promise<Response> {
  const verifier = new RemoteEnvelopeVerifier(
    (keyId) => options.resolvePeer(keyId)?.sharedSecret ?? null,
    { now: options.now },
  )
  const maxRequestsPerMinute = options.maxRequestsPerMinute
    ?? DEFAULT_REMOTE_SUPERVISION_REQUESTS_PER_MINUTE
  if (!Number.isInteger(maxRequestsPerMinute) || maxRequestsPerMinute < 1) {
    throw new Error('Remote supervision rate limit must be a positive integer')
  }
  let rateWindowStartedAt = currentDate(options).getTime()
  let rateWindowRequestCount = 0

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/v1/remote-supervision/health') {
      return jsonResponse({ ok: true, service: 'remote-supervision' }, 200)
    }
    if (request.method !== 'POST') return jsonResponse({ error: 'not_found' }, 404)
    const now = currentDate(options).getTime()
    if (now - rateWindowStartedAt >= 60_000) {
      rateWindowStartedAt = now
      rateWindowRequestCount = 0
    }
    rateWindowRequestCount += 1
    if (rateWindowRequestCount > maxRequestsPerMinute) {
      return jsonResponse(
        { error: 'remote_supervision_rate_limited' },
        429,
        { 'retry-after': '60' },
      )
    }

    try {
      const { envelope, peer } = await verifyIncomingEnvelope(request, verifier, options.resolvePeer)
      if (url.pathname === '/v1/remote-supervision/project') {
        const payload = parseProjectionRequest(envelope.payload)
        const service = resolveWorkspaceService(options, payload.workspaceId)
        const projection = service.projectTask(payload.snapshot, currentIso(options))
        const responsePayload: RemoteProjectionResponse = {
          requestId: envelope.requestId,
          projection,
        }
        return signedResponse(peer, responsePayload, options)
      }
      if (url.pathname === '/v1/remote-supervision/action') {
        const payload = parseActionRequest(envelope.payload)
        const service = resolveWorkspaceService(options, payload.workspaceId)
        service.authorizeRemoteAction(peer.identity, payload.action, currentIso(options))
        await options.executeAction({
          workspaceId: payload.workspaceId,
          action: payload.action,
          identity: peer.identity,
          targetId: payload.targetId,
        })
        const responsePayload: RemoteActionResponse = {
          requestId: envelope.requestId,
          action: payload.action,
          accepted: true,
          executedAt: currentIso(options),
        }
        return signedResponse(peer, responsePayload, options)
      }
      return jsonResponse({ error: 'not_found' }, 404)
    } catch (error) {
      if (error instanceof RemoteEnvelopeReplayError) return jsonResponse({ error: error.code }, 409)
      if (error instanceof RemoteEnvelopeAuthenticationError) return jsonResponse({ error: error.code }, 401)
      if (error instanceof RemoteSupervisionForbiddenError) return jsonResponse({ error: 'remote_supervision_forbidden' }, 403)
      if (error instanceof RemoteSupervisionBadRequestError) return jsonResponse({ error: 'bad_request', message: error.message }, 400)
      if (error instanceof Error && error.message.includes('not authorized')) {
        return jsonResponse({ error: 'remote_supervision_forbidden' }, 403)
      }
      return jsonResponse({ error: 'remote_supervision_internal_error' }, 500)
    }
  }
}

export function startRemoteSupervisionHttpServer(
  options: RemoteSupervisionHttpServerOptions,
): RemoteSupervisionHttpServerHandle {
  const hostname = options.hostname ?? '127.0.0.1'
  if (!isLoopbackHostname(hostname)) {
    throw new Error(
      'Remote supervision HTTP server must bind to loopback; expose it through an authenticated TLS reverse proxy',
    )
  }
  const server = Bun.serve({
    hostname,
    port: options.port ?? 0,
    fetch: createRemoteSupervisionHttpGateway(options),
  })
  const boundHostname = server.hostname ?? hostname
  const urlHostname = boundHostname.includes(':')
    ? `[${boundHostname}]`
    : boundHostname
  return {
    url: `http://${urlHostname}:${server.port}`,
    stop: () => server.stop(),
  }
}

async function verifyIncomingEnvelope(
  request: Request,
  verifier: RemoteEnvelopeVerifier,
  resolvePeer: (keyId: string) => RemoteSupervisionPeer | null,
): Promise<{
  envelope: RemoteSupervisionSignedEnvelope<unknown>
  peer: RemoteSupervisionPeer
}> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
    throw new RemoteSupervisionBadRequestError('Remote supervision requests must use application/json')
  }
  const contentEncoding = request.headers.get('content-encoding')?.trim().toLowerCase()
  if (contentEncoding && contentEncoding !== 'identity') {
    throw new RemoteSupervisionBadRequestError('Compressed remote supervision request bodies are not accepted')
  }
  const declaredKeyId = request.headers.get('x-robb-remote-key-id')?.trim()
  const body = await readBoundedJson(request)
  let envelope: RemoteSupervisionSignedEnvelope<unknown>
  try {
    envelope = verifier.verify(body)
  } catch (error) {
    if (
      error instanceof RemoteEnvelopeAuthenticationError
      || error instanceof RemoteEnvelopeReplayError
    ) {
      throw error
    }
    throw new RemoteEnvelopeAuthenticationError()
  }
  if (declaredKeyId !== envelope.keyId) {
    throw new RemoteEnvelopeAuthenticationError('Remote supervision key header does not match envelope')
  }
  const peer = resolvePeer(envelope.keyId)
  if (!peer) throw new RemoteEnvelopeAuthenticationError()
  return { envelope, peer }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get('content-length')
  if (
    declaredLength
    && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_REMOTE_SUPERVISION_BODY_BYTES)
  ) {
    throw new RemoteSupervisionBadRequestError('Remote supervision request body is too large')
  }

  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_REMOTE_SUPERVISION_BODY_BYTES) {
        await reader.cancel()
        throw new RemoteSupervisionBadRequestError('Remote supervision request body is too large')
      }
      chunks.push(value)
    }
  }
  const body = Buffer.concat(chunks, totalBytes).toString('utf8')
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new RemoteSupervisionBadRequestError('Remote supervision request body is not valid JSON')
  }
}

function signedResponse(
  peer: RemoteSupervisionPeer,
  payload: RemoteProjectionResponse | RemoteActionResponse,
  options: RemoteSupervisionHttpGatewayOptions,
): Response {
  return jsonResponse(createSignedRemoteEnvelope(
    peer.keyId,
    peer.sharedSecret,
    payload,
    { issuedAt: currentIso(options) },
  ), 200)
}

function jsonResponse(
  value: unknown,
  status: number,
  additionalHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json',
      'x-content-type-options': 'nosniff',
      ...additionalHeaders,
    },
  })
}

function resolveWorkspaceService(
  options: RemoteSupervisionHttpGatewayOptions,
  workspaceId: string,
): RemoteSupervisionService {
  const service = options.resolveService(workspaceId)
  if (!service) throw new RemoteSupervisionForbiddenError()
  return service
}

function parseProjectionRequest(value: unknown): RemoteProjectionRequest {
  if (!isRecord(value) || typeof value.workspaceId !== 'string') {
    throw new RemoteSupervisionBadRequestError('Remote projection request is invalid')
  }
  return {
    workspaceId: parseNonEmptyString(value.workspaceId, 'workspaceId'),
    snapshot: parseTaskProjection(value.snapshot),
  }
}

function parseActionRequest(value: unknown): RemoteActionRequest {
  if (!isRecord(value) || typeof value.workspaceId !== 'string') {
    throw new RemoteSupervisionBadRequestError('Remote action request is invalid')
  }
  return {
    workspaceId: parseNonEmptyString(value.workspaceId, 'workspaceId'),
    action: parseRemoteAction(value.action),
    targetId: value.targetId === undefined ? undefined : parseNonEmptyString(value.targetId, 'targetId'),
  }
}

function parseTaskProjection(value: unknown): RemoteTaskProjection {
  if (!isRecord(value) || !isRecord(value.task)) {
    throw new RemoteSupervisionBadRequestError('Remote task projection is invalid')
  }
  const task: RemoteTaskProjection['task'] = {}
  if (value.task.status !== undefined) task.status = parseNonEmptyString(value.task.status, 'status')
  if (value.task.progress !== undefined) task.progress = parseProgress(value.task.progress)
  if (value.task.blockers !== undefined) task.blockers = parseStringArray(value.task.blockers, 'blockers')
  if (value.task.approvals !== undefined) task.approvals = parseApprovals(value.task.approvals)
  if (value.task.cost !== undefined) task.cost = parseCost(value.task.cost)
  if (value.task.timestamps !== undefined) task.timestamps = parseTimestamps(value.task.timestamps)
  return { task }
}

function parseRemoteAction(value: unknown): RemoteAction {
  if (value === 'task.pause' || value === 'task.cancel' || value === 'approval.resolve') return value
  throw new RemoteSupervisionBadRequestError('Remote action is invalid')
}

function parseProgress(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RemoteSupervisionBadRequestError('Remote task progress is invalid')
  }
  return value
}

function parseStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) throw new RemoteSupervisionBadRequestError(`Remote ${fieldName} must be an array`)
  return value.map((item) => parseNonEmptyString(item, fieldName))
}

function parseApprovals(value: unknown): Array<{ id: string; status: string }> {
  if (!Array.isArray(value)) throw new RemoteSupervisionBadRequestError('Remote approvals must be an array')
  return value.map((item) => {
    if (!isRecord(item)) throw new RemoteSupervisionBadRequestError('Remote approval is invalid')
    return {
      id: parseNonEmptyString(item.id, 'approval.id'),
      status: parseNonEmptyString(item.status, 'approval.status'),
    }
  })
}

function parseCost(value: unknown): { amount: number; currency: string } {
  if (!isRecord(value) || typeof value.amount !== 'number' || !Number.isFinite(value.amount)) {
    throw new RemoteSupervisionBadRequestError('Remote task cost is invalid')
  }
  return {
    amount: value.amount,
    currency: parseNonEmptyString(value.currency, 'cost.currency'),
  }
}

function parseTimestamps(value: unknown): { createdAt?: string; updatedAt?: string } {
  if (!isRecord(value)) throw new RemoteSupervisionBadRequestError('Remote task timestamps are invalid')
  const timestamps: { createdAt?: string; updatedAt?: string } = {}
  if (value.createdAt !== undefined) timestamps.createdAt = parseIsoDate(value.createdAt, 'timestamps.createdAt')
  if (value.updatedAt !== undefined) timestamps.updatedAt = parseIsoDate(value.updatedAt, 'timestamps.updatedAt')
  return timestamps
}

function parseIsoDate(value: unknown, fieldName: string): string {
  const parsed = parseNonEmptyString(value, fieldName)
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new RemoteSupervisionBadRequestError(`Remote ${fieldName} must be an ISO date`)
  }
  return parsed
}

function parseNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RemoteSupervisionBadRequestError(`Remote ${fieldName} must be a non-empty string`)
  }
  return value.trim()
}

function currentIso(options: RemoteSupervisionHttpGatewayOptions): string {
  return currentDate(options).toISOString()
}

function currentDate(options: RemoteSupervisionHttpGatewayOptions): Date {
  return (options.now ?? (() => new Date()))()
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value.trim().toLowerCase()
  return hostname === '127.0.0.1'
    || hostname === 'localhost'
    || hostname === '::1'
    || hostname === '[::1]'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class RemoteSupervisionBadRequestError extends Error {}
class RemoteSupervisionForbiddenError extends Error {}
