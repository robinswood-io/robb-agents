import type {
  ConnectorPackDefinition,
  ConnectorPackDriver,
  ConnectorPackOperation,
} from './pack-manifest'
import { connectorPackTemplates } from './pack-manifest'

export type PriorityConnectorPack = keyof typeof connectorPackTemplates

export interface ConnectorSecretLease {
  reference: string
  value: string
  scopes: string[]
  expiresAt: string
}

export interface ConnectorApprovalReceipt {
  approvalId: string
  operationId: string
  decision: 'approved'
  approvedBy: string
  expiresAt: string
}

export interface ConnectorHttpRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  headers: Record<string, string>
  body?: Record<string, unknown>
  timeoutMs: number
}

export interface ConnectorHttpResponse {
  status: number
  body: unknown
}

export type ConnectorSecretResolver = (reference: string) => Promise<ConnectorSecretLease | null>
export type ConnectorHttpTransport = (request: ConnectorHttpRequest) => Promise<ConnectorHttpResponse>

export class ConnectorDriverError extends Error {
  constructor(
    public readonly code:
      | 'UNKNOWN_OPERATION'
      | 'SECRET_UNAVAILABLE'
      | 'SECRET_EXPIRED'
      | 'SCOPE_DENIED'
      | 'APPROVAL_REQUIRED'
      | 'IDEMPOTENCY_REQUIRED'
      | 'RATE_LIMITED'
      | 'CONCURRENCY_LIMIT'
      | 'INVALID_INPUT'
      | 'UPSTREAM_ERROR',
    message: string,
  ) {
    super(message)
    this.name = 'ConnectorDriverError'
  }
}

interface OperationBinding {
  method: ConnectorHttpRequest['method']
  path: string
}

interface PriorityDriverDefinition {
  defaultBaseUrl?: string
  bindings: Record<string, OperationBinding>
}

export const priorityConnectorDriverDefinitions: Record<PriorityConnectorPack, PriorityDriverDefinition> = {
  microsoft365: {
    defaultBaseUrl: 'https://graph.microsoft.com',
    bindings: {
      'health.read': { method: 'GET', path: '/v1.0/me/drive' },
      'files.list': { method: 'GET', path: '/v1.0/me/drive/root/children' },
      'files.update': { method: 'PATCH', path: '/v1.0/me/drive/items/:resourceId' },
    },
  },
  googleWorkspace: {
    defaultBaseUrl: 'https://www.googleapis.com',
    bindings: {
      'health.read': { method: 'GET', path: '/drive/v3/about' },
      'drive.list': { method: 'GET', path: '/drive/v3/files' },
      'drive.update': { method: 'PATCH', path: '/drive/v3/files/:resourceId' },
    },
  },
  slackTeams: {
    defaultBaseUrl: 'https://slack.com/api',
    bindings: {
      'health.read': { method: 'GET', path: '/auth.test' },
      'messages.list': { method: 'GET', path: '/conversations.history' },
      'messages.send': { method: 'POST', path: '/chat.postMessage' },
    },
  },
  crm: {
    bindings: {
      'health.read': { method: 'GET', path: '/health' },
      'records.list': { method: 'GET', path: '/v1/records' },
      'records.upsert': { method: 'POST', path: '/v1/records' },
    },
  },
  erp: {
    bindings: {
      'health.read': { method: 'GET', path: '/health' },
      'entries.list': { method: 'GET', path: '/v1/entries' },
      'entries.post': { method: 'POST', path: '/v1/entries' },
    },
  },
}

interface ConnectorDriverOptions {
  baseUrl?: string
  secretReference: string
  resolveSecret: ConnectorSecretResolver
  transport: ConnectorHttpTransport
  now?: () => string
}

interface InvocationEnvelope {
  payload: Record<string, unknown>
  resourceId?: string
  approval?: ConnectorApprovalReceipt
  idempotencyKey?: string
}

function readInvocationEnvelope(input: Record<string, unknown>): InvocationEnvelope {
  const rawPayload = input.payload
  const payload = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
    ? { ...rawPayload } as Record<string, unknown>
    : {}
  const resourceId = typeof input.resourceId === 'string' && input.resourceId.trim()
    ? input.resourceId.trim()
    : undefined
  const idempotencyKey = typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim()
    ? input.idempotencyKey.trim()
    : undefined
  const rawApproval = input.approval
  const approval = rawApproval
    && typeof rawApproval === 'object'
    && !Array.isArray(rawApproval)
    && typeof Reflect.get(rawApproval, 'approvalId') === 'string'
    && typeof Reflect.get(rawApproval, 'operationId') === 'string'
    && Reflect.get(rawApproval, 'decision') === 'approved'
    && typeof Reflect.get(rawApproval, 'approvedBy') === 'string'
    && typeof Reflect.get(rawApproval, 'expiresAt') === 'string'
    ? {
        approvalId: Reflect.get(rawApproval, 'approvalId') as string,
        operationId: Reflect.get(rawApproval, 'operationId') as string,
        decision: 'approved' as const,
        approvedBy: Reflect.get(rawApproval, 'approvedBy') as string,
        expiresAt: Reflect.get(rawApproval, 'expiresAt') as string,
      }
    : undefined
  return { payload, resourceId, approval, idempotencyKey }
}

function renderPath(path: string, resourceId?: string): string {
  if (!path.includes(':resourceId')) return path
  if (!resourceId) {
    throw new ConnectorDriverError('INVALID_INPUT', 'resourceId is required for this connector operation')
  }
  return path.replace(':resourceId', encodeURIComponent(resourceId))
}

class ConnectorRequestLimiter {
  private windowStartedAt = 0
  private requestCount = 0
  private activeCount = 0

  constructor(
    private readonly requests: number,
    private readonly windowMs: number,
    private readonly maxConcurrency: number,
    private readonly nowMs: () => number,
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const now = this.nowMs()
    if (now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now
      this.requestCount = 0
    }
    if (this.activeCount >= this.maxConcurrency) {
      throw new ConnectorDriverError('CONCURRENCY_LIMIT', 'Connector concurrency limit reached')
    }
    if (this.requestCount >= this.requests) {
      throw new ConnectorDriverError('RATE_LIMITED', 'Connector request rate limit reached')
    }
    this.requestCount += 1
    this.activeCount += 1
    try {
      return await operation()
    } finally {
      this.activeCount -= 1
    }
  }
}

export class HttpConnectorPackDriver implements ConnectorPackDriver {
  private readonly limiter: ConnectorRequestLimiter

  constructor(
    private readonly manifest: ConnectorPackDefinition,
    private readonly definition: PriorityDriverDefinition,
    private readonly baseUrl: string,
    private readonly secretReference: string,
    private readonly resolveSecret: ConnectorSecretResolver,
    private readonly transport: ConnectorHttpTransport,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.limiter = new ConnectorRequestLimiter(
      manifest.rateLimit.requests,
      manifest.rateLimit.windowMs,
      manifest.rateLimit.maxConcurrency,
      () => Date.parse(this.now()),
    )
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number }> {
    const startedAt = Date.parse(this.now())
    try {
      await this.invoke(this.manifest.healthCheck.operationId, {})
      return {
        healthy: true,
        latencyMs: Math.max(0, Date.parse(this.now()) - startedAt),
      }
    } catch {
      return {
        healthy: false,
        latencyMs: Math.max(0, Date.parse(this.now()) - startedAt),
      }
    }
  }

  async invoke(operationId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const operation = this.operation(operationId)
    if (input.contractProbe === true) {
      return {
        operationId,
        effect: operation.effect,
        requiredScopes: [...operation.requiredScopes],
      }
    }

    return this.limiter.run(async () => {
      const lease = await this.resolveSecret(this.secretReference)
      if (!lease) {
        throw new ConnectorDriverError('SECRET_UNAVAILABLE', `Secret reference ${this.secretReference} is unavailable`)
      }
      const now = this.now()
      if (Date.parse(lease.expiresAt) <= Date.parse(now)) {
        throw new ConnectorDriverError('SECRET_EXPIRED', `Secret reference ${this.secretReference} has expired`)
      }
      const missingScopes = operation.requiredScopes.filter((scope) => !lease.scopes.includes(scope))
      if (missingScopes.length > 0) {
        throw new ConnectorDriverError('SCOPE_DENIED', `Missing connector scopes: ${missingScopes.join(', ')}`)
      }

      const envelope = readInvocationEnvelope(input)
      this.authorizeMutation(operation, envelope, now)
      const binding = this.definition.bindings[operationId]
      if (!binding) throw new ConnectorDriverError('UNKNOWN_OPERATION', `No HTTP binding for ${operationId}`)
      const path = renderPath(binding.path, envelope.resourceId)
      const url = new URL(path, `${this.baseUrl.replace(/\/+$/, '')}/`)
      if (binding.method === 'GET') {
        for (const [key, value] of Object.entries(envelope.payload)) {
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            url.searchParams.set(key, String(value))
          }
        }
      }
      const response = await this.transport({
        method: binding.method,
        url: url.toString(),
        headers: {
          Authorization: `Bearer ${lease.value}`,
          Accept: 'application/json',
          ...(binding.method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
          ...(envelope.idempotencyKey ? { 'Idempotency-Key': envelope.idempotencyKey } : {}),
        },
        ...(binding.method === 'GET' ? {} : { body: envelope.payload }),
        timeoutMs: this.manifest.healthCheck.timeoutMs,
      })
      if (response.status < 200 || response.status >= 300) {
        throw new ConnectorDriverError('UPSTREAM_ERROR', `Connector upstream returned HTTP ${response.status}`)
      }
      return {
        operationId,
        status: response.status,
        data: response.body,
      }
    })
  }

  private operation(operationId: string): ConnectorPackOperation {
    const operation = this.manifest.operations.find((candidate) => candidate.id === operationId)
    if (!operation) throw new ConnectorDriverError('UNKNOWN_OPERATION', `Unknown connector operation ${operationId}`)
    return operation
  }

  private authorizeMutation(
    operation: ConnectorPackOperation,
    envelope: InvocationEnvelope,
    now: string,
  ): void {
    if (operation.effect === 'read') return
    if (
      !envelope.approval
      || envelope.approval.operationId !== operation.id
      || Date.parse(envelope.approval.expiresAt) <= Date.parse(now)
    ) {
      throw new ConnectorDriverError('APPROVAL_REQUIRED', `Approved receipt required for ${operation.id}`)
    }
    if (!operation.idempotent && !envelope.idempotencyKey) {
      throw new ConnectorDriverError('IDEMPOTENCY_REQUIRED', `Idempotency key required for ${operation.id}`)
    }
  }
}

export function createPriorityConnectorDriver(
  pack: PriorityConnectorPack,
  options: ConnectorDriverOptions,
): HttpConnectorPackDriver {
  const definition = priorityConnectorDriverDefinitions[pack]
  const baseUrl = options.baseUrl ?? definition.defaultBaseUrl
  if (!baseUrl) {
    throw new ConnectorDriverError('INVALID_INPUT', `${pack} requires an explicit baseUrl`)
  }
  return new HttpConnectorPackDriver(
    connectorPackTemplates[pack],
    definition,
    baseUrl,
    options.secretReference,
    options.resolveSecret,
    options.transport,
    options.now,
  )
}
