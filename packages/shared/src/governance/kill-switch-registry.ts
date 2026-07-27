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
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { KillSwitchSnapshot } from '../tasks/durable-execution.ts'

export const KILL_SWITCH_SCOPES = ['global', 'workspace', 'mission', 'connector'] as const
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number]

const KillSwitchEventUnsignedSchema = z.object({
  schemaVersion: z.literal(1),
  generation: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  actorId: z.string().trim().min(1),
  scope: z.enum(KILL_SWITCH_SCOPES),
  active: z.boolean(),
  id: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1).max(1_000),
  previousHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict()

const KillSwitchEventSchema = KillSwitchEventUnsignedSchema.extend({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

type KillSwitchEventUnsigned = z.infer<typeof KillSwitchEventUnsignedSchema>
export type KillSwitchEvent = z.infer<typeof KillSwitchEventSchema>

export interface EnterpriseKillSwitchSnapshot extends KillSwitchSnapshot {
  schemaVersion: 1
  generation: number
  connectorIds: readonly string[]
  updatedAt?: string
  updatedBy?: string
  lastEventHash?: string
}

export interface KillSwitchUpdate {
  scope: KillSwitchScope
  active: boolean
  id?: string
  reason: string
  actorId: string
  expectedGeneration?: number
}

function hashEvent(event: KillSwitchEventUnsigned): string {
  return createHash('sha256').update(JSON.stringify(event), 'utf8').digest('hex')
}

function emptySnapshot(): EnterpriseKillSwitchSnapshot {
  return {
    schemaVersion: 1,
    generation: 0,
    global: false,
    workspaceIds: [],
    missionIds: [],
    connectorIds: [],
  }
}

function sorted(values: Set<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right))
}

function applyEvent(snapshot: EnterpriseKillSwitchSnapshot, event: KillSwitchEvent): EnterpriseKillSwitchSnapshot {
  const workspaceIds = new Set(snapshot.workspaceIds)
  const missionIds = new Set(snapshot.missionIds)
  const connectorIds = new Set(snapshot.connectorIds)
  if (event.scope === 'workspace' && event.id) {
    if (event.active) workspaceIds.add(event.id)
    else workspaceIds.delete(event.id)
  }
  if (event.scope === 'mission' && event.id) {
    if (event.active) missionIds.add(event.id)
    else missionIds.delete(event.id)
  }
  if (event.scope === 'connector' && event.id) {
    if (event.active) connectorIds.add(event.id)
    else connectorIds.delete(event.id)
  }
  return {
    schemaVersion: 1,
    generation: event.generation,
    global: event.scope === 'global' ? event.active : snapshot.global,
    workspaceIds: sorted(workspaceIds),
    missionIds: sorted(missionIds),
    connectorIds: sorted(connectorIds),
    updatedAt: event.occurredAt,
    updatedBy: event.actorId,
    lastEventHash: event.hash,
  }
}

/**
 * Append-only, tamper-evident kill-switch registry. Reads observe changes made
 * by another process; malformed chains throw so execution fails closed.
 */
export class DurableKillSwitchRegistry {
  private snapshotCache = emptySnapshot()
  private fileSignature = 'missing'

  constructor(
    private readonly journalPath: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.reload(true)
  }

  snapshot(): EnterpriseKillSwitchSnapshot {
    this.reload(false)
    return {
      ...this.snapshotCache,
      workspaceIds: [...this.snapshotCache.workspaceIds],
      missionIds: [...this.snapshotCache.missionIds],
      connectorIds: [...this.snapshotCache.connectorIds],
    }
  }

  taskSnapshot(): KillSwitchSnapshot {
    const snapshot = this.snapshot()
    return {
      global: snapshot.global,
      workspaceIds: snapshot.workspaceIds,
      missionIds: snapshot.missionIds,
    }
  }

  listEvents(): KillSwitchEvent[] {
    this.reload(false)
    return this.readAndVerify().events
  }

  set(update: KillSwitchUpdate): EnterpriseKillSwitchSnapshot {
    const normalized = this.validateUpdate(update)
    mkdirSync(dirname(this.journalPath), { recursive: true, mode: 0o700 })
    const lockPath = `${this.journalPath}.lock`
    let lockDescriptor: number | undefined
    try {
      lockDescriptor = openSync(lockPath, 'wx', 0o600)
      writeSync(lockDescriptor, `${process.pid}\n`, undefined, 'utf8')
      fsyncSync(lockDescriptor)
      this.reload(true)
      if (
        normalized.expectedGeneration !== undefined
        && normalized.expectedGeneration !== this.snapshotCache.generation
      ) {
        throw new Error(
          `Kill-switch generation conflict: expected ${normalized.expectedGeneration}, current ${this.snapshotCache.generation}`,
        )
      }
      const unsigned: KillSwitchEventUnsigned = {
        schemaVersion: 1,
        generation: this.snapshotCache.generation + 1,
        occurredAt: this.now().toISOString(),
        actorId: normalized.actorId,
        scope: normalized.scope,
        active: normalized.active,
        ...(normalized.id ? { id: normalized.id } : {}),
        reason: normalized.reason,
        previousHash: this.snapshotCache.lastEventHash ?? null,
      }
      const event: KillSwitchEvent = { ...unsigned, hash: hashEvent(unsigned) }
      appendFileSync(this.journalPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
      const journalDescriptor = openSync(this.journalPath, 'r')
      try {
        fsyncSync(journalDescriptor)
      } finally {
        closeSync(journalDescriptor)
      }
      this.snapshotCache = applyEvent(this.snapshotCache, event)
      this.fileSignature = this.signature()
      return this.snapshot()
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error('Kill-switch registry is busy in another process')
      }
      throw error
    } finally {
      if (lockDescriptor !== undefined) {
        closeSync(lockDescriptor)
        try { unlinkSync(lockPath) } catch { /* lock already absent */ }
      }
    }
  }

  private validateUpdate(update: KillSwitchUpdate): KillSwitchUpdate {
    const scope = z.enum(KILL_SWITCH_SCOPES).parse(update.scope)
    const actorId = z.string().trim().min(1).parse(update.actorId)
    const reason = z.string().trim().min(1).max(1_000).parse(update.reason)
    const id = update.id?.trim()
    if (scope === 'global' && id) throw new Error('Global kill switch cannot have an identifier')
    if (scope !== 'global' && !id) throw new Error(`${scope} kill switch requires an identifier`)
    return {
      scope,
      active: update.active,
      ...(id ? { id } : {}),
      reason,
      actorId,
      ...(update.expectedGeneration !== undefined
        ? { expectedGeneration: z.number().int().nonnegative().parse(update.expectedGeneration) }
        : {}),
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

  private readAndVerify(): { snapshot: EnterpriseKillSwitchSnapshot; events: KillSwitchEvent[] } {
    if (!existsSync(this.journalPath)) return { snapshot: emptySnapshot(), events: [] }
    const raw = readFileSync(this.journalPath, 'utf8')
    const lines = raw.split('\n').filter((line) => line.trim() !== '')
    const events: KillSwitchEvent[] = []
    let snapshot = emptySnapshot()
    for (const [index, line] of lines.entries()) {
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(line)
      } catch {
        throw new Error(`Kill-switch journal contains invalid JSON at line ${index + 1}`)
      }
      const event = KillSwitchEventSchema.parse(parsedJson)
      const { hash, ...unsigned } = event
      if (event.generation !== index + 1 || event.previousHash !== (snapshot.lastEventHash ?? null)) {
        throw new Error(`Kill-switch journal chain is discontinuous at generation ${event.generation}`)
      }
      if (hashEvent(unsigned) !== hash) {
        throw new Error(`Kill-switch journal hash is invalid at generation ${event.generation}`)
      }
      if (event.scope === 'global' ? event.id !== undefined : event.id === undefined) {
        throw new Error(`Kill-switch journal scope binding is invalid at generation ${event.generation}`)
      }
      snapshot = applyEvent(snapshot, event)
      events.push(event)
    }
    return { snapshot, events }
  }
}
