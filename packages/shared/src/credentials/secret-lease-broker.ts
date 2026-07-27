import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

const SecretLeaseIdentitySchema = z.object({
  clientId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  sourceId: z.string().trim().min(1),
  missionId: z.string().trim().min(1).optional(),
  nodeId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  connectorId: z.string().trim().min(1).optional(),
}).strict()

const UnsignedSecretLeaseGrantSchema = z.object({
  schemaVersion: z.literal(1),
  leaseId: z.string().trim().min(1),
  secretReference: z.string().trim().min(1),
  secretName: z.string().trim().min(1),
  identity: SecretLeaseIdentitySchema,
  operationId: z.string().trim().min(1),
  scopes: z.array(z.string().trim().min(1)).min(1),
  authorizationGeneration: z.number().int().nonnegative(),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  maxUses: z.number().int().positive().max(100),
}).strict()

const SecretLeaseGrantSchema = UnsignedSecretLeaseGrantSchema.extend({
  token: z.string().trim().min(1),
}).strict()

export type SecretLeaseIdentity = z.infer<typeof SecretLeaseIdentitySchema>
type UnsignedSecretLeaseGrant = z.infer<typeof UnsignedSecretLeaseGrantSchema>
export type SecretLeaseGrant = z.infer<typeof SecretLeaseGrantSchema>

export interface SecretLeaseIssueRequest {
  secretReference: string
  secretName: string
  identity: SecretLeaseIdentity
  operationId: string
  scopes: string[]
  authorizationGeneration: number
  ttlMs: number
  maxUses?: number
}

export interface SecretLeaseConsumptionRequest {
  secretReference: string
  identity: SecretLeaseIdentity
  operationId: string
  scopes: readonly string[]
  authorizationGeneration: number
}

export type SecretLeaseDenialCode =
  | 'LEASE_INVALID'
  | 'LEASE_EXPIRED'
  | 'LEASE_REVOKED'
  | 'LEASE_EXHAUSTED'
  | 'LEASE_BINDING_MISMATCH'
  | 'LEASE_SCOPE_DENIED'
  | 'AUTHORIZATION_GENERATION_MISMATCH'

export type SecretLeaseConsumptionDecision =
  | { allowed: true; leaseId: string; remainingUses: number }
  | { allowed: false; code: SecretLeaseDenialCode; reason: string }

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

function canonicalGrant(grant: UnsignedSecretLeaseGrant): string {
  return JSON.stringify(stableValue(grant))
}

function sameIdentity(left: SecretLeaseIdentity, right: SecretLeaseIdentity): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
}

/**
 * Issues signed, value-free grants and consumes their quotas synchronously.
 * The raw credential remains in the credential resolver and is never placed in
 * the capability, event stream, model context, or error messages.
 */
export class SecretLeaseBroker {
  private readonly signingKey: Buffer
  private readonly consumedUses = new Map<string, number>()
  private readonly revokedLeaseIds = new Set<string>()

  constructor(input: {
    signingKey: string | Uint8Array
    currentAuthorizationGeneration: (identity: SecretLeaseIdentity) => number
    maxLeaseTtlMs?: number
    nowMs?: () => number
    generateId?: () => string
  }) {
    this.signingKey = Buffer.from(input.signingKey)
    if (this.signingKey.byteLength < 32) {
      throw new Error('Secret lease signing key must contain at least 32 bytes')
    }
    this.currentAuthorizationGeneration = input.currentAuthorizationGeneration
    this.maxLeaseTtlMs = input.maxLeaseTtlMs ?? 5 * 60_000
    this.nowMs = input.nowMs ?? Date.now
    this.generateId = input.generateId ?? randomUUID
  }

  private readonly currentAuthorizationGeneration: (identity: SecretLeaseIdentity) => number
  private readonly maxLeaseTtlMs: number
  private readonly nowMs: () => number
  private readonly generateId: () => string

  issue(request: SecretLeaseIssueRequest): SecretLeaseGrant {
    const identity = SecretLeaseIdentitySchema.parse(request.identity)
    const currentGeneration = this.currentAuthorizationGeneration(identity)
    if (request.authorizationGeneration !== currentGeneration) {
      throw new Error('Secret lease authorization generation is stale')
    }
    if (!Number.isInteger(request.ttlMs) || request.ttlMs <= 0 || request.ttlMs > this.maxLeaseTtlMs) {
      throw new Error(`Secret lease TTL must be between 1 and ${this.maxLeaseTtlMs} ms`)
    }
    const issuedAtMs = this.nowMs()
    const unsigned = UnsignedSecretLeaseGrantSchema.parse({
      schemaVersion: 1,
      leaseId: this.generateId(),
      secretReference: request.secretReference,
      secretName: request.secretName,
      identity,
      operationId: request.operationId,
      scopes: [...new Set(request.scopes)].sort((left, right) => left.localeCompare(right)),
      authorizationGeneration: request.authorizationGeneration,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(issuedAtMs + request.ttlMs).toISOString(),
      maxUses: request.maxUses ?? 1,
    })
    return { ...unsigned, token: this.sign(unsigned) }
  }

  consume(
    grantValue: SecretLeaseGrant,
    requestValue: SecretLeaseConsumptionRequest,
  ): SecretLeaseConsumptionDecision {
    let grant: SecretLeaseGrant
    let request: SecretLeaseConsumptionRequest
    try {
      grant = SecretLeaseGrantSchema.parse(grantValue)
      request = {
        ...requestValue,
        identity: SecretLeaseIdentitySchema.parse(requestValue.identity),
        scopes: z.array(z.string().trim().min(1)).parse(requestValue.scopes),
      }
    } catch {
      return { allowed: false, code: 'LEASE_INVALID', reason: 'Secret lease shape is invalid' }
    }
    const { token, ...unsigned } = grant
    if (!this.verify(unsigned, token)) {
      return { allowed: false, code: 'LEASE_INVALID', reason: 'Secret lease signature is invalid' }
    }
    if (Date.parse(grant.expiresAt) <= this.nowMs()) {
      return { allowed: false, code: 'LEASE_EXPIRED', reason: 'Secret lease expired' }
    }
    if (this.revokedLeaseIds.has(grant.leaseId)) {
      return { allowed: false, code: 'LEASE_REVOKED', reason: 'Secret lease was revoked' }
    }
    const currentGeneration = this.currentAuthorizationGeneration(request.identity)
    if (
      request.authorizationGeneration !== currentGeneration
      || grant.authorizationGeneration !== currentGeneration
    ) {
      return {
        allowed: false,
        code: 'AUTHORIZATION_GENERATION_MISMATCH',
        reason: 'Secret lease is bound to a stale authorization generation',
      }
    }
    if (
      grant.secretReference !== request.secretReference
      || grant.operationId !== request.operationId
      || !sameIdentity(grant.identity, request.identity)
    ) {
      return {
        allowed: false,
        code: 'LEASE_BINDING_MISMATCH',
        reason: 'Secret lease identity, source, or operation binding does not match',
      }
    }
    const missingScopes = request.scopes.filter((scope) => !grant.scopes.includes(scope))
    if (missingScopes.length > 0) {
      return {
        allowed: false,
        code: 'LEASE_SCOPE_DENIED',
        reason: `Secret lease does not grant required scopes: ${missingScopes.join(', ')}`,
      }
    }
    const uses = this.consumedUses.get(grant.leaseId) ?? 0
    if (uses >= grant.maxUses) {
      return { allowed: false, code: 'LEASE_EXHAUSTED', reason: 'Secret lease use limit is exhausted' }
    }
    const nextUses = uses + 1
    this.consumedUses.set(grant.leaseId, nextUses)
    return { allowed: true, leaseId: grant.leaseId, remainingUses: grant.maxUses - nextUses }
  }

  revoke(leaseId: string): void {
    this.revokedLeaseIds.add(z.string().trim().min(1).parse(leaseId))
  }

  private sign(grant: UnsignedSecretLeaseGrant): string {
    return createHmac('sha256', this.signingKey).update(canonicalGrant(grant), 'utf8').digest('base64url')
  }

  private verify(grant: UnsignedSecretLeaseGrant, token: string): boolean {
    const expected = Buffer.from(this.sign(grant), 'utf8')
    const actual = Buffer.from(token, 'utf8')
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }
}

export function parseSecretLeaseGrant(value: unknown): SecretLeaseGrant {
  return SecretLeaseGrantSchema.parse(value)
}
