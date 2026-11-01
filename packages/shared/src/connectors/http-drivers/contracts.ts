import type { ConnectorPackOperation } from "../pack-manifest";
import { connectorPackTemplates } from "../pack-manifest";
import type { ConnectorRuntimeAdmission } from "../durable-pack-registry";
import type { SecretLeaseConsumptionDecision, SecretLeaseConsumptionRequest, SecretLeaseGrant } from "../../credentials/secret-lease-broker";
import { type CapabilityConsumptionDecision, type CapabilityOperationRequest, type OperationCapability } from "../../governance/capability-broker";
import type { ExecutionProofIssueRequest, SignedExecutionProof } from "../../governance/execution-proof";

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

export interface ConnectorEgressObservation {
  operationId: string
  destinationOrigin: string
  payload: Record<string, unknown>
}

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
  recordExecutionProof: (proof: SignedExecutionProof) => void
  createHealthAuthorization: () => ConnectorCapabilityAuthorization
  /** Last synchronous boundary before the credentialed HTTP transport is invoked. */
  onEgress?: (observation: ConnectorEgressObservation) => void
  now?: () => string
}

export interface InvocationEnvelope {
  payload: Record<string, unknown>
  resourceId?: string
  idempotencyKey?: string
  authorization?: ConnectorCapabilityAuthorization
}
