/**
 * Opt-in encrypted storage for the Remote PWA.
 *
 * CacheStorage deliberately remains limited to the public application shell.
 * Private user data lives in one bounded AES-GCM payload in IndexedDB. The
 * CryptoKey is non-extractable and is itself persisted by structured clone;
 * browsers which cannot persist it fail closed instead of storing raw key
 * material.
 */
import type { Session } from "@craft-agent/shared/protocol";

export const OFFLINE_VAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const OFFLINE_VAULT_MAX_SESSIONS = 10;

export const OFFLINE_VAULT_MAX_MESSAGES_PER_SESSION = 50;

export const OFFLINE_VAULT_MAX_MESSAGE_CHARS = 12000;

export const OFFLINE_VAULT_MAX_DRAFT_CHARS = 24000;

export const OFFLINE_VAULT_MAX_DRAFTS = 10;

export const OFFLINE_VAULT_MAX_OUTBOX_ITEMS = 30;

export const OFFLINE_VAULT_MAX_PINS = 50;

export const CONSENT_KEY = 'robb-agents.remote.offline-enabled.v1';

export const REVOCATION_PENDING_KEY = 'robb-agents.remote.offline-revocation-pending.v1';

export const STATE_VERSION = 1;

export const AES_GCM_IV_BYTES = 12;

export type OfflineMessageRole = 'user' | 'assistant' | 'plan' | 'error';

export interface OfflineVaultScope {
    deviceId: string;
    workspaceId: string;
    expiresAt: string;
    hostLabel: string;
}

export interface OfflineVaultScopeToken {
    generation: number;
    deviceId: string;
    workspaceId: string;
}

export interface OfflineMessage {
    id: string;
    role: OfflineMessageRole;
    content: string;
    timestamp: number;
}

export interface OfflineSessionAnchor {
    messageCount: number;
    lastFinalMessageId: string | null;
    lastMessageAt: number;
}

export interface OfflineSessionSnapshot {
    id: string;
    workspaceId: string;
    name: string;
    preview: string;
    lastMessageAt: number;
    capturedAt: number;
    anchor: OfflineSessionAnchor;
    messages: OfflineMessage[];
}

export interface OfflineDraft {
    sessionId: string;
    text: string;
    updatedAt: number;
    dirty: boolean;
}

export type OfflineOutboxStatus = 'pending' | 'uncertain';

export interface OfflineOutboxItem {
    id: string;
    sessionId: string;
    sessionName: string;
    text: string;
    createdAt: number;
    anchor: OfflineSessionAnchor;
    status: OfflineOutboxStatus;
    failureKind?: 'connection-lost' | 'context-changed' | 'session-busy' | 'session-missing' | 'unknown';
}

export interface OfflinePin {
    id: string;
    sessionId: string;
    messageId: string;
    role: OfflineMessageRole;
    text: string;
    createdAt: number;
}

export interface OfflineVaultState {
    version: 1;
    scope: OfflineVaultScope | null;
    sessions: OfflineSessionSnapshot[];
    drafts: Record<string, OfflineDraft>;
    outbox: OfflineOutboxItem[];
    pins: OfflinePin[];
    lastSyncAt: number | null;
    updatedAt: number;
}

export class OfflineVaultUnavailableError extends Error {
    constructor(message = 'Encrypted offline storage is unavailable in this browser') {
        super(message);
        this.name = 'OfflineVaultUnavailableError';
    }
}

export class OfflineVaultCapacityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OfflineVaultCapacityError';
    }
}

export class OfflineVaultConflictError extends OfflineVaultUnavailableError {
    constructor() {
        super('Offline data changed in another tab. Reload before editing it again.');
        this.name = 'OfflineVaultConflictError';
    }
}

export function emptyState(now = Date.now()): OfflineVaultState {
    return {
        version: STATE_VERSION,
        scope: null,
        sessions: [],
        drafts: {},
        outbox: [],
        pins: [],
        lastSyncAt: null,
        updatedAt: now,
    };
}

export function cloneState(state: OfflineVaultState): OfflineVaultState {
    return structuredClone(state);
}

export function finiteTimestamp(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function boundedText(value: unknown, maxChars: number): string {
    if (typeof value !== 'string')
        return '';
    return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

export function userText(value: unknown, maxChars: number, label: string): string {
    const text = typeof value === 'string' ? value : '';
    if (text.length > maxChars) {
        throw new OfflineVaultCapacityError(`${label} exceeds the ${maxChars.toLocaleString()} character offline limit`);
    }
    return text;
}

export function isOfflineMessageRole(value: unknown): value is OfflineMessageRole {
    return value === 'user' || value === 'assistant' || value === 'plan' || value === 'error';
}

export function sanitizeSessionSnapshot(session: Session, now = Date.now()): OfflineSessionSnapshot {
    const messages = (Array.isArray(session.messages) ? session.messages : [])
        .filter((message) => !message.hidden && isOfflineMessageRole(message.role))
        .map((message): OfflineMessage => ({
        id: boundedText(message.id, 256),
        role: message.role as OfflineMessageRole,
        content: boundedText(message.content, OFFLINE_VAULT_MAX_MESSAGE_CHARS),
        timestamp: finiteTimestamp(message.timestamp, now),
    }))
        .filter((message) => message.id.length > 0 && message.content.length > 0)
        .slice(-OFFLINE_VAULT_MAX_MESSAGES_PER_SESSION);
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
    };
}

export function selectRecentSessions(sessions: readonly Session[]): Session[] {
    return sessions
        .filter((session) => !session.hidden && !session.isArchived)
        .sort((left, right) => right.lastMessageAt - left.lastMessageAt)
        .slice(0, OFFLINE_VAULT_MAX_SESSIONS);
}

export function searchOfflineSessions(sessions: readonly OfflineSessionSnapshot[], query: string): OfflineSessionSnapshot[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery)
        return [...sessions];
    return sessions.filter((session) => {
        const haystack = [
            session.name,
            session.preview,
            ...session.messages.map((message) => message.content),
        ].join('\n').toLocaleLowerCase();
        return haystack.includes(normalizedQuery);
    });
}

export function anchorsMatch(expected: OfflineSessionAnchor, actual: OfflineSessionAnchor): boolean {
    return expected.messageCount === actual.messageCount
        && expected.lastFinalMessageId === actual.lastFinalMessageId
        && expected.lastMessageAt === actual.lastMessageAt;
}

export function isScopeExpired(scope: OfflineVaultScope | null, now = Date.now()): boolean {
    if (!scope)
        return false;
    const expiry = Date.parse(scope.expiresAt);
    return !Number.isFinite(expiry) || expiry <= now;
}

export function nextOfflineRetentionDeadline(state: OfflineVaultState): number | null {
    const timestamps = [
        ...state.sessions.map((entry) => entry.capturedAt),
        ...Object.values(state.drafts).map((entry) => entry.updatedAt),
        ...state.outbox.map((entry) => entry.createdAt),
        ...state.pins.map((entry) => entry.createdAt),
    ].filter((value) => Number.isFinite(value) && value >= 0);
    return timestamps.length > 0
        ? Math.min(...timestamps) + OFFLINE_VAULT_RETENTION_MS + 1
        : null;
}

export function normalizeScope(value: unknown): OfflineVaultScope | null {
    if (!value || typeof value !== 'object')
        return null;
    const scope = value as Partial<OfflineVaultScope>;
    if (typeof scope.deviceId !== 'string'
        || typeof scope.workspaceId !== 'string'
        || typeof scope.expiresAt !== 'string'
        || typeof scope.hostLabel !== 'string'
        || scope.deviceId.length === 0
        || scope.workspaceId.length === 0
        || scope.deviceId.length > 256
        || scope.workspaceId.length > 256)
        return null;
    return {
        deviceId: scope.deviceId,
        workspaceId: scope.workspaceId,
        expiresAt: scope.expiresAt,
        hostLabel: boundedText(scope.hostLabel, 240),
    };
}

export function normalizeState(value: unknown, now: number): OfflineVaultState {
    if (!value || typeof value !== 'object')
        return emptyState(now);
    const candidate = value as Partial<OfflineVaultState>;
    if (candidate.version !== STATE_VERSION)
        return emptyState(now);
    const retentionFloor = now - OFFLINE_VAULT_RETENTION_MS;
    const sessions = Array.isArray(candidate.sessions)
        ? candidate.sessions
            .filter((session): session is OfflineSessionSnapshot => Boolean(session
            && typeof session.id === 'string'
            && typeof session.workspaceId === 'string'
            && typeof session.capturedAt === 'number'
            && session.capturedAt >= retentionFloor))
            .sort((left, right) => right.lastMessageAt - left.lastMessageAt)
            .slice(0, OFFLINE_VAULT_MAX_SESSIONS)
        : [];
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
        .slice(0, OFFLINE_VAULT_MAX_DRAFTS);
    const drafts = Object.fromEntries(draftEntries);
    const outbox = Array.isArray(candidate.outbox)
        ? candidate.outbox
            .filter((item) => item && typeof item.id === 'string' && item.createdAt >= retentionFloor)
            .slice(-OFFLINE_VAULT_MAX_OUTBOX_ITEMS)
        : [];
    const pins = Array.isArray(candidate.pins)
        ? candidate.pins
            .filter((pin) => pin && typeof pin.id === 'string' && pin.createdAt >= retentionFloor)
            .slice(-OFFLINE_VAULT_MAX_PINS)
        : [];
    const state: OfflineVaultState = {
        version: STATE_VERSION,
        scope: normalizeScope(candidate.scope),
        sessions,
        drafts,
        outbox,
        pins,
        lastSyncAt: candidate.lastSyncAt == null ? null : finiteTimestamp(candidate.lastSyncAt, now),
        updatedAt: finiteTimestamp(candidate.updatedAt, now),
    };
    return isScopeExpired(state.scope, now) ? emptyState(now) : state;
}

export function consentStorage(): Storage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    }
    catch {
        return null;
    }
}

export function isOfflineVaultEnabled(): boolean {
    try {
        return consentStorage()?.getItem(CONSENT_KEY) === 'true';
    }
    catch {
        return false;
    }
}

export function isOfflineVaultRevocationPending(): boolean {
    try {
        return consentStorage()?.getItem(REVOCATION_PENDING_KEY) === 'true';
    }
    catch {
        // An unreadable revocation marker must never be treated as proof that it
        // is safe to reopen private data. The consent gate will also fail closed
        // when the same storage is unavailable.
        return true;
    }
}

export function setOfflineVaultRevocationPending(pending: boolean): void {
    const storage = consentStorage();
    if (!storage)
        throw new OfflineVaultUnavailableError('Local storage is unavailable');
    try {
        if (pending)
            storage.setItem(REVOCATION_PENDING_KEY, 'true');
        else
            storage.removeItem(REVOCATION_PENDING_KEY);
    }
    catch {
        throw new OfflineVaultUnavailableError('Offline revocation state could not be persisted');
    }
}

export function setOfflineVaultConsent(enabled: boolean): void {
    const storage = consentStorage();
    if (!storage) {
        throw new OfflineVaultUnavailableError('Local storage is unavailable');
    }
    try {
        if (enabled)
            storage.setItem(CONSENT_KEY, 'true');
        else
            storage.removeItem(CONSENT_KEY);
    }
    catch {
        throw new OfflineVaultUnavailableError(enabled ? 'Local storage is unavailable' : 'Offline consent could not be revoked');
    }
}

export function boundedSnapshots(state: OfflineVaultState, incoming: readonly OfflineSessionSnapshot[]): OfflineSessionSnapshot[] {
    const incomingById = new Map(incoming.map((snapshot) => [snapshot.id, snapshot]));
    const currentById = new Map(state.sessions.map((snapshot) => [snapshot.id, snapshot]));
    const protectedIds = Object.values(state.drafts)
        .filter((draft) => draft.dirty)
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((draft) => draft.sessionId);
    const protectedSnapshots = protectedIds.flatMap((sessionId) => {
        const snapshot = incomingById.get(sessionId) ?? currentById.get(sessionId);
        return snapshot ? [snapshot] : [];
    });
    const protectedSet = new Set(protectedSnapshots.map((snapshot) => snapshot.id));
    const remaining = incoming
        .filter((snapshot) => !protectedSet.has(snapshot.id))
        .sort((left, right) => right.lastMessageAt - left.lastMessageAt);
    return [...protectedSnapshots, ...remaining].slice(0, OFFLINE_VAULT_MAX_SESSIONS);
}
