import { type ConnectorCapabilityAuthorization, type ConnectorHttpTransport, type ConnectorMutationReconciler, type PriorityConnectorPack } from "@craft-agent/shared/connectors";
import { SecretLeaseBroker } from "@craft-agent/shared/credentials";
import { CapabilityBroker, StructuredEgressFirewall, DurableUseLedger, ExecutionProofIssuer, type AutonomyLevel, type CapabilityApprovalRequest, type CapabilityBrokerDenialCode, type CapabilityOperationRequest, type CapabilityPolicy, type OperationBudgetEstimate, type OperationCompensation, type OperationIdentity, type EgressVaultEntry, type PreparedStructuredEgress, type PrivacyReceipt, type SignedExecutionProof, type StructuredEgressPolicy } from "@craft-agent/shared/governance";
import type { DurableConnectorPackRegistry } from "@craft-agent/shared/connectors";
import { type GovernanceCredentialStore } from "../../tasks/execution-proof-runtime";

export const CAPABILITY_KEY_PURPOSE = 'connector-capability-v1'

export const SECRET_LEASE_KEY_PURPOSE = 'connector-secret-lease-v1'

export const EXECUTION_PROOF_KEY_PURPOSE = 'execution-proof-v1'

export const STRUCTURED_EGRESS_KEY_PURPOSE = 'structured-egress-v1'

export interface PriorityConnectorRuntimeConfiguration {
  pack: PriorityConnectorPack
  secretReference: string
  secretName: string
  baseUrl?: string
  healthIdentity?: Omit<OperationIdentity, 'workspaceId' | 'connectorId'>
  egressPolicy?: StructuredEgressPolicy
}

export interface ConnectorSecretValueRequest {
  workspaceId: string
  packId: string
  secretReference: string
  secretName: string
}

export interface ConnectorProofRecord {
  sessionId: string
  proof: SignedExecutionProof
}

export interface ConnectorPrivacyReceiptRecord {
  sessionId: string
  receipt: PrivacyReceipt
}

export interface PrepareConnectorInvocationInput {
  pack: PriorityConnectorPack
  sessionId: string
  operationId: string
  identity: Omit<OperationIdentity, 'workspaceId' | 'connectorId'>
  autonomy: AutonomyLevel
  resourceType: string
  resourceId?: string
  payload: Record<string, unknown>
  idempotencyKey?: string
  budget?: OperationBudgetEstimate
  compensation?: OperationCompensation
  /** Stable host timestamp used to reconstruct the exact request after restart. */
  requestedAt?: string
}

export interface PreparedConnectorInvocation {
  preparationId: string
  request: CapabilityOperationRequest
}

export type ConnectorExecutionResult =
  | {
      status: 'denied'
      code: CapabilityBrokerDenialCode
      reason: string
      requestHash: string
    }
  | {
      status: 'approval-required'
      approval: CapabilityApprovalRequest
      requestHash: string
      preparationId: string
    }
  | {
      status: 'executed'
      output: Record<string, unknown>
    }

export type ConnectorAuthorizationResult = Exclude<ConnectorExecutionResult, { status: 'executed' }>
  | {
      status: 'authorized'
      requestHash: string
      preparationId: string
    }

export interface InternalPreparedInvocation {
  preparationId: string
  pack: PriorityConnectorPack
  sessionId: string
  operationId: string
  request: CapabilityOperationRequest
  payload: Record<string, unknown>
  privacy?: PreparedStructuredEgress
  resourceId?: string
  idempotencyKey?: string
  authorization?: ConnectorCapabilityAuthorization
}

export interface ConnectorExecutionRuntimeOptions {
  workspaceId: string
  registry: DurableConnectorPackRegistry
  broker: CapabilityBroker
  secretLeaseBroker: SecretLeaseBroker
  proofIssuer: ExecutionProofIssuer
  capabilityUseLedger: DurableUseLedger
  connectors: readonly PriorityConnectorRuntimeConfiguration[]
  transport: ConnectorHttpTransport
  resolveSecretValue: (request: ConnectorSecretValueRequest) => Promise<string | null>
  reconcileMutation: ConnectorMutationReconciler
  recordExecutionProof: (record: ConnectorProofRecord) => void
  egressFirewall?: StructuredEgressFirewall
  recordPrivacyReceipt?: (record: ConnectorPrivacyReceiptRecord) => void
  storeEgressVaultEntries?: (entries: readonly EgressVaultEntry[]) => void
  nowMs?: () => number
  generateId?: () => string
}

export interface CreateWorkspaceConnectorExecutionRuntimeInput {
  workspaceId: string
  policy: CapabilityPolicy
  registry: DurableConnectorPackRegistry
  capabilityUseLedgerPath: string
  connectors: readonly PriorityConnectorRuntimeConfiguration[]
  transport: ConnectorHttpTransport
  resolveSecretValue: (request: ConnectorSecretValueRequest) => Promise<string | null>
  reconcileMutation: ConnectorMutationReconciler
  recordExecutionProof: (record: ConnectorProofRecord) => void
  recordPrivacyReceipt?: (record: ConnectorPrivacyReceiptRecord) => void
  storeEgressVaultEntries?: (entries: readonly EgressVaultEntry[]) => void
  credentialStore?: GovernanceCredentialStore
  nowMs?: () => number
  generateId?: () => string
}
