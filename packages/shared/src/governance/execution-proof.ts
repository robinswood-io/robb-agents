import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { canonicalOperationValue } from './capability-broker'

const SHA256_HEX = /^[a-f0-9]{64}$/

export const ExecutionReconciliationSchema = z.object({
  status: z.enum(['confirmed', 'diverged']),
  observedAt: z.string().datetime(),
  providerStateHash: z.string().regex(SHA256_HEX),
  detailCode: z.string().trim().min(1).optional(),
}).strict()

const UnsignedExecutionProofSchema = z.object({
  schemaVersion: z.literal(1),
  proofId: z.string().trim().min(1),
  kind: z.literal('external-mutation'),
  clientId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  missionId: z.string().trim().min(1),
  nodeId: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  connectorId: z.string().trim().min(1),
  operationId: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1),
  payloadHash: z.string().regex(SHA256_HEX),
  resultHash: z.string().regex(SHA256_HEX),
  providerRequestId: z.string().trim().min(1),
  policyVersion: z.number().int().positive(),
  authorizationGeneration: z.number().int().nonnegative(),
  connectorManifestHash: z.string().regex(SHA256_HEX),
  executedAt: z.string().datetime(),
  reconciliation: ExecutionReconciliationSchema,
}).strict()

export const SignedExecutionProofSchema = UnsignedExecutionProofSchema.extend({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict()

export const ExecutionProofBindingSchema = UnsignedExecutionProofSchema.omit({
  schemaVersion: true,
  proofId: true,
  kind: true,
  providerRequestId: true,
  executedAt: true,
  reconciliation: true,
}).strict()

export const TaskExecutionProofBindingSchema = z.object({
  workspaceId: z.string().trim().min(1),
  missionId: z.string().trim().min(1),
  nodeId: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1),
}).strict()

type UnsignedExecutionProof = z.infer<typeof UnsignedExecutionProofSchema>
export type SignedExecutionProof = z.infer<typeof SignedExecutionProofSchema>
export type ExecutionProofBinding = z.infer<typeof ExecutionProofBindingSchema>
export type TaskExecutionProofBinding = z.infer<typeof TaskExecutionProofBindingSchema>

export interface ExecutionProofIssueRequest extends ExecutionProofBinding {
  providerRequestId: string
  reconciliation: z.input<typeof ExecutionReconciliationSchema>
}

export type ExecutionProofDenialCode =
  | 'PROOF_INVALID'
  | 'PROOF_BINDING_MISMATCH'
  | 'RECONCILIATION_DIVERGED'

export type ExecutionProofVerificationDecision =
  | { allowed: true; proof: SignedExecutionProof }
  | { allowed: false; code: ExecutionProofDenialCode; reason: string }

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalOperationValue(left) === canonicalOperationValue(right)
}

function bindingFromProof(proof: SignedExecutionProof): ExecutionProofBinding {
  return {
    clientId: proof.clientId,
    workspaceId: proof.workspaceId,
    missionId: proof.missionId,
    nodeId: proof.nodeId,
    agentId: proof.agentId,
    connectorId: proof.connectorId,
    operationId: proof.operationId,
    idempotencyKey: proof.idempotencyKey,
    payloadHash: proof.payloadHash,
    resultHash: proof.resultHash,
    policyVersion: proof.policyVersion,
    authorizationGeneration: proof.authorizationGeneration,
    connectorManifestHash: proof.connectorManifestHash,
  }
}

function parseBinding(value: ExecutionProofBinding): ExecutionProofBinding {
  return ExecutionProofBindingSchema.parse({
    clientId: value.clientId,
    workspaceId: value.workspaceId,
    missionId: value.missionId,
    nodeId: value.nodeId,
    agentId: value.agentId,
    connectorId: value.connectorId,
    operationId: value.operationId,
    idempotencyKey: value.idempotencyKey,
    payloadHash: value.payloadHash,
    resultHash: value.resultHash,
    policyVersion: value.policyVersion,
    authorizationGeneration: value.authorizationGeneration,
    connectorManifestHash: value.connectorManifestHash,
  })
}

/**
 * Produces and verifies value-free evidence for a reconciled provider mutation.
 * Raw payloads, provider responses, credentials, and model text are never signed
 * into the proof; only their deterministic hashes and authoritative identifiers are.
 */
export class ExecutionProofIssuer {
  private readonly signingKey: Buffer

  constructor(input: {
    signingKey: string | Uint8Array
    now?: () => string
    generateId?: () => string
  }) {
    this.signingKey = Buffer.from(input.signingKey)
    if (this.signingKey.byteLength < 32) {
      throw new Error('Execution proof signing key must contain at least 32 bytes')
    }
    this.now = input.now ?? (() => new Date().toISOString())
    this.generateId = input.generateId ?? randomUUID
  }

  private readonly now: () => string
  private readonly generateId: () => string

  issue(requestValue: ExecutionProofIssueRequest): SignedExecutionProof {
    const request = {
      ...parseBinding(requestValue),
      providerRequestId: z.string().trim().min(1).parse(requestValue.providerRequestId),
      reconciliation: ExecutionReconciliationSchema.parse(requestValue.reconciliation),
    }
    const unsigned = UnsignedExecutionProofSchema.parse({
      schemaVersion: 1,
      proofId: this.generateId(),
      kind: 'external-mutation',
      ...request,
      executedAt: this.now(),
    })
    return SignedExecutionProofSchema.parse({ ...unsigned, token: this.sign(unsigned) })
  }

  verify(
    value: unknown,
    bindingValue: ExecutionProofBinding,
  ): ExecutionProofVerificationDecision {
    const parsed = this.verifyAuthenticity(value)
    if (!parsed.allowed) return parsed
    const binding = parseBinding(bindingValue)
    if (!sameValue(bindingFromProof(parsed.proof), binding)) {
      return {
        allowed: false,
        code: 'PROOF_BINDING_MISMATCH',
        reason: 'Execution proof does not match the authorized operation binding',
      }
    }
    return this.verifyReconciliation(parsed.proof)
  }

  verifyForTask(
    value: unknown,
    bindingValue: TaskExecutionProofBinding,
  ): ExecutionProofVerificationDecision {
    const parsed = this.verifyAuthenticity(value)
    if (!parsed.allowed) return parsed
    const binding = TaskExecutionProofBindingSchema.parse(bindingValue)
    if (
      parsed.proof.workspaceId !== binding.workspaceId
      || parsed.proof.missionId !== binding.missionId
      || parsed.proof.nodeId !== binding.nodeId
      || parsed.proof.idempotencyKey !== binding.idempotencyKey
    ) {
      return {
        allowed: false,
        code: 'PROOF_BINDING_MISMATCH',
        reason: 'Execution proof does not match the task execution binding',
      }
    }
    return this.verifyReconciliation(parsed.proof)
  }

  private verifyAuthenticity(value: unknown): ExecutionProofVerificationDecision {
    let proof: SignedExecutionProof
    try {
      proof = SignedExecutionProofSchema.parse(value)
    } catch {
      return { allowed: false, code: 'PROOF_INVALID', reason: 'Execution proof shape is invalid' }
    }
    const { token, ...unsigned } = proof
    const expected = Buffer.from(this.sign(unsigned), 'utf8')
    const actual = Buffer.from(token, 'utf8')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { allowed: false, code: 'PROOF_INVALID', reason: 'Execution proof signature is invalid' }
    }
    return { allowed: true, proof }
  }

  private verifyReconciliation(proof: SignedExecutionProof): ExecutionProofVerificationDecision {
    if (proof.reconciliation.status !== 'confirmed') {
      return {
        allowed: false,
        code: 'RECONCILIATION_DIVERGED',
        reason: proof.reconciliation.detailCode
          ? `Provider reconciliation diverged: ${proof.reconciliation.detailCode}`
          : 'Provider reconciliation diverged',
      }
    }
    return { allowed: true, proof }
  }

  private sign(proof: UnsignedExecutionProof): string {
    return createHmac('sha256', this.signingKey)
      .update(canonicalOperationValue(proof), 'utf8')
      .digest('base64url')
  }
}

export function parseSignedExecutionProof(value: unknown): SignedExecutionProof {
  return SignedExecutionProofSchema.parse(value)
}
