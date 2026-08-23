/**
 * Opt-in encrypted storage for the Remote PWA.
 *
 * CacheStorage deliberately remains limited to the public application shell.
 * Private user data lives in one bounded AES-GCM payload in IndexedDB. The
 * CryptoKey is non-extractable and is itself persisted by structured clone;
 * browsers which cannot persist it fail closed instead of storing raw key
 * material.
 */

import type { Session } from '@craft-agent/shared/protocol'
import type { SessionDraft } from '@craft-agent/shared/config'

export const OFFLINE_VAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
export const OFFLINE_VAULT_MAX_SESSIONS = 10
export const OFFLINE_VAULT_MAX_MESSAGES_PER_SESSION = 50
export const OFFLINE_VAULT_MAX_MESSAGE_CHARS = 12_000
export const OFFLINE_VAULT_MAX_DRAFT_CHARS = 24_000
export const OFFLINE_VAULT_MAX_DRAFTS = 10
export const OFFLINE_VAULT_MAX_OUTBOX_ITEMS = 30
export const OFFLINE_VAULT_MAX_PINS = 50

const DB_NAME = 'robb-agents-remote-offline-v1'
const DB_VERSION = 1
const KEY_STORE = 'keys'
const DATA_STORE = 'data'
const CONTENT_KEY_ID = 'content-key'
const VAULT_RECORD_ID = 'vault'
const CONSENT_KEY = 'robb-agents.remote.offline-enabled.v1'
const REVOCATION_PENDING_KEY = 'robb-agents.remote.offline-revocation-pending.v1'
const STATE_VERSION = 1
const AES_GCM_IV_BYTES = 12

export type OfflineMessageRole = 'user' | 'assistant' | 'plan' | 'error'

export interface OfflineVaultScope {
  deviceId: string
  workspaceId: string
  expiresAt: string
  hostLabel: string
}

export interface OfflineVaultScopeToken {
  generation: number
  deviceId: string
  workspaceId: string
}

export interface OfflineMessage {
  id: string
  role: OfflineMessageRole
  content: string
  timestamp: number
}

export interface OfflineSessionAnchor {
  messageCount: number
  lastFinalMessageId: string | null
  lastMessageAt: number
}

export interface OfflineSessionSnapshot {
  id: string
  workspaceId: string
  name: string
  preview: string
  lastMessageAt: number
  capturedAt: number
  anchor: OfflineSessionAnchor
  messages: OfflineMessage[]
}

export interface OfflineDraft {
  sessionId: string
  text: string
  updatedAt: number
  dirty: boolean
}

export type OfflineOutboxStatus = 'pending' | 'uncertain'

export interface OfflineOutboxItem {
  id: string
  sessionId: string
  sessionName: string
  text: string
  createdAt: number
  anchor: OfflineSessionAnchor
  status: OfflineOutboxStatus
  failureKind?: 'connection-lost' | 'context-changed' | 'session-busy' | 'session-missing' | 'unknown'
}

export interface OfflinePin {
  id: string
  sessionId: string
  messageId: string
  role: OfflineMessageRole
  text: string
  createdAt: number
}

export interface OfflineVaultState {
  version: 1
  scope: OfflineVaultScope | null
  sessions: OfflineSessionSnapshot[]
  drafts: Record<string, OfflineDraft>
  outbox: OfflineOutboxItem[]
  pins: OfflinePin[]
  lastSyncAt: number | null
  updatedAt: number
}

interface EncryptedVaultRecord {
  id: typeof VAULT_RECORD_ID
  algorithm: 'AES-GCM'
  iv: ArrayBuffer
  ciphertext: ArrayBuffer
  updatedAt: number
  /** Compare-and-swap token preventing stale tabs from overwriting newer data. */
  revision: string
  /** Binds ciphertext to the exact non-extractable key generation that encrypted it. */
  keyGeneration?: string
}

export interface OfflineVaultKey {
  key: CryptoKey
  generation: string
}

export interface OfflineVaultPersistence {
  // The CryptoKey union keeps test/custom persistence implementations written
  // against the initial v1 contract source-compatible. IndexedDB always
  // migrates bare keys to OfflineVaultKey before returning them.
  loadKey(): Promise<OfflineVaultKey | CryptoKey | null>
  /** Atomically keep an existing key or store and return this candidate. */
  saveKey(key: CryptoKey): Promise<OfflineVaultKey | CryptoKey>
  loadRecord(): Promise<EncryptedVaultRecord | null>
  /** Commit only while both the key generation and record revision still match. */
  saveRecord(
    record: EncryptedVaultRecord,
    expectedKeyGeneration: string,
    expectedRevision?: string | null,
  ): Promise<void>
  clear(): Promise<void>
}

export class OfflineVaultUnavailableError extends Error {
  constructor(message = 'Encrypted offline storage is unavailable in this browser') {
    super(message)
    this.name = 'OfflineVaultUnavailableError'
  }
}

export class OfflineVaultCapacityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OfflineVaultCapacityError'
  }
}

export class OfflineVaultConflictError extends OfflineVaultUnavailableError {
  constructor() {
    super('Offline data changed in another tab. Reload before editing it again.')
    this.name = 'OfflineVaultConflictError'
  }
}

function emptyState(now = Date.now()): OfflineVaultState {
  return {
    version: STATE_VERSION,
    scope: null,
    sessions: [],
    drafts: {},
    outbox: [],
    pins: [],
    lastSyncAt: null,
    updatedAt: now,
  }
}

function cloneState(state: OfflineVaultState): OfflineVaultState {
  return structuredClone(state)
}

function finiteTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function boundedText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`
}

function userText(value: unknown, maxChars: number, label: string): string {
  const text = typeof value === 'string' ? value : ''
  if (text.length > maxChars) {
    throw new OfflineVaultCapacityError(`${label} exceeds the ${maxChars.toLocaleString()} character offline limit`)
  }
  return text
}

function isOfflineMessageRole(value: unknown): value is OfflineMessageRole {
  return value === 'user' || value === 'assistant' || value === 'plan' || value === 'error'
}

export function sanitizeSessionSnapshot(
  session: Session,
  now = Date.now(),
): OfflineSessionSnapshot {
  const messages = (Array.isArray(session.messages) ? session.messages : [])
    .filter((message) => !message.hidden && isOfflineMessageRole(message.role))
    .map((message): OfflineMessage => ({
      id: boundedText(message.id, 256),
      role: message.role as OfflineMessageRole,
      content: boundedText(message.content, OFFLINE_VAULT_MAX_MESSAGE_CHARS),
      timestamp: finiteTimestamp(message.timestamp, now),
    }))
    .filter((message) => message.id.length > 0 && message.content.length > 0)
    .slice(-OFFLINE_VAULT_MAX_MESSAGES_PER_SESSION)

  return {
    id: boundedText(session.id, 256),
    workspaceId: boundedText(session.workspaceId, 256),
    name: boundedText(session.name || session.preview || 'Untitled', 240),
    preview: boundedText(session.preview || messages.find((message) => message.role === 'user')?.content || '', 320),
    lastMessageAt: finiteTimestamp(session.lastMessageAt, now),
    capturedAt: now,
    anchor: {
      // Hydrated Session.messages is the host's atomic append sequence. Header
      // messageCount can lag an in-memory send until its next metadata flush.
      messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
      lastFinalMessageId: typeof session.lastFinalMessageId === 'string'
        ? boundedText(session.lastFinalMessageId, 256)
        : null,
      lastMessageAt: finiteTimestamp(session.lastMessageAt, now),
    },
    messages,
  }
}

export function selectRecentSessions(sessions: readonly Session[]): Session[] {
  return sessions
    .filter((session) => !session.hidden && !session.isArchived)
    .sort((left, right) => right.lastMessageAt - left.lastMessageAt)
    .slice(0, OFFLINE_VAULT_MAX_SESSIONS)
}

export function searchOfflineSessions(
  sessions: readonly OfflineSessionSnapshot[],
  query: string,
): OfflineSessionSnapshot[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return [...sessions]
  return sessions.filter((session) => {
    const haystack = [
      session.name,
      session.preview,
      ...session.messages.map((message) => message.content),
    ].join('\n').toLocaleLowerCase()
    return haystack.includes(normalizedQuery)
  })
}

export function anchorsMatch(
  expected: OfflineSessionAnchor,
  actual: OfflineSessionAnchor,
): boolean {
  return expected.messageCount === actual.messageCount
    && expected.lastFinalMessageId === actual.lastFinalMessageId
    && expected.lastMessageAt === actual.lastMessageAt
}

export function isScopeExpired(scope: OfflineVaultScope | null, now = Date.now()): boolean {
  if (!scope) return false
  const expiry = Date.parse(scope.expiresAt)
  return !Number.isFinite(expiry) || expiry <= now
}

export function nextOfflineRetentionDeadline(state: OfflineVaultState): number | null {
  const timestamps = [
    ...state.sessions.map((entry) => entry.capturedAt),
    ...Object.values(state.drafts).map((entry) => entry.updatedAt),
    ...state.outbox.map((entry) => entry.createdAt),
    ...state.pins.map((entry) => entry.createdAt),
  ].filter((value) => Number.isFinite(value) && value >= 0)
  return timestamps.length > 0
    ? Math.min(...timestamps) + OFFLINE_VAULT_RETENTION_MS + 1
    : null
}

function normalizeScope(value: unknown): OfflineVaultScope | null {
  if (!value || typeof value !== 'object') return null
  const scope = value as Partial<OfflineVaultScope>
  if (
    typeof scope.deviceId !== 'string'
    || typeof scope.workspaceId !== 'string'
    || typeof scope.expiresAt !== 'string'
    || typeof scope.hostLabel !== 'string'
    || scope.deviceId.length === 0
    || scope.workspaceId.length === 0
    || scope.deviceId.length > 256
    || scope.workspaceId.length > 256
  ) return null
  return {
    deviceId: scope.deviceId,
    workspaceId: scope.workspaceId,
    expiresAt: scope.expiresAt,
    hostLabel: boundedText(scope.hostLabel, 240),
  }
}

function normalizeState(value: unknown, now: number): OfflineVaultState {
  if (!value || typeof value !== 'object') return emptyState(now)
  const candidate = value as Partial<OfflineVaultState>
  if (candidate.version !== STATE_VERSION) return emptyState(now)

  const retentionFloor = now - OFFLINE_VAULT_RETENTION_MS
  const sessions = Array.isArray(candidate.sessions)
    ? candidate.sessions
      .filter((session): session is OfflineSessionSnapshot => Boolean(
        session
        && typeof session.id === 'string'
        && typeof session.workspaceId === 'string'
        && typeof session.capturedAt === 'number'
        && session.capturedAt >= retentionFloor,
      ))
      .sort((left, right) => right.lastMessageAt - left.lastMessageAt)
      .slice(0, OFFLINE_VAULT_MAX_SESSIONS)
    : []

  const draftEntries = Object.entries(candidate.drafts ?? {})
      .filter(([, draft]) => draft && draft.updatedAt >= retentionFloor)
      .map(([sessionId, draft]) => [sessionId, {
        sessionId,
        text: boundedText(draft.text, OFFLINE_VAULT_MAX_DRAFT_CHARS),
        updatedAt: finiteTimestamp(draft.updatedAt, now),
        dirty: Boolean(draft.dirty),
      } satisfies OfflineDraft] as const)
      .sort((left, right) => Number(right[1].dirty) - Number(left[1].dirty)
        || right[1].updatedAt - left[1].updatedAt)
      .slice(0, OFFLINE_VAULT_MAX_DRAFTS)
  const drafts = Object.fromEntries(draftEntries)

  const outbox = Array.isArray(candidate.outbox)
    ? candidate.outbox
      .filter((item) => item && typeof item.id === 'string' && item.createdAt >= retentionFloor)
      .slice(-OFFLINE_VAULT_MAX_OUTBOX_ITEMS)
    : []
  const pins = Array.isArray(candidate.pins)
    ? candidate.pins
      .filter((pin) => pin && typeof pin.id === 'string' && pin.createdAt >= retentionFloor)
      .slice(-OFFLINE_VAULT_MAX_PINS)
    : []

  const state: OfflineVaultState = {
    version: STATE_VERSION,
    scope: normalizeScope(candidate.scope),
    sessions,
    drafts,
    outbox,
    pins,
    lastSyncAt: candidate.lastSyncAt == null ? null : finiteTimestamp(candidate.lastSyncAt, now),
    updatedAt: finiteTimestamp(candidate.updatedAt, now),
  }
  return isScopeExpired(state.scope, now) ? emptyState(now) : state
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new OfflineVaultUnavailableError())
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new OfflineVaultUnavailableError())
    transaction.onabort = () => reject(transaction.error ?? new OfflineVaultUnavailableError())
  })
}

async function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new OfflineVaultUnavailableError()
  const request = indexedDB.open(DB_NAME, DB_VERSION)
  request.onupgradeneeded = () => {
    const database = request.result
    if (!database.objectStoreNames.contains(KEY_STORE)) database.createObjectStore(KEY_STORE)
    if (!database.objectStoreNames.contains(DATA_STORE)) database.createObjectStore(DATA_STORE, { keyPath: 'id' })
  }
  return requestResult(request)
}

function persistedVaultKey(value: unknown): OfflineVaultKey | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<OfflineVaultKey>
  return candidate.key instanceof CryptoKey
    && typeof candidate.generation === 'string'
    && candidate.generation.length > 0
    ? { key: candidate.key, generation: candidate.generation }
    : null
}

const compatibilityKeyGenerations = new WeakMap<CryptoKey, string>()

function returnedVaultKey(value: OfflineVaultKey | CryptoKey | null): OfflineVaultKey | null {
  const persisted = persistedVaultKey(value)
  if (persisted) return persisted
  if (!(value instanceof CryptoKey)) return null
  let generation = compatibilityKeyGenerations.get(value)
  if (!generation) {
    generation = crypto.randomUUID()
    compatibilityKeyGenerations.set(value, generation)
  }
  return { key: value, generation }
}

function migratePersistedVaultKey(value: unknown): { value: OfflineVaultKey | null; migrated: boolean } {
  const current = persistedVaultKey(value)
  if (current) return { value: current, migrated: false }
  // Version 1 initially stored a bare structured-cloned CryptoKey. Preserve it
  // and attach a generation instead of rotating the key and losing ciphertext.
  if (value instanceof CryptoKey) {
    return {
      value: { key: value, generation: crypto.randomUUID() },
      migrated: true,
    }
  }
  return { value: null, migrated: false }
}

export class IndexedDbOfflineVaultPersistence implements OfflineVaultPersistence {
  async loadKey(): Promise<OfflineVaultKey | null> {
    const database = await openDatabase()
    try {
      const transaction = database.transaction(KEY_STORE, 'readwrite')
      const store = transaction.objectStore(KEY_STORE)
      const result = await requestResult(store.get(CONTENT_KEY_ID))
      const migrated = migratePersistedVaultKey(result)
      if (migrated.migrated) store.put(migrated.value, CONTENT_KEY_ID)
      await transactionDone(transaction)
      return migrated.value
    } finally {
      database.close()
    }
  }

  async saveKey(key: CryptoKey): Promise<OfflineVaultKey> {
    if (key.extractable) throw new OfflineVaultUnavailableError('Refusing to persist an extractable key')
    const database = await openDatabase()
    try {
      const transaction = database.transaction(KEY_STORE, 'readwrite')
      const store = transaction.objectStore(KEY_STORE)
      // Read and conditional write in the same readwrite transaction. IndexedDB
      // serializes competing writers, so simultaneous tabs converge on one key
      // instead of overwriting the key used by the winning ciphertext record.
      const rawCurrent = await requestResult(store.get(CONTENT_KEY_ID))
      const current = migratePersistedVaultKey(rawCurrent)
      const winner = current.value ?? { key, generation: crypto.randomUUID() }
      if (!current.value || current.migrated) store.put(winner, CONTENT_KEY_ID)
      await transactionDone(transaction)
      return winner
    } catch (error) {
      throw new OfflineVaultUnavailableError(
        error instanceof Error ? `Unable to persist the encrypted vault key (${error.name})` : undefined,
      )
    } finally {
      database.close()
    }
  }

  async loadRecord(): Promise<EncryptedVaultRecord | null> {
    const database = await openDatabase()
    try {
      const transaction = database.transaction(DATA_STORE, 'readonly')
      const result = await requestResult(transaction.objectStore(DATA_STORE).get(VAULT_RECORD_ID))
      await transactionDone(transaction)
      return result && typeof result === 'object' ? result as EncryptedVaultRecord : null
    } finally {
      database.close()
    }
  }

  async saveRecord(
    record: EncryptedVaultRecord,
    expectedKeyGeneration: string,
    expectedRevision?: string | null,
  ): Promise<void> {
    const database = await openDatabase()
    try {
      // Key validation and record CAS share one transaction. A purge/re-key that
      // commits before this transaction therefore makes this write fail instead
      // of leaving ciphertext whose key no longer exists.
      const transaction = database.transaction([KEY_STORE, DATA_STORE], 'readwrite')
      const currentKey = persistedVaultKey(
        await requestResult(transaction.objectStore(KEY_STORE).get(CONTENT_KEY_ID)),
      )
      if (currentKey?.generation !== expectedKeyGeneration) {
        transaction.abort()
        throw new OfflineVaultConflictError()
      }
      const store = transaction.objectStore(DATA_STORE)
      const current = await requestResult(store.get(VAULT_RECORD_ID)) as EncryptedVaultRecord | undefined
      const currentRevision = typeof current?.revision === 'string' ? current.revision : null
      if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
        transaction.abort()
        throw new OfflineVaultConflictError()
      }
      store.put(record)
      await transactionDone(transaction)
    } finally {
      database.close()
    }
  }

  async clear(): Promise<void> {
    const database = await openDatabase()
    try {
      const transaction = database.transaction([KEY_STORE, DATA_STORE], 'readwrite')
      transaction.objectStore(KEY_STORE).clear()
      transaction.objectStore(DATA_STORE).clear()
      await transactionDone(transaction)
    } finally {
      database.close()
    }
  }
}

function consentStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function isOfflineVaultEnabled(): boolean {
  try {
    return consentStorage()?.getItem(CONSENT_KEY) === 'true'
  } catch {
    return false
  }
}

function isOfflineVaultRevocationPending(): boolean {
  try {
    return consentStorage()?.getItem(REVOCATION_PENDING_KEY) === 'true'
  } catch {
    // An unreadable revocation marker must never be treated as proof that it
    // is safe to reopen private data. The consent gate will also fail closed
    // when the same storage is unavailable.
    return true
  }
}

function setOfflineVaultRevocationPending(pending: boolean): void {
  const storage = consentStorage()
  if (!storage) throw new OfflineVaultUnavailableError('Local storage is unavailable')
  try {
    if (pending) storage.setItem(REVOCATION_PENDING_KEY, 'true')
    else storage.removeItem(REVOCATION_PENDING_KEY)
  } catch {
    throw new OfflineVaultUnavailableError('Offline revocation state could not be persisted')
  }
}

function setOfflineVaultConsent(enabled: boolean): void {
  const storage = consentStorage()
  if (!storage) {
    throw new OfflineVaultUnavailableError('Local storage is unavailable')
  }
  try {
    if (enabled) storage.setItem(CONSENT_KEY, 'true')
    else storage.removeItem(CONSENT_KEY)
  } catch {
    throw new OfflineVaultUnavailableError(
      enabled ? 'Local storage is unavailable' : 'Offline consent could not be revoked',
    )
  }
}

function boundedSnapshots(
  state: OfflineVaultState,
  incoming: readonly OfflineSessionSnapshot[],
): OfflineSessionSnapshot[] {
  const incomingById = new Map(incoming.map((snapshot) => [snapshot.id, snapshot]))
  const currentById = new Map(state.sessions.map((snapshot) => [snapshot.id, snapshot]))
  const protectedIds = Object.values(state.drafts)
    .filter((draft) => draft.dirty)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((draft) => draft.sessionId)

  const protectedSnapshots = protectedIds.flatMap((sessionId) => {
    const snapshot = incomingById.get(sessionId) ?? currentById.get(sessionId)
    return snapshot ? [snapshot] : []
  })
  const protectedSet = new Set(protectedSnapshots.map((snapshot) => snapshot.id))
  const remaining = incoming
    .filter((snapshot) => !protectedSet.has(snapshot.id))
    .sort((left, right) => right.lastMessageAt - left.lastMessageAt)
  return [...protectedSnapshots, ...remaining].slice(0, OFFLINE_VAULT_MAX_SESSIONS)
}

export class OfflineVault {
  private state = emptyState()
  private key: OfflineVaultKey | null = null
  private loaded = false
  private conflicted = false
  private generation = 0
  private recordRevision: string | null = null
  private queue: Promise<void> = Promise.resolve()
  private listeners = new Set<(state: OfflineVaultState) => void>()

  constructor(private readonly persistence: OfflineVaultPersistence = new IndexedDbOfflineVaultPersistence()) {}

  subscribe(listener: (state: OfflineVaultState) => void): () => void {
    this.listeners.add(listener)
    listener(cloneState(this.state))
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    const snapshot = cloneState(this.state)
    for (const listener of this.listeners) listener(snapshot)
  }

  private async ensureKey(): Promise<OfflineVaultKey> {
    if (this.key) return this.key
    const stored = returnedVaultKey(await this.persistence.loadKey())
    if (stored) {
      if (stored.key.extractable || stored.key.algorithm.name !== 'AES-GCM') {
        throw new OfflineVaultUnavailableError('Stored key does not meet the vault policy')
      }
      this.key = stored
      return stored
    }
    const generated = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
    if (!(generated instanceof CryptoKey) || generated.extractable) {
      throw new OfflineVaultUnavailableError('Unable to create a non-extractable key')
    }
    const winner = returnedVaultKey(await this.persistence.saveKey(generated))
    if (!winner) throw new OfflineVaultUnavailableError('Unable to persist the encrypted vault key')
    if (winner.key.extractable || winner.key.algorithm.name !== 'AES-GCM') {
      throw new OfflineVaultUnavailableError('Stored key does not meet the vault policy')
    }
    this.key = winner
    return winner
  }

  private async loadNow(): Promise<OfflineVaultState> {
    if (isOfflineVaultRevocationPending()) {
      await this.purgeNow()
      return cloneState(this.state)
    }
    if (!isOfflineVaultEnabled()) {
      this.key = null
      this.recordRevision = null
      this.state = emptyState()
      this.loaded = true
      this.conflicted = false
      this.emit()
      return cloneState(this.state)
    }
    const key = await this.ensureKey()
    const record = await this.persistence.loadRecord()
    if (!record) {
      this.recordRevision = null
      this.state = emptyState()
      this.loaded = true
      this.conflicted = false
      this.emit()
      return cloneState(this.state)
    }
    this.recordRevision = typeof record.revision === 'string' ? record.revision : null
    if (record.keyGeneration !== undefined && record.keyGeneration !== key.generation) {
      this.invalidateAfterConflict()
      throw new OfflineVaultConflictError()
    }

    let decoded: Partial<OfflineVaultState>
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(record.iv) },
        key.key,
        record.ciphertext,
      )
      decoded = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<OfflineVaultState>
    } catch (error) {
      if (error instanceof OfflineVaultConflictError) {
        this.invalidateAfterConflict()
        throw error
      }
      await this.purgeNow()
      throw new OfflineVaultUnavailableError('Encrypted offline data could not be opened')
    }

    const normalized = normalizeState(decoded, Date.now())
    if (!normalized.scope || isScopeExpired(normalized.scope)) {
      await this.purgeNow()
      return cloneState(this.state)
    }

    if (record.keyGeneration !== key.generation || JSON.stringify(normalized) !== JSON.stringify(decoded)) {
      try {
        // Rewrite when normalization repaired data or a legacy record needs its
        // migrated key generation. Otherwise independent tabs retain one CAS
        // revision instead of producing no-op conflicts.
        normalized.updatedAt = Date.now()
        await this.persistState(normalized)
      } catch (error) {
        if (error instanceof OfflineVaultConflictError) {
          this.invalidateAfterConflict()
          throw error
        }
        await this.purgeNow()
        throw new OfflineVaultUnavailableError('Expired offline data could not be removed safely')
      }
    }
    this.state = normalized
    this.loaded = true
    this.conflicted = false
    this.emit()
    return cloneState(this.state)
  }

  load(): Promise<OfflineVaultState> {
    const operation = this.queue.then(() => this.loadNow())
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  getSnapshot(): OfflineVaultState {
    return cloneState(this.state)
  }

  getScopeToken(): OfflineVaultScopeToken | null {
    const scope = this.state.scope
    if (!scope || isScopeExpired(scope)) return null
    return {
      generation: this.generation,
      deviceId: scope.deviceId,
      workspaceId: scope.workspaceId,
    }
  }

  private scopeTokenMatches(state: OfflineVaultState, token: OfflineVaultScopeToken | undefined): boolean {
    if (!token) return true
    return token.generation === this.generation
      && token.deviceId === state.scope?.deviceId
      && token.workspaceId === state.scope?.workspaceId
  }

  private async persistState(state: OfflineVaultState): Promise<void> {
    const key = await this.ensureKey()
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES))
    const encoded = new TextEncoder().encode(JSON.stringify(state))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key.key, encoded)
    const revision = crypto.randomUUID()
    await this.persistence.saveRecord({
      id: VAULT_RECORD_ID,
      algorithm: 'AES-GCM',
      iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength),
      ciphertext,
      updatedAt: state.updatedAt,
      revision,
      keyGeneration: key.generation,
    }, key.generation, this.recordRevision)
    this.recordRevision = revision
  }

  private invalidateAfterConflict(): void {
    this.key = null
    // Do not let a stale tab reinterpret the intentionally empty in-memory
    // view as an expired scope: that path would clear the newer tab's record.
    // Only an explicit load() may adopt the winning CAS revision.
    this.loaded = false
    this.conflicted = true
    this.recordRevision = null
    this.state = emptyState()
    this.generation += 1
    this.emit()
  }

  private mutate(
    update: (state: OfflineVaultState, now: number) => void,
    expectedScope?: OfflineVaultScopeToken,
  ): Promise<boolean> {
    const operation = this.queue.then(async () => {
      if (this.conflicted) throw new OfflineVaultConflictError()
      if (!this.loaded) await this.loadNow()
      if (this.conflicted) throw new OfflineVaultConflictError()
      if (!isOfflineVaultEnabled()) throw new OfflineVaultUnavailableError('Offline storage is not enabled')
      const now = Date.now()
      if (!this.state.scope || isScopeExpired(this.state.scope, now)) {
        await this.purgeNow()
        throw new OfflineVaultUnavailableError('The offline session has expired')
      }
      if (!this.scopeTokenMatches(this.state, expectedScope)) return false

      const next = normalizeState(cloneState(this.state), now)
      if (!next.scope || isScopeExpired(next.scope, now)) {
        await this.purgeNow()
        throw new OfflineVaultUnavailableError('The offline session has expired')
      }
      update(next, now)
      const normalized = normalizeState(next, now)
      if (!normalized.scope || !this.scopeTokenMatches(normalized, expectedScope)) return false
      normalized.updatedAt = now
      // Commit to IndexedDB before publishing the new in-memory snapshot. A
      // failed save therefore cannot leak into a later successful mutation.
      try {
        await this.persistState(normalized)
      } catch (error) {
        if (error instanceof OfflineVaultConflictError) this.invalidateAfterConflict()
        throw error
      }
      this.state = normalized
      this.emit()
      return true
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  private assertUserMutationCommitted(committed: boolean): void {
    if (!committed) {
      throw new OfflineVaultUnavailableError('The offline workspace changed before the action was saved')
    }
  }

  enable(scope: OfflineVaultScope): Promise<void> {
    const normalizedScope = normalizeScope(scope)
    if (!normalizedScope || isScopeExpired(normalizedScope)) {
      return Promise.reject(new OfflineVaultUnavailableError('Remote session is already expired'))
    }
    const operation = this.queue.then(async () => {
      if (isOfflineVaultRevocationPending()) {
        await this.purgeNow()
        if (isOfflineVaultRevocationPending()) {
          throw new OfflineVaultUnavailableError('A previous offline-data erasure must finish before enabling storage again')
        }
      }
      if (isOfflineVaultEnabled()) {
        if (!this.loaded) await this.loadNow()
        const current = this.state.scope
        if (current
          && current.deviceId === normalizedScope.deviceId
          && current.workspaceId === normalizedScope.workspaceId) {
          const next = cloneState(this.state)
          next.scope = normalizedScope
          next.updatedAt = Date.now()
          try {
            await this.persistState(next)
          } catch (error) {
            if (error instanceof OfflineVaultConflictError) this.invalidateAfterConflict()
            throw error
          }
          this.state = next
          this.emit()
          return
        }
      }
      if (!this.loaded) {
        const existingRecord = await this.persistence.loadRecord()
        this.recordRevision = typeof existingRecord?.revision === 'string' ? existingRecord.revision : null
      }
      await this.ensureKey()
      const next = emptyState()
      next.scope = normalizedScope
      // Replace any previous principal's ciphertext before recording consent.
      try {
        await this.persistState(next)
      } catch (error) {
        if (error instanceof OfflineVaultConflictError) this.invalidateAfterConflict()
        throw error
      }
      try {
        setOfflineVaultConsent(true)
      } catch (error) {
        this.key = null
        this.state = emptyState()
        this.loaded = true
        this.generation += 1
        this.emit()
        throw error
      }
      this.state = next
      this.loaded = true
      this.conflicted = false
      this.generation += 1
      this.emit()
    })
    this.queue = operation.catch(() => {})
    return operation
  }

  configureScope(scope: OfflineVaultScope): Promise<void> {
    const normalizedScope = normalizeScope(scope)
    if (!normalizedScope || isScopeExpired(normalizedScope)) {
      return Promise.reject(new OfflineVaultUnavailableError('Remote session is already expired'))
    }
    const operation = this.queue.then(async () => {
      if (!isOfflineVaultEnabled()) return
      if (!this.loaded) await this.loadNow()
      if (!isOfflineVaultEnabled() || !this.state.scope) return

      const current = this.state.scope
      const identityChanged = current.deviceId !== normalizedScope.deviceId
        || current.workspaceId !== normalizedScope.workspaceId
      const next = identityChanged ? emptyState() : cloneState(this.state)
      next.scope = normalizedScope
      next.updatedAt = Date.now()
      try {
        await this.persistState(next)
      } catch (error) {
        if (error instanceof OfflineVaultConflictError) this.invalidateAfterConflict()
        throw error
      }
      this.state = next
      this.conflicted = false
      if (identityChanged) this.generation += 1
      this.emit()
    })
    this.queue = operation.catch(() => {})
    return operation
  }

  private async purgeNow(): Promise<void> {
    let pendingMarkerWritten = false
    try {
      setOfflineVaultRevocationPending(true)
      pendingMarkerWritten = true
    } catch {
      // Continue: overwriting or clearing IndexedDB can still establish the
      // durable privacy barrier even when localStorage is unavailable.
    }

    // A new page may see the durable revocation marker before it has loaded
    // the record. Resolve its CAS revision without decrypting private content
    // so an empty overwrite remains available when IndexedDB deletion fails.
    let hasStoredRecord = this.state.scope !== null || this.recordRevision !== null
    if (!hasStoredRecord) {
      try {
        const storedRecord = await this.persistence.loadRecord()
        if (storedRecord) {
          hasStoredRecord = true
          this.recordRevision = typeof storedRecord.revision === 'string' ? storedRecord.revision : null
        }
      } catch {
        // clear() below is still an independent erasure path.
      }
    }

    let overwriteSucceeded = false
    if (hasStoredRecord) {
      try {
        await this.persistState(emptyState())
        overwriteSucceeded = true
      } catch {
        // clear() below is the independent erasure path.
      }
    }

    let clearSucceeded = false
    let persistenceFailure: unknown
    try {
      await this.persistence.clear()
      clearSucceeded = true
    } catch (error) {
      persistenceFailure = error
    }
    this.key = null
    this.recordRevision = null
    this.loaded = true
    this.conflicted = false
    this.state = emptyState()
    this.generation += 1
    this.emit()

    const privateDataErased = overwriteSucceeded || clearSucceeded
    if (privateDataErased) {
      try { setOfflineVaultConsent(false) } catch { /* marker below remains fail-closed */ }
      try { setOfflineVaultRevocationPending(false) } catch { /* no private payload remains */ }
      return
    }

    // If the durable marker was written, a later load will retry purgeNow()
    // before decrypting. Without either a marker or an erased payload, report
    // the hard failure and keep consent intact so the condition is observable.
    if (!pendingMarkerWritten || persistenceFailure) {
      throw new OfflineVaultUnavailableError('Offline data could not be fully erased from this browser')
    }
  }

  purge(): Promise<void> {
    const operation = this.queue.then(() => this.purgeNow())
    this.queue = operation.catch(() => {})
    return operation
  }

  async replaceSnapshots(
    snapshots: readonly OfflineSessionSnapshot[],
    expectedScope?: OfflineVaultScopeToken,
  ): Promise<void> {
    await this.mutate((state, now) => {
      const scoped = snapshots
        .filter((snapshot) => snapshot.workspaceId === state.scope?.workspaceId)
        .map((snapshot) => ({ ...snapshot, capturedAt: finiteTimestamp(snapshot.capturedAt, now) }))
      state.sessions = boundedSnapshots(state, scoped)
      state.lastSyncAt = now
    }, expectedScope)
  }

  async upsertSnapshot(
    snapshot: OfflineSessionSnapshot,
    expectedScope?: OfflineVaultScopeToken,
  ): Promise<void> {
    await this.mutate((state, now) => {
      if (snapshot.workspaceId !== state.scope?.workspaceId) return
      const next = { ...snapshot, capturedAt: now }
      state.sessions = boundedSnapshots(
        state,
        [next, ...state.sessions.filter((entry) => entry.id !== next.id)],
      )
      state.lastSyncAt = now
    }, expectedScope)
  }

  async storeDraft(
    sessionId: string,
    draft: SessionDraft | string,
    dirty: boolean,
    expectedScope: OfflineVaultScopeToken,
  ): Promise<void> {
    const text = userText(
      typeof draft === 'string' ? draft : draft.text,
      OFFLINE_VAULT_MAX_DRAFT_CHARS,
      'Draft',
    )
    const committed = await this.mutate((state, now) => {
      if (!text) delete state.drafts[sessionId]
      else {
        const existing = state.drafts[sessionId]
        if (!existing && Object.keys(state.drafts).length >= OFFLINE_VAULT_MAX_DRAFTS) {
          const oldestCached = Object.values(state.drafts)
            .filter((entry) => !entry.dirty)
            .sort((left, right) => left.updatedAt - right.updatedAt)[0]
          if (!oldestCached) {
            throw new OfflineVaultCapacityError(`Only ${OFFLINE_VAULT_MAX_DRAFTS} offline drafts can be kept`)
          }
          delete state.drafts[oldestCached.sessionId]
        }
        state.drafts[sessionId] = { sessionId, text, updatedAt: now, dirty }
      }
    }, expectedScope)
    this.assertUserMutationCommitted(committed)
  }

  async deleteDraft(sessionId: string, expectedScope: OfflineVaultScopeToken): Promise<void> {
    const committed = await this.mutate((state) => { delete state.drafts[sessionId] }, expectedScope)
    this.assertUserMutationCommitted(committed)
  }

  async mergeRemoteDrafts(
    drafts: Record<string, SessionDraft>,
    expectedScope?: OfflineVaultScopeToken,
  ): Promise<void> {
    await this.mutate((state, now) => {
      const allowedSessionIds = new Set(state.sessions.map((snapshot) => snapshot.id))
      const dirtyEntries = Object.values(state.drafts)
        // Never discard local edits just because their snapshot aged out or
        // was not among the ten most recent sessions.
        .filter((draft) => draft.dirty)
        .sort((left, right) => right.updatedAt - left.updatedAt)
      const nextDrafts = Object.fromEntries(dirtyEntries.map((draft) => [draft.sessionId, draft]))
      let remaining = OFFLINE_VAULT_MAX_DRAFTS - dirtyEntries.length
      for (const [sessionId, draft] of Object.entries(drafts)) {
        if (remaining <= 0 || nextDrafts[sessionId] || !allowedSessionIds.has(sessionId)) continue
        if (typeof draft.text !== 'string' || draft.text.length === 0 || draft.text.length > OFFLINE_VAULT_MAX_DRAFT_CHARS) continue
        nextDrafts[sessionId] = { sessionId, text: draft.text, updatedAt: now, dirty: false }
        remaining -= 1
      }
      state.drafts = nextDrafts
      state.lastSyncAt = now
    }, expectedScope)
  }

  async enqueueMessage(input: {
    sessionId: string
    sessionName: string
    text: string
    anchor: OfflineSessionAnchor
  }, expectedScope: OfflineVaultScopeToken): Promise<OfflineOutboxItem> {
    const item: OfflineOutboxItem = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      sessionName: boundedText(input.sessionName, 240),
      text: userText(input.text, OFFLINE_VAULT_MAX_DRAFT_CHARS, 'Outbox message'),
      createdAt: Date.now(),
      anchor: input.anchor,
      status: 'pending',
    }
    if (!item.text.trim()) throw new Error('Cannot queue an empty message')
    const committed = await this.mutate((state) => {
      if (state.outbox.length >= OFFLINE_VAULT_MAX_OUTBOX_ITEMS) {
        throw new OfflineVaultCapacityError(`The offline outbox is full (${OFFLINE_VAULT_MAX_OUTBOX_ITEMS} items)`)
      }
      state.outbox = [...state.outbox, item]
      delete state.drafts[item.sessionId]
    }, expectedScope)
    this.assertUserMutationCommitted(committed)
    return item
  }

  async beginOutboxSend(id: string, expectedScope: OfflineVaultScopeToken): Promise<void> {
    const committed = await this.mutate((state) => {
      const index = state.outbox.findIndex((item) => item.id === id)
      if (index < 0 || state.outbox[index].status !== 'pending') {
        throw new Error('Outbox item is no longer eligible for sending')
      }
      state.outbox[index] = {
        ...state.outbox[index],
        status: 'uncertain',
        failureKind: 'unknown',
      }
    }, expectedScope)
    this.assertUserMutationCommitted(committed)
  }

  async restoreOutboxAfterContextRejection(id: string, expectedScope: OfflineVaultScopeToken): Promise<void> {
    const committed = await this.mutate((state) => {
      const index = state.outbox.findIndex((item) => item.id === id)
      if (index < 0) return
      const item = state.outbox[index]
      if (item.status !== 'uncertain' || item.failureKind !== 'unknown') return
      state.outbox[index] = {
        ...item,
        status: 'pending',
        failureKind: 'context-changed',
      }
    }, expectedScope)
    this.assertUserMutationCommitted(committed)
  }

  async markOutboxFailure(
    id: string,
    failureKind: OfflineOutboxItem['failureKind'],
    expectedScope: OfflineVaultScopeToken,
    status: OfflineOutboxStatus = 'pending',
  ): Promise<void> {
    const committed = await this.mutate((state) => {
      state.outbox = state.outbox.map((item) => item.id === id
        // Once a network send may have reached the host, no concurrent review
        // or stale failure callback may make the item retryable again.
        ? item.status === 'uncertain'
          ? item
          : { ...item, status, failureKind }
        : item)
    }, expectedScope)
    this.assertUserMutationCommitted(committed)
  }

  async removeOutbox(id: string, expectedScope: OfflineVaultScopeToken): Promise<void> {
    const committed = await this.mutate((state) => {
      state.outbox = state.outbox.filter((item) => item.id !== id)
    }, expectedScope)
    this.assertUserMutationCommitted(committed)
  }

  async togglePin(
    input: Omit<OfflinePin, 'id' | 'createdAt'>,
    expectedScope: OfflineVaultScopeToken,
  ): Promise<void> {
    const committed = await this.mutate((state, now) => {
      const existing = state.pins.find((pin) => pin.sessionId === input.sessionId && pin.messageId === input.messageId)
      if (existing) {
        state.pins = state.pins.filter((pin) => pin.id !== existing.id)
      } else {
        if (state.pins.length >= OFFLINE_VAULT_MAX_PINS) {
          throw new OfflineVaultCapacityError(`Only ${OFFLINE_VAULT_MAX_PINS} offline pins can be kept`)
        }
        state.pins = [...state.pins, {
          ...input,
          id: crypto.randomUUID(),
          text: userText(input.text, OFFLINE_VAULT_MAX_MESSAGE_CHARS, 'Pinned text'),
          createdAt: now,
        }]
      }
    }, expectedScope)
    this.assertUserMutationCommitted(committed)
  }

  async pruneExpired(): Promise<void> {
    // mutate() normalizes against the current clock before persisting.
    await this.mutate(() => {})
  }

  estimatePlaintextBytes(): number {
    return new TextEncoder().encode(JSON.stringify(this.state)).byteLength
  }
}

let singleton: OfflineVault | null = null

export function getOfflineVault(): OfflineVault {
  singleton ??= new OfflineVault()
  return singleton
}
