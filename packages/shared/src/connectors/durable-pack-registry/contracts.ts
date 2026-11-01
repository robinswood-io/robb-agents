import { z } from "zod";
import { type ConnectorPackContractResult, type ConnectorPackOperation, type SignedConnectorPackManifest } from "../pack-manifest";

const OperationSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  effect: z.enum(['read', 'write', 'external-mutation']),
  risk: z.enum(['R0', 'R1', 'W1', 'W2', 'W3']),
  requiredScopes: z.array(z.string()),
  allowedOrigins: z.array(z.string()),
  targetResourceTypes: z.array(z.string()),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  approval: z.enum(['never', 'risk-based', 'always']),
  idempotent: z.boolean(),
  compensation: z.object({
    strategy: z.enum(['inverse-operation', 'restore-snapshot', 'manual']),
    operationId: z.string().optional(),
  }).strict().optional(),
  reconciliation: z.object({
    required: z.boolean(),
    receiptFields: z.array(z.string()),
  }).strict(),
}).strict()

export const SignedManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  version: z.string().trim().min(1),
  category: z.enum(['productivity', 'collaboration', 'crm', 'erp']),
  publisher: z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    website: z.string().trim().min(1),
  }).strict(),
  authentication: z.object({
    type: z.enum(['oauth2', 'api-key', 'service-account']),
    secretReferenceFields: z.array(z.string()),
    requiredScopes: z.array(z.string()),
    optionalScopes: z.array(z.string()),
  }).strict(),
  allowedOrigins: z.array(z.string()),
  dataHandling: z.object({
    classification: z.literal('external-untrusted'),
    retentionDays: z.number().int(),
    redactFields: z.array(z.string()),
  }).strict(),
  lifecycle: z.object({
    supportsRevocation: z.literal(true),
    authorizationGenerationRequired: z.literal(true),
  }).strict(),
  healthCheck: z.object({
    operationId: z.string(),
    timeoutMs: z.number().int(),
  }).strict(),
  rateLimit: z.object({
    requests: z.number().int(),
    windowMs: z.number().int(),
    maxConcurrency: z.number().int(),
  }).strict(),
  operations: z.array(OperationSchema),
  signature: z.object({
    algorithm: z.literal('ed25519'),
    keyId: z.string().trim().min(1),
    signedAt: z.string().datetime(),
    value: z.string().trim().min(1),
  }).strict(),
}).strict()

export const ContractResultSchema = z.object({
  passed: z.literal(true),
  failures: z.array(z.string()).length(0),
  healthLatencyMs: z.number().nonnegative(),
}).strict()

const ConnectorPackRegistryEventUnsignedSchema = z.object({
  schemaVersion: z.literal(1),
  generation: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  actorId: z.string().trim().min(1),
  action: z.enum(['install', 'rotate', 'revoke', 'uninstall']),
  packId: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(1_000),
  manifest: SignedManifestSchema.optional(),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  contract: ContractResultSchema.optional(),
  previousHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict()

export const ConnectorPackRegistryEventSchema = ConnectorPackRegistryEventUnsignedSchema.extend({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export type ConnectorPackRegistryEventUnsigned = z.infer<typeof ConnectorPackRegistryEventUnsignedSchema>

export type ConnectorPackRegistryEvent = z.infer<typeof ConnectorPackRegistryEventSchema>

export type DurableConnectorPackStatus = 'active' | 'revoked' | 'uninstalled'

export interface DurableConnectorPackRecord {
  manifest: SignedConnectorPackManifest
  manifestHash: string
  status: DurableConnectorPackStatus
  authorizationGeneration: number
  installedAt: string
  updatedAt: string
  updatedBy: string
  reason: string
  contract: ConnectorPackContractResult
}

export interface DurableConnectorPackSnapshot {
  schemaVersion: 1
  generation: number
  packs: Record<string, DurableConnectorPackRecord>
  lastEventHash?: string
}

export interface ConnectorPackLifecycleRequest {
  actorId: string
  reason: string
  expectedGeneration?: number
}

export type ConnectorPackContractVerifier = (
  manifest: SignedConnectorPackManifest,
) => Promise<ConnectorPackContractResult>

export interface ConnectorRuntimeAdmission {
  packId: string
  operationId: string
  manifestHash: string
  authorizationGeneration: number
  operation: ConnectorPackOperation
}
