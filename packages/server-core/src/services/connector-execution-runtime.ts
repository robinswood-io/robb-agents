import { AsyncLocalStorage } from 'node:async_hooks'
import {
  connectorPackTemplates,
  createPriorityConnectorDriver,
  priorityConnectorDriverDefinitions,
  type ConnectorCapabilityAuthorization,
  type ConnectorHttpTransport,
  type ConnectorMutationReconciler,
  type HttpConnectorPackDriver,
  type PriorityConnectorPack,
} from '@craft-agent/shared/connectors'
import {
  SecretLeaseBroker,
  type SecretLeaseConsumptionRequest,
} from '@craft-agent/shared/credentials'
import {
  CapabilityBroker,
  CapabilityOperationRequestSchema,
  DurableUseLedger,
  ExecutionProofIssuer,
  type AutonomyLevel,
  type CapabilityApprovalRequest,
  type CapabilityBrokerDenialCode,
  type CapabilityOperationRequest,
  type CapabilityPolicy,
  type OperationBudgetEstimate,
  type OperationCompensation,
  type OperationIdentity,
  type SignedExecutionProof,
} from '@craft-agent/shared/governance'
import type { DurableConnectorPackRegistry } from '@craft-agent/shared/connectors'
import {
  loadWorkspaceGovernanceSigningKey,
  type GovernanceCredentialStore,
} from '../tasks/execution-proof-runtime'

const CAPABILITY_KEY_PURPOSE = 'connector-capability-v1'
const SECRET_LEASE_KEY_PURPOSE = 'connector-secret-lease-v1'
const EXECUTION_PROOF_KEY_PURPOSE = 'execution-proof-v1'

export interface PriorityConnectorRuntimeConfiguration {
  pack: PriorityConnectorPack
  secretReference: string
  secretName: string
  baseUrl?: string
  healthIdentity?: Omit<OperationIdentity, 'workspaceId' | 'connectorId'>
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

interface InternalPreparedInvocation {
  preparationId: string
  pack: PriorityConnectorPack
  sessionId: string
  operationId: string
  request: CapabilityOperationRequest
  payload: Record<string, unknown>
  resourceId?: string
  idempotencyKey?: string
}

interface ConnectorExecutionRuntimeOptions {
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
  credentialStore?: GovernanceCredentialStore
  nowMs?: () => number
  generateId?: () => string
}

/**
 * Host-only connector choke point. It owns authorization, one-time capability
 * consumption, value-free secret leases, registry admission, reconciliation,
 * and proof routing. None of these seams are renderer or model APIs.
 */
export class ConnectorExecutionRuntime {
  private readonly configurations = new Map<PriorityConnectorPack, PriorityConnectorRuntimeConfiguration>()
  private readonly drivers = new Map<PriorityConnectorPack, HttpConnectorPackDriver>()
  private readonly prepared = new Map<string, InternalPreparedInvocation>()
  private readonly invocationContext = new AsyncLocalStorage<{ sessionId: string }>()
  private readonly nowMs: () => number
  private readonly generateId: () => string

  constructor(private readonly options: ConnectorExecutionRuntimeOptions) {
    if (!options.workspaceId.trim()) throw new Error('Connector runtime workspace is required')
    for (const configuration of options.connectors) {
      if (this.configurations.has(configuration.pack)) {
        throw new Error(`Duplicate connector runtime configuration for ${configuration.pack}`)
      }
      this.configurations.set(configuration.pack, { ...configuration })
    }
    this.nowMs = options.nowMs ?? Date.now
    this.generateId = options.generateId ?? crypto.randomUUID
    this.syncPolicyEpoch()
  }

  prepare(input: PrepareConnectorInvocationInput): PreparedConnectorInvocation {
    this.syncPolicyEpoch()
    const configuration = this.requireConfiguration(input.pack)
    const manifest = connectorPackTemplates[input.pack]
    const admission = this.options.registry.assertOperationAllowed(manifest.id, input.operationId)
    if (!admission.operation.targetResourceTypes.includes(input.resourceType)) {
      throw new Error(`Resource type ${input.resourceType} is not allowed for ${input.operationId}`)
    }
    const baseUrl = this.baseUrl(input.pack, configuration)
    const policy = this.options.broker.snapshotPolicy()
    const compensation = input.compensation ?? admission.operation.compensation
    const request = CapabilityOperationRequestSchema.parse({
      schemaVersion: 1,
      operationId: input.operationId,
      risk: admission.operation.risk,
      autonomy: input.autonomy,
      identity: {
        ...input.identity,
        workspaceId: this.options.workspaceId,
        connectorId: manifest.id,
      },
      target: {
        resourceType: input.resourceType,
        ...(input.resourceId ? { resourceId: input.resourceId } : {}),
        origin: new URL(baseUrl).origin,
      },
      payload: structuredClone(input.payload),
      policyVersion: policy.policyVersion,
      authorizationGeneration: admission.authorizationGeneration,
      requestedAt: new Date(this.nowMs()).toISOString(),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
      ...(compensation ? { compensation } : {}),
    })
    const preparationId = this.generateId()
    const internal: InternalPreparedInvocation = {
      preparationId,
      pack: input.pack,
      sessionId: input.sessionId,
      operationId: input.operationId,
      request,
      payload: structuredClone(input.payload),
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    }
    this.prepared.set(preparationId, internal)
    return { preparationId, request: structuredClone(request) }
  }

  async execute(preparationId: string, approvalId?: string): Promise<ConnectorExecutionResult> {
    const prepared = this.prepared.get(preparationId)
    if (!prepared) throw new Error('Prepared connector invocation is unknown or already consumed')
    this.syncPolicyEpoch()
    const decision = this.options.broker.authorize(prepared.request, approvalId)
    if (decision.status === 'approval-required') {
      return {
        status: 'approval-required',
        approval: decision.approval,
        requestHash: decision.requestHash,
        preparationId,
      }
    }
    if (decision.status === 'denied') {
      this.prepared.delete(preparationId)
      return decision
    }

    const driver = this.driver(prepared.pack)
    const authorization: ConnectorCapabilityAuthorization = {
      request: prepared.request,
      capability: decision.capability,
    }
    try {
      const output = await this.invocationContext.run(
        { sessionId: prepared.sessionId },
        () => driver.invoke(prepared.operationId, {
          payload: structuredClone(prepared.payload),
          ...(prepared.resourceId ? { resourceId: prepared.resourceId } : {}),
          ...(prepared.idempotencyKey ? { idempotencyKey: prepared.idempotencyKey } : {}),
          authorization,
        }),
      )
      return { status: 'executed', output }
    } finally {
      this.prepared.delete(preparationId)
    }
  }

  resolveApproval(
    approvalId: string,
    decision: 'approved' | 'denied',
    resolvedBy: string,
  ): ReturnType<CapabilityBroker['resolveApproval']> {
    return this.options.broker.resolveApproval(approvalId, decision, resolvedBy)
  }

  updatePolicy(next: CapabilityPolicy): CapabilityPolicy {
    if (next.workspaceId !== this.options.workspaceId) {
      throw new Error('Connector runtime policy workspace cannot change')
    }
    return this.options.broker.updatePolicy({
      ...next,
      authorizationGeneration: this.options.registry.snapshot().generation,
    })
  }

  setKillSwitch(
    scope: 'global' | 'workspace' | 'mission' | 'connector',
    active: boolean,
    id?: string,
  ): void {
    this.options.broker.setKillSwitch(scope, active, id)
  }

  async healthCheck(pack: PriorityConnectorPack): Promise<{ healthy: boolean; latencyMs: number }> {
    return this.invocationContext.run(
      { sessionId: `connector-health:${pack}` },
      () => this.driver(pack).healthCheck(),
    )
  }

  private driver(pack: PriorityConnectorPack): HttpConnectorPackDriver {
    const existing = this.drivers.get(pack)
    if (existing) return existing
    const configuration = this.requireConfiguration(pack)
    const manifest = connectorPackTemplates[pack]
    const driver = createPriorityConnectorDriver(pack, {
      baseUrl: this.baseUrl(pack, configuration),
      secretReference: configuration.secretReference,
      transport: this.options.transport,
      resolveSecret: async (_reference, request) => this.resolveSecret(pack, configuration, request),
      consumeCapability: (capability, request) => {
        const decision = this.options.broker.consume(capability, request)
        if (!decision.allowed) return decision
        try {
          if (this.options.capabilityUseLedger.claim(capability.capabilityId, capability.expiresAt)) {
            return decision
          }
        } catch {
          return {
            allowed: false,
            code: 'CAPABILITY_INVALID',
            reason: 'Durable capability replay state is unavailable',
            requestHash: decision.requestHash,
          }
        }
        return {
          allowed: false,
          code: 'CAPABILITY_ALREADY_USED',
          reason: 'Capability was already consumed by another runtime process',
          requestHash: decision.requestHash,
        }
      },
      consumeSecretLease: (grant, request) => this.options.secretLeaseBroker.consume(grant, request),
      assertRuntimeAdmission: (packId, operationId, expectedHash) => (
        this.options.registry.assertOperationAllowed(packId, operationId, expectedHash)
      ),
      reconcileMutation: this.options.reconcileMutation,
      issueExecutionProof: (request) => this.options.proofIssuer.issue(request),
      recordExecutionProof: (proof) => {
        const context = this.invocationContext.getStore()
        if (!context) throw new Error('Connector execution proof has no host session binding')
        this.options.recordExecutionProof({ sessionId: context.sessionId, proof })
      },
      createHealthAuthorization: () => this.createHealthAuthorization(pack, configuration),
      now: () => new Date(this.nowMs()).toISOString(),
    })
    this.drivers.set(pack, driver)
    return driver
  }

  private async resolveSecret(
    pack: PriorityConnectorPack,
    configuration: PriorityConnectorRuntimeConfiguration,
    request: SecretLeaseConsumptionRequest,
  ) {
    const manifest = connectorPackTemplates[pack]
    if (
      request.secretReference !== configuration.secretReference
      || request.identity.workspaceId !== this.options.workspaceId
      || request.identity.sourceId !== manifest.id
      || request.identity.connectorId !== manifest.id
    ) {
      return null
    }
    const admission = this.options.registry.assertOperationAllowed(manifest.id, request.operationId)
    if (admission.authorizationGeneration !== request.authorizationGeneration) return null
    const value = await this.options.resolveSecretValue({
      workspaceId: this.options.workspaceId,
      packId: manifest.id,
      secretReference: configuration.secretReference,
      secretName: configuration.secretName,
    })
    if (value === null) return null
    const grant = this.options.secretLeaseBroker.issue({
      secretReference: configuration.secretReference,
      secretName: configuration.secretName,
      identity: request.identity,
      operationId: request.operationId,
      scopes: [...request.scopes],
      authorizationGeneration: request.authorizationGeneration,
      ttlMs: 30_000,
      maxUses: 1,
    })
    return { grant, value }
  }

  private createHealthAuthorization(
    pack: PriorityConnectorPack,
    configuration: PriorityConnectorRuntimeConfiguration,
  ): ConnectorCapabilityAuthorization {
    this.syncPolicyEpoch()
    const manifest = connectorPackTemplates[pack]
    const operationId = manifest.healthCheck.operationId
    const admission = this.options.registry.assertOperationAllowed(manifest.id, operationId)
    const policy = this.options.broker.snapshotPolicy()
    const identity = configuration.healthIdentity ?? {
      clientId: 'robb-agents-host',
      missionId: `connector-health:${manifest.id}`,
      agentId: 'connector-health-monitor',
      actorId: 'robb-agents-host',
    }
    const request = CapabilityOperationRequestSchema.parse({
      schemaVersion: 1,
      operationId,
      risk: admission.operation.risk,
      autonomy: 'A0',
      identity: {
        ...identity,
        workspaceId: this.options.workspaceId,
        connectorId: manifest.id,
      },
      target: {
        resourceType: 'connector-health',
        origin: new URL(this.baseUrl(pack, configuration)).origin,
      },
      payload: {},
      policyVersion: policy.policyVersion,
      authorizationGeneration: admission.authorizationGeneration,
      requestedAt: new Date(this.nowMs()).toISOString(),
    })
    const decision = this.options.broker.authorize(request)
    if (decision.status !== 'authorized') {
      throw new Error(`Connector health authorization failed: ${decision.status}`)
    }
    return { request, capability: decision.capability }
  }

  private syncPolicyEpoch(): void {
    const generation = this.options.registry.snapshot().generation
    const policy = this.options.broker.snapshotPolicy()
    if (policy.authorizationGeneration === generation) return
    if (generation < policy.authorizationGeneration) {
      throw new Error('Connector registry generation moved backwards')
    }
    this.options.broker.updatePolicy({
      ...policy,
      policyVersion: policy.policyVersion + 1,
      authorizationGeneration: generation,
    })
  }

  private requireConfiguration(pack: PriorityConnectorPack): PriorityConnectorRuntimeConfiguration {
    const configuration = this.configurations.get(pack)
    if (!configuration) throw new Error(`Connector runtime is not configured for ${pack}`)
    return configuration
  }

  private baseUrl(
    pack: PriorityConnectorPack,
    configuration: PriorityConnectorRuntimeConfiguration,
  ): string {
    const baseUrl = configuration.baseUrl ?? priorityConnectorDriverDefinitions[pack].defaultBaseUrl
    if (!baseUrl) throw new Error(`Connector ${pack} requires an explicit base URL`)
    return baseUrl
  }
}

export async function createWorkspaceConnectorExecutionRuntime(
  input: CreateWorkspaceConnectorExecutionRuntimeInput,
): Promise<ConnectorExecutionRuntime> {
  if (input.policy.workspaceId !== input.workspaceId) {
    throw new Error('Connector runtime policy workspace does not match')
  }
  const [capabilityKey, leaseKey, proofKey] = await Promise.all([
    loadWorkspaceGovernanceSigningKey(input.workspaceId, CAPABILITY_KEY_PURPOSE, input.credentialStore),
    loadWorkspaceGovernanceSigningKey(input.workspaceId, SECRET_LEASE_KEY_PURPOSE, input.credentialStore),
    loadWorkspaceGovernanceSigningKey(input.workspaceId, EXECUTION_PROOF_KEY_PURPOSE, input.credentialStore),
  ])
  const nowMs = input.nowMs ?? Date.now
  const generation = input.registry.snapshot().generation
  const broker = new CapabilityBroker({
    policy: { ...input.policy, authorizationGeneration: generation },
    signingKey: capabilityKey,
    nowMs,
    generateId: input.generateId,
  })
  const secretLeaseBroker = new SecretLeaseBroker({
    signingKey: leaseKey,
    currentAuthorizationGeneration: () => input.registry.snapshot().generation,
    nowMs,
    generateId: input.generateId,
  })
  const proofIssuer = new ExecutionProofIssuer({
    signingKey: proofKey,
    now: () => new Date(nowMs()).toISOString(),
    generateId: input.generateId,
  })
  return new ConnectorExecutionRuntime({
    workspaceId: input.workspaceId,
    registry: input.registry,
    broker,
    secretLeaseBroker,
    proofIssuer,
    capabilityUseLedger: new DurableUseLedger(
      input.capabilityUseLedgerPath,
      () => new Date(nowMs()),
    ),
    connectors: input.connectors,
    transport: input.transport,
    resolveSecretValue: input.resolveSecretValue,
    reconcileMutation: input.reconcileMutation,
    recordExecutionProof: input.recordExecutionProof,
    nowMs,
    generateId: input.generateId,
  })
}
