
export const MEMORY_V2_FILENAME = 'memory.v2.jsonl';

export const MEMORY_V2_SCHEMA_VERSION = 2 as const;

export const MEMORY_V2_LOCK_SUFFIX = '.lock';

export const MEMORY_V2_STALE_LOCK_MS = 5 * 60 * 1000;

export type MemoryKind =
  | 'goal'
  | 'decision'
  | 'fact'
  | 'preference'
  | 'procedure'
  | 'constraint'
  | 'artifact'
  | 'observation';

export type MemoryStatus =
  | 'proposed'
  | 'active'
  | 'superseded'
  | 'contradicted'
  | 'forgotten';

export type MemorySourceType =
  | 'user'
  | 'assistant'
  | 'session'
  | 'tool'
  | 'artifact'
  | 'import'
  | 'memory-md';

export interface MemoryProvenance {
  sourceType: MemorySourceType;
  /** Stable local identifier (session, tool call, artifact, import batch). */
  sourceId?: string;
  /** Optional portable URI; never dereferenced by the memory layer. */
  uri?: string;
  /** Actor that asserted or captured this memory. */
  actorId?: string;
  capturedAt: string;
}

export interface ProjectMemoryEntry {
  id: string;
  kind: MemoryKind;
  content: string;
  tags: string[];
  provenance: MemoryProvenance;
  /** Epistemic confidence from 0 (unknown) to 1 (verified). */
  confidence: number;
  createdAt: string;
  updatedAt: string;
  /** Business-time validity, distinct from storage lifetime. */
  validFrom: string;
  validUntil?: string;
  /** Storage lifetime. Once reached, retrieval excludes the entry. */
  expiresAt?: string;
  status: MemoryStatus;
  supersedesIds: string[];
  contradictsIds: string[];
  /** Project binding is persisted, so copying a journal cannot transfer authority. */
  scope?: { projectSlug: string; workspaceKey?: string; version?: string };
}

export interface CreateProjectMemoryEntryInput {
  id?: string;
  kind: MemoryKind;
  content: string;
  tags?: string[];
  provenance: Omit<MemoryProvenance, 'capturedAt'> & { capturedAt?: string };
  confidence?: number;
  createdAt?: string;
  validFrom?: string;
  validUntil?: string;
  expiresAt?: string;
  /** Convenience local retention policy; mutually exclusive with expiresAt. */
  ttlDays?: number;
  status?: MemoryStatus;
  supersedesIds?: string[];
  contradictsIds?: string[];
  scope?: { projectSlug: string; workspaceKey?: string; version?: string };
}

export interface MemoryJournalEvent {
  schemaVersion: typeof MEMORY_V2_SCHEMA_VERSION;
  eventId: string;
  eventType: 'put';
  recordedAt: string;
  entry: ProjectMemoryEntry;
}

export interface StoredMemoryJournalRecord {
  payload: MemoryJournalEvent;
  checksum: string;
}

export type MemoryJournalIssueCode =
  | 'trailing_partial_record'
  | 'invalid_json'
  | 'invalid_record'
  | 'checksum_mismatch';

export interface MemoryJournalIssue {
  line: number;
  code: MemoryJournalIssueCode;
  message: string;
}

export interface LoadMemoryJournalOptions {
  /** Throw when any corrupt record is found instead of returning valid records plus issues. */
  strict?: boolean;
  /** Evaluation time for derived supersession/contradiction state. */
  now?: Date;
  /** Exact lexical workspace path used by pre-physical-identity journals. The
   * journal is still opened only below `workspaceRootPath`; this value grants
   * compatibility for one historical scope key, never a second I/O root. */
  legacyWorkspaceRootPath?: string;
}

export interface LoadedProjectMemoryJournal {
  entries: ProjectMemoryEntry[];
  validEventCount: number;
  issues: MemoryJournalIssue[];
}

export interface MemoryScoreBreakdown {
  lexical: number;
  recency: number;
  confidence: number;
  vector: number;
}

export interface RetrievedProjectMemory {
  entry: ProjectMemoryEntry;
  score: number;
  scoreBreakdown: MemoryScoreBreakdown;
}

export interface MemoryRetrievalWeights {
  lexical: number;
  recency: number;
  confidence: number;
  vector: number;
}

export interface RetrieveProjectMemoryOptions {
  projectSlug?: string;
  workspaceKey?: string;
  /** Version-bound observations require an exact current version; no version is not a match. */
  version?: string;
  maxAgeDays?: number;
  /** Do not fill the context with unrelated memories when a query is supplied. */
  requireQueryMatch?: boolean;
  query?: string;
  now?: Date;
  kinds?: MemoryKind[];
  maxEntries?: number;
  /**
   * Optional scores from a local embedding index. When absent, a bounded
   * deterministic French/English concept matcher complements lexical search.
   */
  vectorScores?: Readonly<Record<string, number>>;
  weights?: Partial<MemoryRetrievalWeights>;
  recencyHalfLifeDays?: number;
}

export interface LoadProjectMemoryV2ContextOptions extends RetrieveProjectMemoryOptions {
  maxTokens?: number;
  /** See LoadMemoryJournalOptions.legacyWorkspaceRootPath. */
  legacyWorkspaceRootPath?: string;
}

const MEMORY_KINDS = new Set<MemoryKind>([
  'goal',
  'decision',
  'fact',
  'preference',
  'procedure',
  'constraint',
  'artifact',
  'observation',
]);

const MEMORY_STATUSES = new Set<MemoryStatus>([
  'proposed',
  'active',
  'superseded',
  'contradicted',
  'forgotten',
]);

const MEMORY_SOURCE_TYPES = new Set<MemorySourceType>([
  'user',
  'assistant',
  'session',
  'tool',
  'artifact',
  'import',
  'memory-md',
]);

export const DEFAULT_RETRIEVAL_WEIGHTS: MemoryRetrievalWeights = {
  lexical: 0.5,
  recency: 0.25,
  confidence: 0.15,
  vector: 0.1,
};

export const DAY_MS = 24 * 60 * 60 * 1000;

export function assertMemoryKind(value: unknown): MemoryKind {
  if (typeof value !== 'string' || !MEMORY_KINDS.has(value as MemoryKind)) {
    throw new Error(`Unsupported memory kind: ${String(value)}`);
  }
  return value as MemoryKind;
}

export function assertMemoryStatus(value: unknown): MemoryStatus {
  if (typeof value !== 'string' || !MEMORY_STATUSES.has(value as MemoryStatus)) {
    throw new Error(`Unsupported memory status: ${String(value)}`);
  }
  return value as MemoryStatus;
}

export function assertMemorySourceType(value: unknown): MemorySourceType {
  if (typeof value !== 'string' || !MEMORY_SOURCE_TYPES.has(value as MemorySourceType)) {
    throw new Error(`Unsupported memory source type: ${String(value)}`);
  }
  return value as MemorySourceType;
}

export function normalizeContent(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Memory content must be a non-empty string');
  }
  return value.trim();
}

export function normalizeIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.length > 512) throw new Error(`${field} exceeds 512 characters`);
  return value.trim();
}

export function normalizeConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('confidence must be a finite number between 0 and 1');
  }
  return value;
}

export function normalizeIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be a valid ISO timestamp`);
  }
  return new Date(value).toISOString();
}

export function normalizeStringList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function parseStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return normalizeStringList(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
