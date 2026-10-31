import { isUnknownArray } from '../../utils/json.ts';
import { createHash } from "node:crypto";
import { z } from "zod";

export const OPERATION_RISK_LEVELS = ['R0', 'R1', 'W1', 'W2', 'W3'] as const

export const AUTONOMY_LEVELS = ['A0', 'A1', 'A2', 'A3', 'A4'] as const

export const OperationRiskLevelSchema = z.enum(OPERATION_RISK_LEVELS)

export const AutonomyLevelSchema = z.enum(AUTONOMY_LEVELS)

export type OperationRiskLevel = z.infer<typeof OperationRiskLevelSchema>

export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>

export const RISK_RANK: Record<OperationRiskLevel, number> = {
  R0: 0,
  R1: 1,
  W1: 2,
  W2: 3,
  W3: 4,
}

export const AUTONOMY_MAX_RISK: Record<AutonomyLevel, OperationRiskLevel> = {
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
  nodeId: z.string().trim().min(1).optional(),
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

/**
 * Bounded, value-free context shown to a human before a connector operation.
 * It is part of CapabilityOperationRequestSchema so every field below is
 * covered by the canonical requestHash without exposing the request payload or
 * a provider resource identifier to approval clients.
 */
export const OperationApprovalContextSchema = z.object({
  provider: z.string().trim().min(1).max(128),
  connectorId: z.string().trim().min(1).max(128),
  origin: z.string().url().max(2_048),
  resourceClass: z.string().trim().min(1).max(128),
  purpose: z.string().trim().min(1).max(256),
  effect: z.enum(['read', 'write', 'external-mutation']),
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
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
  approvalContext: OperationApprovalContextSchema.optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
  budget: OperationBudgetEstimateSchema.optional(),
  compensation: OperationCompensationSchema.optional(),
}).strict().superRefine((request, ctx) => {
  if (!request.approvalContext) return
  if (request.approvalContext.connectorId !== request.identity.connectorId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['approvalContext', 'connectorId'],
      message: 'Approval connector must match the authorized connector identity',
    })
  }
  if (request.approvalContext.origin !== request.target.origin) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['approvalContext', 'origin'],
      message: 'Approval origin must match the authorized target origin',
    })
  }
  if (request.approvalContext.resourceClass !== request.target.resourceType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['approvalContext', 'resourceClass'],
      message: 'Approval resource class must match the authorized target resource type',
    })
  }
})

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

export type OperationApprovalContext = z.infer<typeof OperationApprovalContextSchema>

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
  approvalContext?: OperationApprovalContext
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

export interface PendingApproval {
  request: CapabilityOperationRequest
  approval: CapabilityApprovalRequest
}

export interface ApprovedRequest {
  request: CapabilityOperationRequest
  receipt: CapabilityApprovalReceipt
}

export interface UnsignedOperationCapability extends Omit<OperationCapability, 'token'> {}

export interface CapabilityKillSwitches {
  global: boolean
  workspaceIds: Set<string>
  missionIds: Set<string>
  connectorIds: Set<string>
}

function stableValue(value: unknown): unknown {
  if (isUnknownArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries<unknown>((value as Record<string, unknown>))
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
