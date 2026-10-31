import type { Session } from "@craft-agent/shared/protocol";
import { OfflineVault, OfflineVaultConflictError, type OfflineVaultKey, type OfflineVaultPersistence } from "../offline-vault";



export class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}


export class MemoryPersistence implements OfflineVaultPersistence {
  key: CryptoKey | null = null
  keyGeneration: string | null = null
  record: Parameters<OfflineVaultPersistence['saveRecord']>[0] | null = null
  async loadKey(): Promise<OfflineVaultKey | null> {
    return this.key && this.keyGeneration
      ? { key: this.key, generation: this.keyGeneration }
      : null
  }
  async saveKey(key: CryptoKey): Promise<OfflineVaultKey> {
    if (!this.key || !this.keyGeneration) {
      this.key = key
      this.keyGeneration = crypto.randomUUID()
    }
    return { key: this.key, generation: this.keyGeneration }
  }
  async loadRecord() { return this.record }
  async saveRecord(
    record: Parameters<OfflineVaultPersistence['saveRecord']>[0],
    expectedKeyGeneration: string,
    _expectedRevision?: string | null,
  ) {
    if (this.keyGeneration !== expectedKeyGeneration) throw new OfflineVaultConflictError()
    this.record = structuredClone(record)
  }
  async clear() { this.key = null; this.keyGeneration = null; this.record = null }
}


export class CasMemoryPersistence extends MemoryPersistence {
  override async saveRecord(
    record: Parameters<OfflineVaultPersistence['saveRecord']>[0],
    expectedKeyGeneration: string,
    expectedRevision?: string | null,
  ) {
    const currentRevision = this.record?.revision ?? null
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      throw new OfflineVaultConflictError()
    }
    await super.saveRecord(record, expectedKeyGeneration)
  }
}


export async function decryptRecord(persistence: MemoryPersistence) {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(persistence.record!.iv) },
    persistence.key!,
    persistence.record!.ciphertext,
  )
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>
}


export function scopeToken(vault: OfflineVault) {
  const token = vault.getScopeToken()
  if (!token) throw new Error('Expected an active offline scope')
  return token
}


export const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')


export function session(id: string, lastMessageAt: number, overrides: Partial<Session> = {}): Session {
  return {
    id,
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    name: `Session ${id}`,
    lastMessageAt,
    messages: [],
    isProcessing: false,
    ...overrides,
  }
}
