import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export const OPERATION_RISK_LEVELS = ['R0', 'R1', 'W1', 'W2', 'W3'] as const
export const AUTONOMY_LEVELS = ['A0', 'A1', 'A2', 'A3', 'A4'] as const

export const OperationRiskLevelSchema = z.enum(OPERATION_RISK_LEVELS)
export const AutonomyLevelSchema = z.enum(AUTONOMY_LEVELS)

export type OperationRiskLevel = z.infer<typeof OperationRiskLevelSchema>
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>

const RISK_RANK: Record<OperationRiskLevel, number> = {
  R0: 0,
  R1: 1,
  W1: 2,
  W2: 3,
  W3: 4,
}

const AUTONOMY_MAX_RISK: Record<AutonomyLevel, OperationRiskLevel> = {
  A0: 'R0',
  A1: 'R1',
  A2: 'W1',
  A3: 'W2',
  A4: 'W3',
}

const OperationIdentitySchema = z.object({
  clientId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  missionId: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  actorId: z.string().trim().min(1),
  connectorId: z.string().trim().min(1).optional(),
}).strict()

const OperationTargetSchema = z.object({
  resourceType: z.string().trim().min(1),
  resourceId: z.string().trim().min(1).optional(),
  origin: z.string().url().optional(),
}).strict()

const OperationBudgetEstimateSchema = z.object({
  tokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  wallTimeMs: z.number().int().positive().optional(),
}).strict()

const OperationCompensationSchema = z.object({
  strategy: z.enum(['inverse-operation', 'restore-snapshot', 'manual']),
  operationId: z.string().trim().min(1).optional(),
}).strict()

export const CapabilityOperationRequestSchema = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string().trim().min(1),
  risk: OperationRiskLevelSchema,
  autonomy: AutonomyLevelSchema,
  identity: OperationIdentitySchema,
  target: OperationTargetSchema,
  payload: z.record(z.string(), z.unknown()),
  policyVersion: z.number().int().positive(),
  authorizationGeneration: z.number().int().nonnegative(),
  requestedAt: z.string().datetime(),
  idempotencyKey: z.string().trim().min(1).optional(),
  budget: OperationBudgetEstimateSchema.optional(),
  compensation: OperationCompensationSchema.optional(),
}).strict()

export const CapabilityPolicySchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: z.string().trim().min(1),
  policyVersion: z.number().int().positive(),
  authorizationGeneration: z.number().int().nonnegative(),
  enabled: z.boolean(),
  maxRisk: OperationRiskLevelSchema,
  allowedOperations: z.array(z.string().trim().min(1)).min(1),
  allowedOrigins: z.array(z.string().url()),
  allowedResourceTypes: z.array(z.string().trim().min(1)).min(1),
  approvalRequiredFor: z.array(OperationRiskLevelSchema),
  maxRequestAgeMs: z.number().int().positive().max(3_600_000).default(300_000),
  capabilityTtlMs: z.number().int().min(1_000).max(300_000).default(60_000),
  approvalTtlMs: z.number().int().min(10_000).max(600_000).default(120_000),
  expiresAt: z.string().datetime().optional(),
  budgets: z.object({
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().optional(),
    maxWallTimeMs: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict()

export type OperationIdentity = z.infer<typeof OperationIdentitySchema>
export type OperationTarget = z.infer<typeof OperationTargetSchema>
export type OperationBudgetEstimate = z.infer<typeof OperationBudgetEstimateSchema>
export type OperationCompensation = z.infer<typeof OperationCompensationSchema>
export type CapabilityOperationRequest = z.infer<typeof CapabilityOperationRequestSchema>
export type CapabilityPolicy = z.infer<typeof CapabilityPolicySchema>

export interface CapabilityApprovalRequest {
  approvalId: string
  requestHash: string
  operationId: string
  risk: OperationRiskLevel
  actorId: string
  workspaceId: string
  missionId: string
  createdAt: string
  expiresAt: string
}

export interface CapabilityApprovalReceipt {
  approvalId: string
  requestHash: string
  approvedBy: string
  policyVersion: number
  authorizationGeneration: number
  approvedAt: string
  expiresAt: string
}

export const OperationCapabilitySchema = z.object({
  schemaVersion: z.literal(1),
  capabilityId: z.string().trim().min(1),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  operationId: z.string().trim().min(1),
  risk: OperationRiskLevelSchema,
  identity: OperationIdentitySchema,
  target: OperationTargetSchema,
  policyVersion: z.number().int().positive(),
  authorizationGeneration: z.number().int().nonnegative(),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  oneTime: z.literal(true),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict()

export type OperationCapability = z.infer<typeof OperationCapabilitySchema>

export type CapabilityBrokerDenialCode =
  | 'POLICY_DISABLED'
  | 'POLICY_EXPIRED'
  | 'POLICY_VERSION_MISMATCH'
  | 'AUTHORIZATION_GENERATION_MISMATCH'
  | 'WORKSPACE_MISMATCH'
  | 'OPERATION_DENIED'
  | 'ORIGIN_DENIED'
  | 'RESOURCE_DENIED'
  | 'RISK_DENIED'
  | 'AUTONOMY_DENIED'
  | 'BUDGET_DENIED'
  | 'IDEMPOTENCY_REQUIRED'
  | 'COMPENSATION_REQUIRED'
  | 'REQUEST_EXPIRED'
  | 'KILL_SWITCH_ACTIVE'
  | 'APPROVAL_INVALID'
  | 'SEPARATION_OF_DUTIES_REQUIRED'
  | 'CAPABILITY_INVALID'
  | 'CAPABILITY_EXPIRED'
  | 'CAPABILITY_ALREADY_USED'

export type CapabilityBrokerDecision =
  | { status: 'denied'; code: CapabilityBrokerDenialCode; reason: string; requestHash: string }
  | { status: 'approval-required'; approval: CapabilityApprovalRequest; requestHash: string }
  | { status: 'authorized'; capability: OperationCapability; requestHash: string }

export type CapabilityConsumptionDecision =
  | { allowed: true; capabilityId: string; requestHash: string }
  | { allowed: false; code: CapabilityBrokerDenialCode; reason: string; requestHash: string }

export interface CapabilityBrokerEvent {
  sequence: number
  kind:
    | 'authorization-denied'
    | 'approval-requested'
    | 'approval-approved'
    | 'approval-denied'
    | 'capability-issued'
    | 'capability-consumed'
    | 'capability-rejected'
    | 'policy-updated'
    | 'kill-switch-changed'
  timestamp: string
  requestHash?: string
  capabilityId?: string
  approvalId?: string
  operationId?: string
  workspaceId?: string
  missionId?: string
  code?: CapabilityBrokerDenialCode
}

interface PendingApproval {
  request: CapabilityOperationRequest
  approval: CapabilityApprovalRequest
}

interface ApprovedRequest {
  request: CapabilityOperationRequest
  receipt: CapabilityApprovalReceipt
}

interface UnsignedOperationCapability extends Omit<OperationCapability, 'token'> {}

interface CapabilityKillSwitches {
  global: boolean
  workspaceIds: Set<string>
  missionIds: Set<string>
  connectorIds: Set<string>
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    )
  }
  return value
}

export function canonicalOperationValue(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

export function operationValueHash(value: unknown): string {
  return createHash('sha256').update(canonicalOperationValue(value), 'utf8').digest('hex')
}

export function capabilityOperationRequestHash(request: CapabilityOperationRequest): string {
  return operationValueHash(CapabilityOperationRequestSchema.parse(request))
}

export function parseCapabilityOperationRequest(value: unknown): CapabilityOperationRequest {
  return CapabilityOperationRequestSchema.parse(value)
}

export function parseOperationCapability(value: unknown): OperationCapability {
  return OperationCapabilitySchema.parse(value)
}

function requiresIdempotency(risk: OperationRiskLevel): boolean {
  return risk === 'W1' || risk === 'W2' || risk === 'W3'
}

function requiresCompensation(risk: OperationRiskLevel): boolean {
  return risk === 'W2' || risk === 'W3'
}

export class CapabilityBroker {
  private policy: CapabilityPolicy
  private readonly signingKey: Buffer
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly approvedRequests = new Map<string, ApprovedRequest>()
  private readonly consumedCapabilities = new Set<string>()
  private readonly events: CapabilityBrokerEvent[] = []
  private readonly killSwitches: CapabilityKillSwitches = {
    global: false,
    workspaceIds: new Set(),
    missionIds: new Set(),
    connectorIds: new Set(),
  }
  private eventSequence = 0

  constructor(input: {
    policy: CapabilityPolicy
    signingKey: string | Uint8Array
    nowMs?: () => number
    generateId?: () => string
    onEvent?: (event: CapabilityBrokerEvent) => void
  }) {
    this.policy = CapabilityPolicySchema.parse(input.policy)
    this.signingKey = Buffer.from(input.signingKey)
    if (this.signingKey.byteLength < 32) {
      throw new Error('Capability broker signing key must contain at least 32 bytes')
    }
    this.nowMs = input.nowMs ?? Date.now
    this.generateId = input.generateId ?? randomUUID
    this.onEvent = input.onEvent
  }

  private readonly nowMs: () => number
  private readonly generateId: () => string
  private readonly onEvent: ((event: CapabilityBrokerEvent) => void) | undefined

  updatePolicy(nextValue: CapabilityPolicy): CapabilityPolicy {
    const next = CapabilityPolicySchema.parse(nextValue)
    if (next.workspaceId !== this.policy.workspaceId) {
      throw new Error('Capability policy workspace cannot change')
    }
    if (next.policyVersion <= this.policy.policyVersion) {
      throw new Error('Capability policy version must increase monotonically')
    }
    if (next.authorizationGeneration < this.policy.authorizationGeneration) {
      throw new Error('Authorization generation cannot decrease')
    }
    this.policy = next
    this.pendingApprovals.clear()
    this.approvedRequests.clear()
    this.emit({ kind: 'policy-updated', workspaceId: next.workspaceId })
    return { ...next }
  }

  setKillSwitch(
    scope: 'global' | 'workspace' | 'mission' | 'connector',
    active: boolean,
    id?: string,
  ): void {
    if (scope === 'global') {
      this.killSwitches.global = active
    } else {
      if (!id?.trim()) throw new Error(`${scope} kill switch requires an identifier`)
      const target = scope === 'workspace'
        ? this.killSwitches.workspaceIds
        : scope === 'mission'
          ? this.killSwitches.missionIds
          : this.killSwitches.connectorIds
      if (active) target.add(id)
      else target.delete(id)
    }
    this.emit({ kind: 'kill-switch-changed', workspaceId: this.policy.workspaceId })
  }

  authorize(requestValue: CapabilityOperationRequest, approvalId?: string): CapabilityBrokerDecision {
    const request = CapabilityOperationRequestSchema.parse(requestValue)
    const requestHash = capabilityOperationRequestHash(request)
    const denial = this.evaluateRequest(request, requestHash)
    if (denial) return denial

    if (this.approvalRequired(request.risk)) {
      if (!approvalId) return this.createApprovalRequest(request, requestHash)
      const approved = this.approvedRequests.get(approvalId)
      if (!approved || approved.receipt.requestHash !== requestHash) {
        return this.deny(request, requestHash, 'APPROVAL_INVALID', 'Approval is missing or bound to another request')
      }
      if (
        approved.receipt.policyVersion !== this.policy.policyVersion
        || approved.receipt.authorizationGeneration !== this.policy.authorizationGeneration
        || Date.parse(approved.receipt.expiresAt) <= this.nowMs()
      ) {
        this.approvedRequests.delete(approvalId)
        return this.deny(request, requestHash, 'APPROVAL_INVALID', 'Approval is expired or bound to stale policy state')
      }
      this.approvedRequests.delete(approvalId)
    }

    const capability = this.issueCapability(request, requestHash)
    this.emit({
      kind: 'capability-issued',
      requestHash,
      capabilityId: capability.capabilityId,
      operationId: request.operationId,
      workspaceId: request.identity.workspaceId,
      missionId: request.identity.missionId,
    })
    return { status: 'authorized', capability, requestHash }
  }

  resolveApproval(
    approvalId: string,
    decision: 'approved' | 'denied',
    resolvedBy: string,
  ): { status: 'approved'; receipt: CapabilityApprovalReceipt } | { status: 'denied'; reason: string } {
    const pending = this.pendingApprovals.get(approvalId)
    if (!pending) return { status: 'denied', reason: 'Approval request is not pending' }
    this.pendingApprovals.delete(approvalId)
    if (Date.parse(pending.approval.expiresAt) <= this.nowMs()) {
      return { status: 'denied', reason: 'Approval request expired' }
    }
    if (!resolvedBy.trim()) return { status: 'denied', reason: 'Approver identity is required' }
    if (decision === 'denied') {
      this.emit({
        kind: 'approval-denied',
        approvalId,
        requestHash: pending.approval.requestHash,
        operationId: pending.request.operationId,
        workspaceId: pending.request.identity.workspaceId,
        missionId: pending.request.identity.missionId,
      })
      return { status: 'denied', reason: 'Approval denied' }
    }
    if (pending.request.risk === 'W3' && resolvedBy === pending.request.identity.actorId) {
      return { status: 'denied', reason: 'W3 operations require separation of duties' }
    }
    const approvedAt = new Date(this.nowMs()).toISOString()
    const receipt: CapabilityApprovalReceipt = {
      approvalId,
      requestHash: pending.approval.requestHash,
      approvedBy: resolvedBy,
      policyVersion: this.policy.policyVersion,
      authorizationGeneration: this.policy.authorizationGeneration,
      approvedAt,
      expiresAt: pending.approval.expiresAt,
    }
    this.approvedRequests.set(approvalId, { request: pending.request, receipt })
    this.emit({
      kind: 'approval-approved',
      approvalId,
      requestHash: receipt.requestHash,
      operationId: pending.request.operationId,
      workspaceId: pending.request.identity.workspaceId,
      missionId: pending.request.identity.missionId,
    })
    return { status: 'approved', receipt }
  }

  consume(
    capabilityValue: OperationCapability,
    requestValue: CapabilityOperationRequest,
  ): CapabilityConsumptionDecision {
    const request = CapabilityOperationRequestSchema.parse(requestValue)
    const requestHash = capabilityOperationRequestHash(request)
    let capability: OperationCapability
    try {
      capability = OperationCapabilitySchema.parse(capabilityValue)
    } catch {
      return this.rejectCapability(request, requestHash, 'CAPABILITY_INVALID', 'Capability shape is invalid')
    }
    const { token, ...unsigned } = capability
    if (!this.verifyToken(unsigned, token) || capability.requestHash !== requestHash) {
      return this.rejectCapability(request, requestHash, 'CAPABILITY_INVALID', 'Capability signature or request binding is invalid')
    }
    if (Date.parse(capability.expiresAt) <= this.nowMs()) {
      return this.rejectCapability(request, requestHash, 'CAPABILITY_EXPIRED', 'Capability expired')
    }
    if (this.consumedCapabilities.has(capability.capabilityId)) {
      return this.rejectCapability(request, requestHash, 'CAPABILITY_ALREADY_USED', 'Capability was already consumed')
    }
    const denial = this.evaluateRequest(request, requestHash)
    if (denial) {
      return { allowed: false, code: denial.code, reason: denial.reason, requestHash }
    }
    if (
      capability.policyVersion !== this.policy.policyVersion
      || capability.authorizationGeneration !== this.policy.authorizationGeneration
    ) {
      return this.rejectCapability(request, requestHash, 'CAPABILITY_INVALID', 'Capability is bound to stale policy state')
    }
    this.consumedCapabilities.add(capability.capabilityId)
    this.emit({
      kind: 'capability-consumed',
      requestHash,
      capabilityId: capability.capabilityId,
      operationId: request.operationId,
      workspaceId: request.identity.workspaceId,
      missionId: request.identity.missionId,
    })
    return { allowed: true, capabilityId: capability.capabilityId, requestHash }
  }

  listEvents(): CapabilityBrokerEvent[] {
    return this.events.map((event) => ({ ...event }))
  }

  private evaluateRequest(
    request: CapabilityOperationRequest,
    requestHash: string,
  ): Extract<CapabilityBrokerDecision, { status: 'denied' }> | null {
    if (!this.policy.enabled) return this.deny(request, requestHash, 'POLICY_DISABLED', 'Capability policy is disabled')
    if (this.policy.expiresAt && Date.parse(this.policy.expiresAt) <= this.nowMs()) {
      return this.deny(request, requestHash, 'POLICY_EXPIRED', 'Capability policy expired')
    }
    if (request.policyVersion !== this.policy.policyVersion) {
      return this.deny(request, requestHash, 'POLICY_VERSION_MISMATCH', 'Request policy version is stale')
    }
    if (request.authorizationGeneration !== this.policy.authorizationGeneration) {
      return this.deny(request, requestHash, 'AUTHORIZATION_GENERATION_MISMATCH', 'Authorization generation is stale')
    }
    if (request.identity.workspaceId !== this.policy.workspaceId) {
      return this.deny(request, requestHash, 'WORKSPACE_MISMATCH', 'Request belongs to another workspace')
    }
    if (this.killSwitchActive(request)) {
      return this.deny(request, requestHash, 'KILL_SWITCH_ACTIVE', 'A capability kill switch is active')
    }
    if (!this.policy.allowedOperations.includes('*') && !this.policy.allowedOperations.includes(request.operationId)) {
      return this.deny(request, requestHash, 'OPERATION_DENIED', 'Operation is not allowlisted')
    }
    if (
      !this.policy.allowedResourceTypes.includes('*')
      && !this.policy.allowedResourceTypes.includes(request.target.resourceType)
    ) {
      return this.deny(request, requestHash, 'RESOURCE_DENIED', 'Resource type is not allowlisted')
    }
    if (request.target.origin && !this.policy.allowedOrigins.includes(request.target.origin)) {
      return this.deny(request, requestHash, 'ORIGIN_DENIED', 'Target origin is not allowlisted')
    }
    if (RISK_RANK[request.risk] > RISK_RANK[this.policy.maxRisk]) {
      return this.deny(request, requestHash, 'RISK_DENIED', 'Operation risk exceeds policy')
    }
    if (RISK_RANK[request.risk] > RISK_RANK[AUTONOMY_MAX_RISK[request.autonomy]]) {
      return this.deny(request, requestHash, 'AUTONOMY_DENIED', 'Operation risk exceeds the autonomy mandate')
    }
    const requestedAtMs = Date.parse(request.requestedAt)
    if (
      !Number.isFinite(requestedAtMs)
      || requestedAtMs > this.nowMs() + 30_000
      || this.nowMs() - requestedAtMs > this.policy.maxRequestAgeMs
    ) {
      return this.deny(request, requestHash, 'REQUEST_EXPIRED', 'Operation request is outside the accepted time window')
    }
    if (requiresIdempotency(request.risk) && !request.idempotencyKey) {
      return this.deny(request, requestHash, 'IDEMPOTENCY_REQUIRED', 'Mutating operations require an idempotency key')
    }
    if (requiresCompensation(request.risk) && !request.compensation) {
      return this.deny(request, requestHash, 'COMPENSATION_REQUIRED', 'High-impact operations require a compensation plan')
    }
    const budgetReason = this.budgetDenial(request.budget)
    if (budgetReason) return this.deny(request, requestHash, 'BUDGET_DENIED', budgetReason)
    return null
  }

  private budgetDenial(estimate: OperationBudgetEstimate | undefined): string | null {
    const budgets = this.policy.budgets
    if (!budgets || !estimate) return null
    if (budgets.maxTokens !== undefined && (estimate.tokens ?? 0) > budgets.maxTokens) {
      return 'Estimated token usage exceeds policy budget'
    }
    if (budgets.maxCostUsd !== undefined && (estimate.costUsd ?? 0) > budgets.maxCostUsd) {
      return 'Estimated cost exceeds policy budget'
    }
    if (budgets.maxWallTimeMs !== undefined && (estimate.wallTimeMs ?? 0) > budgets.maxWallTimeMs) {
      return 'Estimated duration exceeds policy budget'
    }
    return null
  }

  private approvalRequired(risk: OperationRiskLevel): boolean {
    return risk === 'W3' || this.policy.approvalRequiredFor.includes(risk)
  }

  private createApprovalRequest(
    request: CapabilityOperationRequest,
    requestHash: string,
  ): CapabilityBrokerDecision {
    const approvalId = this.generateId()
    const createdAt = new Date(this.nowMs()).toISOString()
    const approval: CapabilityApprovalRequest = {
      approvalId,
      requestHash,
      operationId: request.operationId,
      risk: request.risk,
      actorId: request.identity.actorId,
      workspaceId: request.identity.workspaceId,
      missionId: request.identity.missionId,
      createdAt,
      expiresAt: new Date(this.nowMs() + this.policy.approvalTtlMs).toISOString(),
    }
    this.pendingApprovals.set(approvalId, { request, approval })
    this.emit({
      kind: 'approval-requested',
      approvalId,
      requestHash,
      operationId: request.operationId,
      workspaceId: request.identity.workspaceId,
      missionId: request.identity.missionId,
    })
    return { status: 'approval-required', approval, requestHash }
  }

  private issueCapability(
    request: CapabilityOperationRequest,
    requestHash: string,
  ): OperationCapability {
    const issuedAtMs = this.nowMs()
    const unsigned: UnsignedOperationCapability = {
      schemaVersion: 1,
      capabilityId: this.generateId(),
      requestHash,
      operationId: request.operationId,
      risk: request.risk,
      identity: request.identity,
      target: request.target,
      policyVersion: request.policyVersion,
      authorizationGeneration: request.authorizationGeneration,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(issuedAtMs + this.policy.capabilityTtlMs).toISOString(),
      oneTime: true,
    }
    return { ...unsigned, token: this.sign(unsigned) }
  }

  private sign(capability: UnsignedOperationCapability): string {
    return createHmac('sha256', this.signingKey)
      .update(canonicalOperationValue(capability), 'utf8')
      .digest('base64url')
  }

  private verifyToken(capability: UnsignedOperationCapability, token: string): boolean {
    const actual = Buffer.from(token, 'base64url')
    const expected = Buffer.from(this.sign(capability), 'base64url')
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
  }

  private killSwitchActive(request: CapabilityOperationRequest): boolean {
    return this.killSwitches.global
      || this.killSwitches.workspaceIds.has(request.identity.workspaceId)
      || this.killSwitches.missionIds.has(request.identity.missionId)
      || (request.identity.connectorId !== undefined && this.killSwitches.connectorIds.has(request.identity.connectorId))
  }

  private deny(
    request: CapabilityOperationRequest,
    requestHash: string,
    code: CapabilityBrokerDenialCode,
    reason: string,
  ): Extract<CapabilityBrokerDecision, { status: 'denied' }> {
    this.emit({
      kind: 'authorization-denied',
      requestHash,
      operationId: request.operationId,
      workspaceId: request.identity.workspaceId,
      missionId: request.identity.missionId,
      code,
    })
    return { status: 'denied', code, reason, requestHash }
  }

  private rejectCapability(
    request: CapabilityOperationRequest,
    requestHash: string,
    code: CapabilityBrokerDenialCode,
    reason: string,
  ): Extract<CapabilityConsumptionDecision, { allowed: false }> {
    this.emit({
      kind: 'capability-rejected',
      requestHash,
      operationId: request.operationId,
      workspaceId: request.identity.workspaceId,
      missionId: request.identity.missionId,
      code,
    })
    return { allowed: false, code, reason, requestHash }
  }

  private emit(event: Omit<CapabilityBrokerEvent, 'sequence' | 'timestamp'>): void {
    const complete: CapabilityBrokerEvent = {
      sequence: ++this.eventSequence,
      timestamp: new Date(this.nowMs()).toISOString(),
      ...event,
    }
    this.events.push(complete)
    this.onEvent?.({ ...complete })
  }
}
