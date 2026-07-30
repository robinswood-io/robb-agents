import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface RemoteDeviceRecord {
  id: string
  name: string
  allowedWorkspaceIds: readonly string[]
  pairedAt: string
  expiresAt: string
  authorizationGeneration: number
  revokedAt?: string
}

interface RemoteDeviceRegistryDocument {
  version: 1
  devices: RemoteDeviceRecord[]
}

export interface RegisterRemoteDeviceInput {
  id: string
  name: string
  allowedWorkspaceIds: readonly string[]
  expiresAt: string
  authorizationGeneration: number
}

export interface RemoteDeviceRegistryOptions {
  filePath?: string
  now?: () => Date
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim() !== '')
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function parseRecord(value: unknown): RemoteDeviceRecord | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (
    typeof input.id !== 'string'
    || input.id.trim() === ''
    || typeof input.name !== 'string'
    || input.name.trim() === ''
    || !isStringArray(input.allowedWorkspaceIds)
    || !isIsoDate(input.pairedAt)
    || !isIsoDate(input.expiresAt)
    || typeof input.authorizationGeneration !== 'number'
    || !Number.isSafeInteger(input.authorizationGeneration)
    || input.authorizationGeneration < 0
    || (input.revokedAt !== undefined && !isIsoDate(input.revokedAt))
  ) {
    return null
  }
  return {
    id: input.id,
    name: input.name,
    allowedWorkspaceIds: [...input.allowedWorkspaceIds],
    pairedAt: input.pairedAt,
    expiresAt: input.expiresAt,
    authorizationGeneration: input.authorizationGeneration,
    ...(input.revokedAt ? { revokedAt: input.revokedAt } : {}),
  }
}

function parseDocument(value: unknown): RemoteDeviceRegistryDocument | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.version !== 1 || !Array.isArray(input.devices)) return null
  const devices = input.devices.map(parseRecord)
  if (devices.some((device) => device === null)) return null
  return { version: 1, devices: devices.filter((device): device is RemoteDeviceRecord => device !== null) }
}

/** Durable, fail-closed registry used to revoke Remote browser sessions immediately. */
export class RemoteDeviceRegistry {
  private readonly filePath?: string
  private readonly now: () => Date
  private document: RemoteDeviceRegistryDocument
  private readable = true

  constructor(options: RemoteDeviceRegistryOptions = {}) {
    this.filePath = options.filePath
    this.now = options.now ?? (() => new Date())
    this.document = { version: 1, devices: [] }
    this.load()
  }

  register(input: RegisterRemoteDeviceInput): RemoteDeviceRecord {
    this.assertReadable()
    if (
      input.id.trim() === ''
      || input.name.trim() === ''
      || !isStringArray(input.allowedWorkspaceIds)
      || !isIsoDate(input.expiresAt)
      || !Number.isSafeInteger(input.authorizationGeneration)
      || input.authorizationGeneration < 0
    ) {
      throw new Error('Invalid Remote device registration')
    }
    const record: RemoteDeviceRecord = {
      ...input,
      allowedWorkspaceIds: [...new Set(input.allowedWorkspaceIds)],
      pairedAt: this.now().toISOString(),
    }
    this.document.devices = [
      ...this.document.devices.filter((device) => device.id !== input.id),
      record,
    ]
    this.persist()
    return record
  }

  list(): RemoteDeviceRecord[] {
    this.assertReadable()
    return this.document.devices.map((device) => ({
      ...device,
      allowedWorkspaceIds: [...device.allowedWorkspaceIds],
    }))
  }

  authorize(deviceId: string, authorizationGeneration: number): RemoteDeviceRecord | null {
    if (!this.readable) return null
    const device = this.document.devices.find((candidate) => candidate.id === deviceId)
    if (
      !device
      || device.revokedAt
      || device.authorizationGeneration !== authorizationGeneration
      || Date.parse(device.expiresAt) <= this.now().getTime()
    ) {
      return null
    }
    return { ...device, allowedWorkspaceIds: [...device.allowedWorkspaceIds] }
  }

  revoke(deviceId: string): boolean {
    this.assertReadable()
    const device = this.document.devices.find((candidate) => candidate.id === deviceId)
    if (!device || device.revokedAt) return false
    device.revokedAt = this.now().toISOString()
    device.authorizationGeneration += 1
    this.persist()
    return true
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return
    try {
      const parsed = parseDocument(JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown)
      if (!parsed) throw new Error('invalid registry document')
      this.document = parsed
    } catch {
      this.readable = false
      this.document = { version: 1, devices: [] }
    }
  }

  private assertReadable(): void {
    if (!this.readable) throw new Error('Remote device registry is unreadable; refusing authorization changes')
  }

  private persist(): void {
    if (!this.filePath) return
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.filePath}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(this.document, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporaryPath, this.filePath)
  }
}
