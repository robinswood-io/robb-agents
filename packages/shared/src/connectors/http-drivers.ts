import type {
  ConnectorPackDefinition,
  ConnectorPackDriver,
  ConnectorPackOperation,
} from './pack-manifest'
import { connectorPackManifestHash, connectorPackTemplates } from './pack-manifest'
import type { ConnectorRuntimeAdmission } from './durable-pack-registry'
import type {
  SecretLeaseConsumptionDecision,
  SecretLeaseConsumptionRequest,
  SecretLeaseGrant,
} from '../credentials/secret-lease-broker'
import {
  operationValueHash,
  parseCapabilityOperationRequest,
  parseOperationCapability,
  type CapabilityConsumptionDecision,
  type CapabilityOperationRequest,
  type OperationCapability,
} from '../governance/capability-broker'
import type {
  ExecutionProofIssueRequest,
  SignedExecutionProof,
} from '../governance/execution-proof'

export type PriorityConnectorPack = keyof typeof connectorPackTemplates

export interface ConnectorSecretLease {
  grant: SecretLeaseGrant
  value: string
}

export interface ConnectorApprovalReceipt {
  approvalId: string
  operationId: string
  decision: 'approved'
  approvedBy: string
  expiresAt: string
}

export interface ConnectorCapabilityAuthorization {
  request: CapabilityOperationRequest
  capability: OperationCapability
}

export type ConnectorCapabilityConsumer = (
  capability: OperationCapability,
  request: CapabilityOperationRequest,
) => CapabilityConsumptionDecision

export interface ConnectorHttpRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  url: string
  headers: Record<string, string>
  body?: Record<string, unknown>
  timeoutMs: number
  redirect: 'manual'
  security: {
    allowedOrigins: string[]
    blockPrivateAddresses: true
  }
}

export interface ConnectorHttpResponse {
  status: number
  body: unknown
  requestId?: string
  redirected?: boolean
}

export type ConnectorSecretResolver = (
  reference: string,
  request: SecretLeaseConsumptionRequest,
) => Promise<ConnectorSecretLease | null>
export type ConnectorHttpTransport = (request: ConnectorHttpRequest) => Promise<ConnectorHttpResponse>
export type ConnectorSecretLeaseConsumer = (
  grant: SecretLeaseGrant,
  request: SecretLeaseConsumptionRequest,
) => SecretLeaseConsumptionDecision
export type ConnectorRuntimeAdmissionVerifier = (
  packId: string,
  operationId: string,
  expectedManifestHash: string,
) => ConnectorRuntimeAdmission

export interface ConnectorMutationReconciliationObservation {
  status: 'confirmed' | 'diverged'
  observedAt: string
  providerState: unknown
  detailCode?: string
}

export interface ConnectorMutationReconciliationRequest {
  operation: ConnectorPackOperation
  capabilityRequest: CapabilityOperationRequest
  providerResponse: ConnectorHttpResponse
  resourceId?: string
}

export type ConnectorMutationReconciler = (
  request: ConnectorMutationReconciliationRequest,
) => Promise<ConnectorMutationReconciliationObservation>

export type ConnectorExecutionProofIssuer = (
  request: ExecutionProofIssueRequest,
) => SignedExecutionProof

export class ConnectorDriverError extends Error {
  constructor(
    public readonly code:
      | 'UNKNOWN_OPERATION'
      | 'SECRET_UNAVAILABLE'
      | 'SECRET_EXPIRED'
      | 'SCOPE_DENIED'
      | 'APPROVAL_REQUIRED'
      | 'CAPABILITY_REQUIRED'
      | 'CAPABILITY_DENIED'
      | 'IDEMPOTENCY_REQUIRED'
      | 'ORIGIN_DENIED'
      | 'REDIRECT_DENIED'
      | 'RECONCILIATION_REQUIRED'
      | 'RATE_LIMITED'
      | 'CONCURRENCY_LIMIT'
      | 'CONNECTOR_NOT_ACTIVE'
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
    defaultBaseUrl: 'https://slack.com',
    bindings: {
      'health.read': { method: 'GET', path: '/api/auth.test' },
      'messages.list': { method: 'GET', path: '/api/conversations.history' },
      'messages.send': { method: 'POST', path: '/api/chat.postMessage' },
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

export interface ConnectorDriverOptions {
  baseUrl?: string
  secretReference: string
  resolveSecret: ConnectorSecretResolver
  transport: ConnectorHttpTransport
  consumeCapability: ConnectorCapabilityConsumer
  consumeSecretLease: ConnectorSecretLeaseConsumer
  assertRuntimeAdmission: ConnectorRuntimeAdmissionVerifier
  reconcileMutation: ConnectorMutationReconciler
  issueExecutionProof: ConnectorExecutionProofIssuer
  createHealthAuthorization: () => ConnectorCapabilityAuthorization
  now?: () => string
}

interface InvocationEnvelope {
  payload: Record<string, unknown>
  resourceId?: string
  idempotencyKey?: string
  authorization?: ConnectorCapabilityAuthorization
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
  const rawAuthorization = input.authorization
  let authorization: ConnectorCapabilityAuthorization | undefined
  if (rawAuthorization && typeof rawAuthorization === 'object' && !Array.isArray(rawAuthorization)) {
    try {
      authorization = {
        request: parseCapabilityOperationRequest(Reflect.get(rawAuthorization, 'request')),
        capability: parseOperationCapability(Reflect.get(rawAuthorization, 'capability')),
      }
    } catch {
      authorization = undefined
    }
  }
  return { payload, resourceId, idempotencyKey, authorization }
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
  private readonly baseOrigin: string
  private readonly manifestHash: string

  constructor(
    private readonly manifest: ConnectorPackDefinition,
    private readonly definition: PriorityDriverDefinition,
    private readonly baseUrl: string,
    private readonly secretReference: string,
    private readonly resolveSecret: ConnectorSecretResolver,
    private readonly transport: ConnectorHttpTransport,
    private readonly consumeCapability: ConnectorCapabilityConsumer,
    private readonly consumeSecretLease: ConnectorSecretLeaseConsumer,
    private readonly assertRuntimeAdmission: ConnectorRuntimeAdmissionVerifier,
    private readonly reconcileMutation: ConnectorMutationReconciler,
    private readonly issueExecutionProof: ConnectorExecutionProofIssuer,
    private readonly createHealthAuthorization: () => ConnectorCapabilityAuthorization,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    const parsedBaseUrl = new URL(baseUrl)
    if (
      parsedBaseUrl.protocol !== 'https:'
      || parsedBaseUrl.username
      || parsedBaseUrl.password
      || !manifest.allowedOrigins.includes(parsedBaseUrl.origin)
    ) {
      throw new ConnectorDriverError('ORIGIN_DENIED', `Connector origin is not allowed: ${parsedBaseUrl.origin}`)
    }
    this.baseOrigin = parsedBaseUrl.origin
    this.manifestHash = connectorPackManifestHash(manifest)
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
      await this.invoke(this.manifest.healthCheck.operationId, {
        authorization: this.createHealthAuthorization(),
      })
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
    if (input.contractProbe === true) {
      const operation = this.staticOperation(operationId)
      return {
        operationId,
        effect: operation.effect,
        risk: operation.risk,
        requiredScopes: [...operation.requiredScopes],
      }
    }

    const operation = this.runtimeOperation(operationId)
    const envelope = readInvocationEnvelope(input)
    this.authorizeOperation(operation, envelope)
    return this.limiter.run(async () => {
      const capabilityRequest = envelope.authorization?.request
      if (!capabilityRequest) {
        throw new ConnectorDriverError('CAPABILITY_REQUIRED', `Broker capability required for ${operation.id}`)
      }
      const secretLeaseRequest: SecretLeaseConsumptionRequest = {
        secretReference: this.secretReference,
        identity: {
          clientId: capabilityRequest.identity.clientId,
          workspaceId: capabilityRequest.identity.workspaceId,
          sourceId: this.manifest.id,
          missionId: capabilityRequest.identity.missionId,
          nodeId: capabilityRequest.identity.nodeId,
          agentId: capabilityRequest.identity.agentId,
          connectorId: capabilityRequest.identity.connectorId,
        },
        operationId,
        scopes: operation.requiredScopes,
        authorizationGeneration: capabilityRequest.authorizationGeneration,
      }
      const lease = await this.resolveSecret(this.secretReference, secretLeaseRequest)
      if (!lease) {
        throw new ConnectorDriverError('SECRET_UNAVAILABLE', `Secret reference ${this.secretReference} is unavailable`)
      }
      const leaseDecision = this.consumeSecretLease(lease.grant, secretLeaseRequest)
      if (!leaseDecision.allowed) {
        const code = leaseDecision.code === 'LEASE_EXPIRED'
          ? 'SECRET_EXPIRED'
          : leaseDecision.code === 'LEASE_SCOPE_DENIED'
            ? 'SCOPE_DENIED'
            : 'SECRET_UNAVAILABLE'
        throw new ConnectorDriverError(code, leaseDecision.reason)
      }

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
      this.runtimeOperation(operationId)
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
        redirect: 'manual',
        security: {
          allowedOrigins: [...operation.allowedOrigins],
          blockPrivateAddresses: true,
        },
      })
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new ConnectorDriverError('REDIRECT_DENIED', 'Connector redirects are forbidden for credentialed requests')
      }
      if (response.status < 200 || response.status >= 300) {
        throw new ConnectorDriverError('UPSTREAM_ERROR', `Connector upstream returned HTTP ${response.status}`)
      }
      const baseResult: Record<string, unknown> = {
        operationId,
        status: response.status,
        data: response.body,
        trust: 'external-untrusted',
      }
      if (!operation.reconciliation.required) return baseResult
      if (!response.requestId) {
        throw new ConnectorDriverError(
          'RECONCILIATION_REQUIRED',
          `Connector ${operation.id} did not return a provider request identifier`,
        )
      }
      if (!capabilityRequest.identity.nodeId || !envelope.idempotencyKey) {
        throw new ConnectorDriverError(
          'RECONCILIATION_REQUIRED',
          `Connector ${operation.id} requires task-node and idempotency bindings for execution proof`,
        )
      }
      const observation = await this.reconcileMutation({
        operation,
        capabilityRequest,
        providerResponse: response,
        ...(envelope.resourceId ? { resourceId: envelope.resourceId } : {}),
      })
      const executionProof = this.issueExecutionProof({
        clientId: capabilityRequest.identity.clientId,
        workspaceId: capabilityRequest.identity.workspaceId,
        missionId: capabilityRequest.identity.missionId,
        nodeId: capabilityRequest.identity.nodeId,
        agentId: capabilityRequest.identity.agentId,
        connectorId: this.manifest.id,
        operationId,
        idempotencyKey: envelope.idempotencyKey,
        payloadHash: operationValueHash(envelope.payload),
        resultHash: operationValueHash(response.body),
        providerRequestId: response.requestId,
        policyVersion: capabilityRequest.policyVersion,
        authorizationGeneration: capabilityRequest.authorizationGeneration,
        connectorManifestHash: this.manifestHash,
        reconciliation: {
          status: observation.status,
          observedAt: observation.observedAt,
          providerStateHash: operationValueHash(observation.providerState),
          ...(observation.detailCode ? { detailCode: observation.detailCode } : {}),
        },
      })
      return {
        ...baseResult,
        reconciliationReceipt: {
          providerRequestId: response.requestId,
          observedAt: observation.observedAt,
          payloadHash: operationValueHash(envelope.payload),
          ...(envelope.resourceId ? { resourceId: envelope.resourceId } : {}),
        },
        executionProof,
      }
    })
  }

  private staticOperation(operationId: string): ConnectorPackOperation {
    const operation = this.manifest.operations.find((candidate) => candidate.id === operationId)
    if (!operation) throw new ConnectorDriverError('UNKNOWN_OPERATION', `Unknown connector operation ${operationId}`)
    return operation
  }

  private runtimeOperation(operationId: string): ConnectorPackOperation {
    try {
      return this.assertRuntimeAdmission(this.manifest.id, operationId, this.manifestHash).operation
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ConnectorDriverError('CONNECTOR_NOT_ACTIVE', message)
    }
  }

  private authorizeOperation(
    operation: ConnectorPackOperation,
    envelope: InvocationEnvelope,
  ): void {
    if (!envelope.authorization) {
      throw new ConnectorDriverError('CAPABILITY_REQUIRED', `Broker capability required for ${operation.id}`)
    }
    if (!operation.idempotent && !envelope.idempotencyKey) {
      throw new ConnectorDriverError('IDEMPOTENCY_REQUIRED', `Idempotency key required for ${operation.id}`)
    }
    const request = envelope.authorization.request
    if (
      request.operationId !== operation.id
      || request.risk !== operation.risk
      || request.identity.connectorId !== this.manifest.id
      || request.target.origin !== this.baseOrigin
      || !operation.targetResourceTypes.includes(request.target.resourceType)
      || (request.target.resourceId ?? '') !== (envelope.resourceId ?? '')
      || operationValueHash(request.payload) !== operationValueHash(envelope.payload)
      || (request.idempotencyKey ?? '') !== (envelope.idempotencyKey ?? '')
    ) {
      throw new ConnectorDriverError('CAPABILITY_DENIED', `Capability context mismatch for ${operation.id}`)
    }
    const consumed = this.consumeCapability(envelope.authorization.capability, request)
    if (!consumed.allowed) {
      throw new ConnectorDriverError('CAPABILITY_DENIED', `${consumed.code}: ${consumed.reason}`)
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
    options.consumeCapability,
    options.consumeSecretLease,
    options.assertRuntimeAdmission,
    options.reconcileMutation,
    options.issueExecutionProof,
    options.createHealthAuthorization,
    options.now,
  )
}
