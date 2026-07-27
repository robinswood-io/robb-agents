import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { createHash, type KeyObject } from 'node:crypto'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  connectorPackManifestHash,
  verifyConnectorPackManifest,
  type ConnectorPackContractResult,
  type ConnectorPackOperation,
  type SignedConnectorPackManifest,
} from './pack-manifest'

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

const SignedManifestSchema = z.object({
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

const ContractResultSchema = z.object({
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

const ConnectorPackRegistryEventSchema = ConnectorPackRegistryEventUnsignedSchema.extend({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

type ConnectorPackRegistryEventUnsigned = z.infer<typeof ConnectorPackRegistryEventUnsignedSchema>
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

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    )
  }
  return value
}

function hashEvent(event: ConnectorPackRegistryEventUnsigned): string {
  return createHash('sha256').update(JSON.stringify(canonicalValue(event)), 'utf8').digest('hex')
}

function signedManifestHash(manifest: SignedConnectorPackManifest): string {
  const { signature: _signature, ...definition } = manifest
  return connectorPackManifestHash(definition)
}

function emptySnapshot(): DurableConnectorPackSnapshot {
  return { schemaVersion: 1, generation: 0, packs: {} }
}

function cloneRecord(record: DurableConnectorPackRecord): DurableConnectorPackRecord {
  return {
    ...record,
    manifest: structuredClone(record.manifest),
    contract: { ...record.contract, failures: [...record.contract.failures] },
  }
}

function cloneSnapshot(snapshot: DurableConnectorPackSnapshot): DurableConnectorPackSnapshot {
  return {
    ...snapshot,
    packs: Object.fromEntries(
      Object.entries(snapshot.packs).map(([packId, record]) => [packId, cloneRecord(record)]),
    ),
  }
}

function applyEvent(
  snapshot: DurableConnectorPackSnapshot,
  event: ConnectorPackRegistryEvent,
): DurableConnectorPackSnapshot {
  const packs = { ...snapshot.packs }
  const existing = packs[event.packId]
  if (event.action === 'install' || event.action === 'rotate') {
    if (!event.manifest || !event.manifestHash || !event.contract) {
      throw new Error(`Connector registry ${event.action} event is incomplete at generation ${event.generation}`)
    }
    packs[event.packId] = {
      manifest: event.manifest,
      manifestHash: event.manifestHash,
      status: 'active',
      authorizationGeneration: event.generation,
      installedAt: event.action === 'install' || !existing ? event.occurredAt : existing.installedAt,
      updatedAt: event.occurredAt,
      updatedBy: event.actorId,
      reason: event.reason,
      contract: event.contract,
    }
  } else {
    if (!existing) {
      throw new Error(`Connector registry ${event.action} references an unknown pack at generation ${event.generation}`)
    }
    packs[event.packId] = {
      ...existing,
      status: event.action === 'revoke' ? 'revoked' : 'uninstalled',
      authorizationGeneration: event.generation,
      updatedAt: event.occurredAt,
      updatedBy: event.actorId,
      reason: event.reason,
    }
  }
  return {
    schemaVersion: 1,
    generation: event.generation,
    packs,
    lastEventHash: event.hash,
  }
}

/**
 * Append-only, tamper-evident connector registry. Installation and rotation
 * execute the supplied contract verifier before becoming visible. Every read
 * observes journal changes made by another process and fails closed on damage.
 */
export class DurableConnectorPackRegistry {
  private snapshotCache = emptySnapshot()
  private fileSignature = 'missing'

  constructor(
    private readonly journalPath: string,
    private readonly resolvePublisherKey: (keyId: string) => KeyObject | null,
    private readonly verifyContract: ConnectorPackContractVerifier,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.reload(true)
  }

  snapshot(): DurableConnectorPackSnapshot {
    this.reload(false)
    return cloneSnapshot(this.snapshotCache)
  }

  listEvents(): ConnectorPackRegistryEvent[] {
    this.reload(false)
    return this.readAndVerify().events
  }

  async install(
    manifest: SignedConnectorPackManifest,
    request: ConnectorPackLifecycleRequest,
  ): Promise<DurableConnectorPackRecord> {
    this.reload(false)
    const existing = this.snapshotCache.packs[manifest.id]
    if (existing && existing.status !== 'uninstalled') {
      throw new Error(`Connector pack ${manifest.id} already exists; use rotate`)
    }
    const contract = await this.validateCandidate(manifest)
    return this.appendCandidate('install', manifest, contract, request)
  }

  async rotate(
    manifest: SignedConnectorPackManifest,
    request: ConnectorPackLifecycleRequest,
  ): Promise<DurableConnectorPackRecord> {
    this.reload(false)
    const existing = this.snapshotCache.packs[manifest.id]
    if (!existing || existing.status === 'uninstalled') {
      throw new Error(`Connector pack ${manifest.id} is not installed`)
    }
    const nextHash = signedManifestHash(manifest)
    if (nextHash === existing.manifestHash) {
      throw new Error(`Connector pack ${manifest.id} rotation must change the signed manifest`)
    }
    const contract = await this.validateCandidate(manifest)
    return this.appendCandidate('rotate', manifest, contract, request)
  }

  revoke(packId: string, request: ConnectorPackLifecycleRequest): DurableConnectorPackRecord {
    return this.appendStateChange('revoke', packId, request)
  }

  uninstall(packId: string, request: ConnectorPackLifecycleRequest): DurableConnectorPackRecord {
    return this.appendStateChange('uninstall', packId, request)
  }

  assertOperationAllowed(
    packId: string,
    operationId: string,
    expectedManifestHash?: string,
  ): ConnectorRuntimeAdmission {
    this.reload(false)
    const installed = this.snapshotCache.packs[packId]
    if (!installed || installed.status !== 'active') {
      throw new Error(`Connector pack ${packId} is not active`)
    }
    if (expectedManifestHash && installed.manifestHash !== expectedManifestHash) {
      throw new Error(`Connector pack ${packId} manifest changed; a new runtime session is required`)
    }
    const operation = installed.manifest.operations.find((candidate) => candidate.id === operationId)
    if (!operation) throw new Error(`Unknown connector operation ${operationId}`)
    return {
      packId,
      operationId,
      manifestHash: installed.manifestHash,
      authorizationGeneration: installed.authorizationGeneration,
      operation: structuredClone(operation),
    }
  }

  private async validateCandidate(
    manifest: SignedConnectorPackManifest,
  ): Promise<ConnectorPackContractResult> {
    const parsed = SignedManifestSchema.parse(manifest)
    const publicKey = this.resolvePublisherKey(parsed.signature.keyId)
    if (!publicKey) throw new Error(`Untrusted publisher key: ${parsed.signature.keyId}`)
    const validation = verifyConnectorPackManifest(parsed, publicKey)
    if (!validation.valid) throw new Error(`Invalid connector pack: ${validation.errors.join('; ')}`)
    let contract: ConnectorPackContractResult
    try {
      contract = await this.verifyContract(parsed)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Connector pack contract execution failed: ${message}`)
    }
    if (!contract.passed || contract.failures.length > 0) {
      throw new Error(`Connector pack contract failed: ${contract.failures.join('; ') || 'unspecified failure'}`)
    }
    return ContractResultSchema.parse(contract)
  }

  private appendCandidate(
    action: 'install' | 'rotate',
    manifest: SignedConnectorPackManifest,
    contract: ConnectorPackContractResult,
    request: ConnectorPackLifecycleRequest,
  ): DurableConnectorPackRecord {
    const event = this.append({
      action,
      packId: manifest.id,
      manifest,
      manifestHash: signedManifestHash(manifest),
      contract,
    }, request)
    return cloneRecord(this.snapshotCache.packs[event.packId] as DurableConnectorPackRecord)
  }

  private appendStateChange(
    action: 'revoke' | 'uninstall',
    packId: string,
    request: ConnectorPackLifecycleRequest,
  ): DurableConnectorPackRecord {
    this.reload(false)
    const existing = this.snapshotCache.packs[packId]
    if (!existing || existing.status === 'uninstalled') {
      throw new Error(`Connector pack ${packId} is not installed`)
    }
    const event = this.append({ action, packId }, request)
    return cloneRecord(this.snapshotCache.packs[event.packId] as DurableConnectorPackRecord)
  }

  private append(
    input: {
      action: ConnectorPackRegistryEvent['action']
      packId: string
      manifest?: SignedConnectorPackManifest
      manifestHash?: string
      contract?: ConnectorPackContractResult
    },
    request: ConnectorPackLifecycleRequest,
  ): ConnectorPackRegistryEvent {
    const actorId = z.string().trim().min(1).parse(request.actorId)
    const reason = z.string().trim().min(1).max(1_000).parse(request.reason)
    const packId = z.string().trim().min(1).parse(input.packId)
    mkdirSync(dirname(this.journalPath), { recursive: true, mode: 0o700 })
    const lockPath = `${this.journalPath}.lock`
    let lockDescriptor: number | undefined
    try {
      lockDescriptor = openSync(lockPath, 'wx', 0o600)
      writeSync(lockDescriptor, `${process.pid}\n`, undefined, 'utf8')
      fsyncSync(lockDescriptor)
      this.reload(true)
      if (
        request.expectedGeneration !== undefined
        && request.expectedGeneration !== this.snapshotCache.generation
      ) {
        throw new Error(
          `Connector registry generation conflict: expected ${request.expectedGeneration}, current ${this.snapshotCache.generation}`,
        )
      }
      this.validateTransition(input.action, packId, input.manifestHash)
      const unsigned: ConnectorPackRegistryEventUnsigned = {
        schemaVersion: 1,
        generation: this.snapshotCache.generation + 1,
        occurredAt: this.now().toISOString(),
        actorId,
        action: input.action,
        packId,
        reason,
        ...(input.manifest ? { manifest: SignedManifestSchema.parse(input.manifest) } : {}),
        ...(input.manifestHash ? { manifestHash: input.manifestHash } : {}),
        ...(input.contract ? { contract: ContractResultSchema.parse(input.contract) } : {}),
        previousHash: this.snapshotCache.lastEventHash ?? null,
      }
      const event: ConnectorPackRegistryEvent = { ...unsigned, hash: hashEvent(unsigned) }
      appendFileSync(this.journalPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
      const journalDescriptor = openSync(this.journalPath, 'r')
      try {
        fsyncSync(journalDescriptor)
      } finally {
        closeSync(journalDescriptor)
      }
      this.snapshotCache = applyEvent(this.snapshotCache, event)
      this.fileSignature = this.signature()
      return event
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error('Connector registry is busy in another process')
      }
      throw error
    } finally {
      if (lockDescriptor !== undefined) {
        closeSync(lockDescriptor)
        try { unlinkSync(lockPath) } catch { /* lock already absent */ }
      }
    }
  }

  private validateTransition(
    action: ConnectorPackRegistryEvent['action'],
    packId: string,
    nextManifestHash?: string,
  ): void {
    const existing = this.snapshotCache.packs[packId]
    if (action === 'install' && existing && existing.status !== 'uninstalled') {
      throw new Error(`Connector pack ${packId} already exists; use rotate`)
    }
    if (action !== 'install' && (!existing || existing.status === 'uninstalled')) {
      throw new Error(`Connector pack ${packId} is not installed`)
    }
    if (action === 'rotate' && existing?.manifestHash === nextManifestHash) {
      throw new Error(`Connector pack ${packId} rotation must change the signed manifest`)
    }
  }

  private reload(force: boolean): void {
    const nextSignature = this.signature()
    if (!force && nextSignature === this.fileSignature) return
    const verified = this.readAndVerify()
    this.snapshotCache = verified.snapshot
    this.fileSignature = nextSignature
  }

  private signature(): string {
    if (!existsSync(this.journalPath)) return 'missing'
    const stats = statSync(this.journalPath)
    return `${stats.size}:${stats.mtimeMs}`
  }

  private readAndVerify(): {
    snapshot: DurableConnectorPackSnapshot
    events: ConnectorPackRegistryEvent[]
  } {
    if (!existsSync(this.journalPath)) return { snapshot: emptySnapshot(), events: [] }
    const lines = readFileSync(this.journalPath, 'utf8').split('\n').filter((line) => line.trim() !== '')
    const events: ConnectorPackRegistryEvent[] = []
    let snapshot = emptySnapshot()
    for (const [index, line] of lines.entries()) {
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(line)
      } catch {
        throw new Error(`Connector registry contains invalid JSON at line ${index + 1}`)
      }
      const event = ConnectorPackRegistryEventSchema.parse(parsedJson)
      const { hash, ...unsigned } = event
      if (event.generation !== index + 1 || event.previousHash !== (snapshot.lastEventHash ?? null)) {
        throw new Error(`Connector registry chain is discontinuous at generation ${event.generation}`)
      }
      if (hashEvent(unsigned) !== hash) {
        throw new Error(`Connector registry hash is invalid at generation ${event.generation}`)
      }
      if ((event.action === 'install' || event.action === 'rotate') !== Boolean(event.manifest)) {
        throw new Error(`Connector registry manifest binding is invalid at generation ${event.generation}`)
      }
      if (event.manifest) {
        if (event.manifest.id !== event.packId) {
          throw new Error(`Connector registry pack binding is invalid at generation ${event.generation}`)
        }
        const publicKey = this.resolvePublisherKey(event.manifest.signature.keyId)
        if (!publicKey) throw new Error(`Untrusted publisher key: ${event.manifest.signature.keyId}`)
        const validation = verifyConnectorPackManifest(event.manifest, publicKey)
        if (!validation.valid || validation.manifestHash !== event.manifestHash) {
          throw new Error(`Connector registry manifest is invalid at generation ${event.generation}`)
        }
      }
      snapshot = applyEvent(snapshot, event)
      events.push(event)
    }
    return { snapshot, events }
  }
}
