/**
 * Project Memory v2
 *
 * Local-first, append-only structured memory for a project. MEMORY.md remains
 * supported as a human-editable legacy source; this journal adds machine
 * readable provenance, temporal validity, confidence, lifecycle, and retrieval.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { createHash, randomUUID } from 'crypto';
import { join } from 'path';
import { estimateTokensDensityAware } from '../utils/large-response.ts';

export const MEMORY_V2_FILENAME = 'memory.v2.jsonl';
export const MEMORY_V2_SCHEMA_VERSION = 2 as const;
const MEMORY_V2_LOCK_SUFFIX = '.lock';
const MEMORY_V2_STALE_LOCK_MS = 5 * 60 * 1000;

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
}

interface MemoryJournalEvent {
  schemaVersion: typeof MEMORY_V2_SCHEMA_VERSION;
  eventId: string;
  eventType: 'put';
  recordedAt: string;
  entry: ProjectMemoryEntry;
}

interface StoredMemoryJournalRecord {
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
  query?: string;
  now?: Date;
  kinds?: MemoryKind[];
  maxEntries?: number;
  /**
   * Optional semantic scores supplied by a future local embedding index.
   * The lexical retriever stays fully functional when this is omitted.
   */
  vectorScores?: Readonly<Record<string, number>>;
  weights?: Partial<MemoryRetrievalWeights>;
  recencyHalfLifeDays?: number;
}

export interface LoadProjectMemoryV2ContextOptions extends RetrieveProjectMemoryOptions {
  maxTokens?: number;
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

const DEFAULT_RETRIEVAL_WEIGHTS: MemoryRetrievalWeights = {
  lexical: 0.5,
  recency: 0.25,
  confidence: 0.15,
  vector: 0.1,
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function getProjectMemoryJournalPath(
  workspaceRootPath: string,
  projectSlug: string,
): string {
  return join(workspaceRootPath, 'projects', projectSlug, MEMORY_V2_FILENAME);
}

/**
 * Append a full entry snapshot to the journal and fsync it before returning.
 * A checksum detects torn or edited records; the reader tolerates only an
 * incomplete final line by default and reports every other issue.
 */
export function appendProjectMemoryEntry(
  workspaceRootPath: string,
  projectSlug: string,
  input: CreateProjectMemoryEntryInput,
  now = new Date(),
): ProjectMemoryEntry {
  const nowIso = now.toISOString();
  const createdAt = normalizeIsoTimestamp(input.createdAt ?? nowIso, 'createdAt');
  const capturedAt = normalizeIsoTimestamp(
    input.provenance.capturedAt ?? createdAt,
    'provenance.capturedAt',
  );
  const validFrom = normalizeIsoTimestamp(input.validFrom ?? createdAt, 'validFrom');
  const validUntil = input.validUntil
    ? normalizeIsoTimestamp(input.validUntil, 'validUntil')
    : undefined;

  if (validUntil && Date.parse(validUntil) <= Date.parse(validFrom)) {
    throw new Error('validUntil must be after validFrom');
  }
  if (input.expiresAt && input.ttlDays !== undefined) {
    throw new Error('expiresAt and ttlDays are mutually exclusive');
  }
  if (input.ttlDays !== undefined && (!Number.isFinite(input.ttlDays) || input.ttlDays <= 0)) {
    throw new Error('ttlDays must be a positive finite number');
  }

  const expiresAt = input.expiresAt
    ? normalizeIsoTimestamp(input.expiresAt, 'expiresAt')
    : input.ttlDays !== undefined
      ? new Date(Date.parse(createdAt) + input.ttlDays * DAY_MS).toISOString()
      : undefined;

  const entry: ProjectMemoryEntry = {
    id: normalizeIdentifier(input.id ?? `mem_${randomUUID()}`, 'id'),
    kind: assertMemoryKind(input.kind),
    content: normalizeContent(input.content),
    tags: normalizeStringList(input.tags ?? []),
    provenance: {
      sourceType: assertMemorySourceType(input.provenance.sourceType),
      ...(input.provenance.sourceId
        ? { sourceId: normalizeIdentifier(input.provenance.sourceId, 'provenance.sourceId') }
        : {}),
      ...(input.provenance.uri ? { uri: input.provenance.uri.trim() } : {}),
      ...(input.provenance.actorId
        ? { actorId: normalizeIdentifier(input.provenance.actorId, 'provenance.actorId') }
        : {}),
      capturedAt,
    },
    confidence: normalizeConfidence(input.confidence ?? 0.7),
    createdAt,
    updatedAt: nowIso,
    validFrom,
    ...(validUntil ? { validUntil } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    status: assertMemoryStatus(input.status ?? 'active'),
    supersedesIds: normalizeStringList(input.supersedesIds ?? []),
    contradictsIds: normalizeStringList(input.contradictsIds ?? []),
  };

  appendMemoryJournalSnapshot(workspaceRootPath, projectSlug, entry, nowIso);
  return entry;
}

/**
 * Append a lifecycle revision. No previous record is mutated or removed.
 */
export function setProjectMemoryStatus(
  workspaceRootPath: string,
  projectSlug: string,
  entryId: string,
  status: MemoryStatus,
  now = new Date(),
): ProjectMemoryEntry {
  const loaded = loadProjectMemoryJournal(workspaceRootPath, projectSlug, { strict: true });
  const current = loaded.entries.find((entry) => entry.id === entryId);
  if (!current) {
    throw new Error(`Memory entry not found: ${entryId}`);
  }

  const updated: ProjectMemoryEntry = {
    ...current,
    status: assertMemoryStatus(status),
    updatedAt: now.toISOString(),
  };
  appendMemoryJournalSnapshot(
    workspaceRootPath,
    projectSlug,
    updated,
    updated.updatedAt,
  );
  return updated;
}

/** Explicit, append-only forgetting via a tombstone-like full revision. */
export function forgetProjectMemoryEntry(
  workspaceRootPath: string,
  projectSlug: string,
  entryId: string,
  now = new Date(),
): ProjectMemoryEntry {
  return setProjectMemoryStatus(workspaceRootPath, projectSlug, entryId, 'forgotten', now);
}

export function loadProjectMemoryJournal(
  workspaceRootPath: string,
  projectSlug: string,
  options?: LoadMemoryJournalOptions,
): LoadedProjectMemoryJournal {
  const path = getProjectMemoryJournalPath(workspaceRootPath, projectSlug);
  if (!existsSync(path)) {
    return { entries: [], validEventCount: 0, issues: [] };
  }

  const content = readFileSync(path, 'utf8');
  if (!content) {
    return { entries: [], validEventCount: 0, issues: [] };
  }

  const hasFinalNewline = content.endsWith('\n');
  const rawLines = content.split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();

  const latestById = new Map<string, ProjectMemoryEntry>();
  const issues: MemoryJournalIssue[] = [];
  let validEventCount = 0;

  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index];
    if (!raw?.trim()) continue;

    const isIncompleteTail = index === rawLines.length - 1 && !hasFinalNewline;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      issues.push({
        line: index + 1,
        code: isIncompleteTail ? 'trailing_partial_record' : 'invalid_json',
        message: isIncompleteTail
          ? 'Ignored an incomplete final journal record'
          : 'Journal line is not valid JSON',
      });
      continue;
    }

    const parsed = parseStoredRecord(decoded);
    if (!parsed.ok) {
      issues.push({
        line: index + 1,
        code: parsed.code,
        message: parsed.message,
      });
      continue;
    }

    validEventCount += 1;
    latestById.set(parsed.record.payload.entry.id, parsed.record.payload.entry);
  }

  if (options?.strict && issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `Memory journal validation failed at line ${first?.line ?? 0}: ${first?.message ?? 'unknown issue'}`,
    );
  }

  return {
    entries: deriveRelationshipStatuses(
      [...latestById.values()],
      options?.now ?? new Date(),
    ),
    validEventCount,
    issues,
  };
}

export function retrieveProjectMemories(
  entries: ProjectMemoryEntry[],
  options?: RetrieveProjectMemoryOptions,
): RetrievedProjectMemory[] {
  const now = options?.now ?? new Date();
  const queryTokens = tokenize(options?.query ?? '');
  const kindFilter = options?.kinds ? new Set(options.kinds) : null;
  const vectorScores = options?.vectorScores;
  const weights = normalizeWeights(options?.weights, vectorScores !== undefined);
  const halfLifeDays = options?.recencyHalfLifeDays ?? 30;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    throw new Error('recencyHalfLifeDays must be a positive finite number');
  }

  return entries
    .filter((entry) => isMemoryEntryRetrievable(entry, now))
    .filter((entry) => !kindFilter || kindFilter.has(entry.kind))
    .map((entry): RetrievedProjectMemory => {
      const lexical = lexicalScore(entry, queryTokens);
      const ageDays = Math.max(0, now.getTime() - Date.parse(entry.updatedAt)) / DAY_MS;
      const recency = Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
      const vector = clamp01(vectorScores?.[entry.id] ?? 0);
      const scoreBreakdown: MemoryScoreBreakdown = {
        lexical,
        recency,
        confidence: entry.confidence,
        vector,
      };
      const score =
        lexical * weights.lexical +
        recency * weights.recency +
        entry.confidence * weights.confidence +
        vector * weights.vector;
      return { entry, score, scoreBreakdown };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const timeDelta = Date.parse(right.entry.updatedAt) - Date.parse(left.entry.updatedAt);
      return timeDelta !== 0 ? timeDelta : left.entry.id.localeCompare(right.entry.id);
    })
    .slice(0, options?.maxEntries ?? 12);
}

export function loadProjectMemoryV2Context(
  workspaceRootPath: string,
  projectSlug: string,
  options?: LoadProjectMemoryV2ContextOptions,
): string | null {
  const loaded = loadProjectMemoryJournal(workspaceRootPath, projectSlug, {
    now: options?.now,
  });
  const retrieved = retrieveProjectMemories(loaded.entries, options);
  if (retrieved.length === 0) return null;

  const lines = ['# Structured project memory'];
  for (const result of retrieved) {
    const entry = result.entry;
    const temporal = [
      `valid from ${entry.validFrom}`,
      ...(entry.validUntil ? [`until ${entry.validUntil}`] : []),
      ...(entry.expiresAt ? [`expires ${entry.expiresAt}`] : []),
    ].join(', ');
    const source = [
      entry.provenance.sourceType,
      entry.provenance.sourceId,
    ].filter((part): part is string => Boolean(part)).join(':');
    lines.push(
      `- [${entry.kind}] ${entry.content}`,
      `  confidence=${entry.confidence.toFixed(2)}; source=${source}; ${temporal}; id=${entry.id}`,
    );
  }

  if (loaded.issues.length > 0) {
    lines.push(
      `- [journal-warning] ${loaded.issues.length} invalid or incomplete record(s) were excluded.`,
    );
  }

  return fitTextToTokenBudget(
    lines.join('\n'),
    options?.maxTokens ?? 3000,
    '\n…[structured memory truncated to context budget]',
  );
}

function appendMemoryJournalSnapshot(
  workspaceRootPath: string,
  projectSlug: string,
  entry: ProjectMemoryEntry,
  recordedAt: string,
): void {
  const path = getProjectMemoryJournalPath(workspaceRootPath, projectSlug);
  mkdirSync(join(workspaceRootPath, 'projects', projectSlug), { recursive: true });

  const payload: MemoryJournalEvent = {
    schemaVersion: MEMORY_V2_SCHEMA_VERSION,
    eventId: `mevt_${randomUUID()}`,
    eventType: 'put',
    recordedAt,
    entry,
  };
  const record: StoredMemoryJournalRecord = {
    payload,
    checksum: checksumPayload(payload),
  };
  const line = `${JSON.stringify(record)}\n`;

  withMemoryJournalLock(`${path}${MEMORY_V2_LOCK_SUFFIX}`, () => {
    repairIncompleteJournalTail(path);
    const descriptor = openSync(path, 'a', 0o600);
    try {
      const written = writeSync(descriptor, line, null, 'utf8');
      if (written !== Buffer.byteLength(line, 'utf8')) {
        throw new Error(`Incomplete memory journal append: wrote ${written} bytes`);
      }
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  });
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errnoCode(error) === 'ESRCH') return false;
    // EPERM means the process exists but is owned by another user.
    return true;
  }
}

function removeStaleMemoryJournalLock(lockPath: string): boolean {
  let initialStat: ReturnType<typeof statSync>;
  try {
    initialStat = statSync(lockPath);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return true;
    throw error;
  }

  let ownerIsDead = false;
  try {
    const raw: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (isRecord(raw) && typeof raw.pid === 'number') {
      ownerIsDead = !processIsAlive(raw.pid);
    }
  } catch {
    // An unreadable lock is only stale once its age exceeds the limit.
  }
  const expired = Date.now() - initialStat.mtimeMs > MEMORY_V2_STALE_LOCK_MS;
  if (!ownerIsDead && !expired) return false;

  try {
    const currentStat = statSync(lockPath);
    if (currentStat.dev !== initialStat.dev || currentStat.ino !== initialStat.ino) {
      return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return true;
    throw error;
  }
}

function withMemoryJournalLock<T>(lockPath: string, operation: () => T): T {
  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error;
      if (removeStaleMemoryJournalLock(lockPath)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  if (descriptor === undefined) {
    throw new Error(`Memory journal integrity lock unavailable: ${lockPath}`);
  }

  try {
    const metadata = JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    const written = writeSync(descriptor, metadata, null, 'utf8');
    if (written !== Buffer.byteLength(metadata, 'utf8')) {
      throw new Error(`Incomplete memory journal lock metadata: wrote ${written} bytes`);
    }
    fsyncSync(descriptor);
    return operation();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') throw error;
    }
  }
}

/**
 * Recover a torn final append before accepting a new event.
 *
 * The journal is append-only for committed records. A non-newline-terminated
 * tail is not a committed record, so startup-style WAL recovery truncates only
 * that fragment and fsyncs the repair before the next O_APPEND write.
 */
function repairIncompleteJournalTail(path: string): void {
  if (!existsSync(path)) return;

  const descriptor = openSync(path, 'r+');
  try {
    const size = fstatSync(descriptor).size;
    if (size === 0) return;

    const finalByte = Buffer.allocUnsafe(1);
    readSync(descriptor, finalByte, 0, 1, size - 1);
    if (finalByte[0] === 0x0a) return;

    const chunkSize = 64 * 1024;
    let cursor = size;
    let truncateAt = 0;
    while (cursor > 0) {
      const length = Math.min(chunkSize, cursor);
      const start = cursor - length;
      const chunk = Buffer.allocUnsafe(length);
      readSync(descriptor, chunk, 0, length, start);
      const newlineIndex = chunk.lastIndexOf(0x0a);
      if (newlineIndex >= 0) {
        truncateAt = start + newlineIndex + 1;
        break;
      }
      cursor = start;
    }

    // A complete checksummed record can be valid even when an external writer
    // was interrupted immediately before its newline. Commit that record by
    // adding the delimiter; only malformed tails are rolled back.
    const tailLength = size - truncateAt;
    const tail = Buffer.allocUnsafe(tailLength);
    readSync(descriptor, tail, 0, tailLength, truncateAt);
    let completeRecord = false;
    try {
      completeRecord = parseStoredRecord(JSON.parse(tail.toString('utf8'))).ok;
    } catch {
      completeRecord = false;
    }
    if (completeRecord) {
      const written = writeSync(descriptor, '\n', size, 'utf8');
      if (written !== 1) {
        throw new Error(`Incomplete memory journal recovery: wrote ${written} bytes`);
      }
      fsyncSync(descriptor);
      return;
    }

    // A torn or malformed tail is not committed and is truncated below.
    ftruncateSync(descriptor, truncateAt);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function parseStoredRecord(
  value: unknown,
):
  | { ok: true; record: StoredMemoryJournalRecord }
  | { ok: false; code: 'invalid_record' | 'checksum_mismatch'; message: string } {
  if (!isRecord(value) || !isRecord(value.payload) || typeof value.checksum !== 'string') {
    return { ok: false, code: 'invalid_record', message: 'Missing payload or checksum' };
  }

  const payload = value.payload;
  if (
    payload.schemaVersion !== MEMORY_V2_SCHEMA_VERSION ||
    typeof payload.eventId !== 'string' ||
    payload.eventType !== 'put' ||
    typeof payload.recordedAt !== 'string'
  ) {
    return { ok: false, code: 'invalid_record', message: 'Unsupported journal event shape' };
  }

  let entry: ProjectMemoryEntry;
  try {
    normalizeIsoTimestamp(payload.recordedAt, 'recordedAt');
    entry = parseProjectMemoryEntry(payload.entry);
  } catch (error) {
    return {
      ok: false,
      code: 'invalid_record',
      message: error instanceof Error ? error.message : 'Invalid memory entry',
    };
  }

  const event: MemoryJournalEvent = {
    schemaVersion: MEMORY_V2_SCHEMA_VERSION,
    eventId: payload.eventId,
    eventType: 'put',
    recordedAt: payload.recordedAt,
    entry,
  };
  if (checksumPayload(event) !== value.checksum) {
    return { ok: false, code: 'checksum_mismatch', message: 'Journal checksum mismatch' };
  }

  return {
    ok: true,
    record: { payload: event, checksum: value.checksum },
  };
}

function parseProjectMemoryEntry(value: unknown): ProjectMemoryEntry {
  if (!isRecord(value)) throw new Error('Memory entry must be an object');
  if (!isRecord(value.provenance)) throw new Error('Memory provenance must be an object');

  const provenance: MemoryProvenance = {
    sourceType: assertMemorySourceType(value.provenance.sourceType),
    ...(typeof value.provenance.sourceId === 'string'
      ? { sourceId: normalizeIdentifier(value.provenance.sourceId, 'provenance.sourceId') }
      : {}),
    ...(typeof value.provenance.uri === 'string' ? { uri: value.provenance.uri } : {}),
    ...(typeof value.provenance.actorId === 'string'
      ? { actorId: normalizeIdentifier(value.provenance.actorId, 'provenance.actorId') }
      : {}),
    capturedAt: normalizeIsoTimestamp(value.provenance.capturedAt, 'provenance.capturedAt'),
  };
  const validFrom = normalizeIsoTimestamp(value.validFrom, 'validFrom');
  const validUntil = typeof value.validUntil === 'string'
    ? normalizeIsoTimestamp(value.validUntil, 'validUntil')
    : undefined;
  if (validUntil && Date.parse(validUntil) <= Date.parse(validFrom)) {
    throw new Error('validUntil must be after validFrom');
  }

  return {
    id: normalizeIdentifier(value.id, 'id'),
    kind: assertMemoryKind(value.kind),
    content: normalizeContent(value.content),
    tags: parseStringList(value.tags, 'tags'),
    provenance,
    confidence: normalizeConfidence(value.confidence),
    createdAt: normalizeIsoTimestamp(value.createdAt, 'createdAt'),
    updatedAt: normalizeIsoTimestamp(value.updatedAt, 'updatedAt'),
    validFrom,
    ...(validUntil ? { validUntil } : {}),
    ...(typeof value.expiresAt === 'string'
      ? { expiresAt: normalizeIsoTimestamp(value.expiresAt, 'expiresAt') }
      : {}),
    status: assertMemoryStatus(value.status),
    supersedesIds: parseStringList(value.supersedesIds, 'supersedesIds'),
    contradictsIds: parseStringList(value.contradictsIds, 'contradictsIds'),
  };
}

function deriveRelationshipStatuses(
  entries: ProjectMemoryEntry[],
  now: Date,
): ProjectMemoryEntry[] {
  const statusById = new Map(entries.map((entry) => [entry.id, entry.status]));
  for (const entry of entries) {
    if (!isMemoryRelationEffective(entry, now)) continue;
    for (const id of entry.supersedesIds) {
      if (statusById.get(id) === 'active') statusById.set(id, 'superseded');
    }
    for (const id of entry.contradictsIds) {
      const current = statusById.get(id);
      if (current === 'active' || current === 'superseded') {
        statusById.set(id, 'contradicted');
      }
    }
  }
  return entries.map((entry) => ({
    ...entry,
    status: statusById.get(entry.id) ?? entry.status,
  }));
}

function isMemoryRelationEffective(entry: ProjectMemoryEntry, now: Date): boolean {
  const nowMs = now.getTime();
  if (entry.status === 'forgotten') return false;
  if (Date.parse(entry.validFrom) > nowMs) return false;
  if (entry.validUntil && Date.parse(entry.validUntil) <= nowMs) return false;
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= nowMs) return false;
  return true;
}

function isMemoryEntryRetrievable(entry: ProjectMemoryEntry, now: Date): boolean {
  const nowMs = now.getTime();
  if (entry.status !== 'active') return false;
  if (Date.parse(entry.validFrom) > nowMs) return false;
  if (entry.validUntil && Date.parse(entry.validUntil) <= nowMs) return false;
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= nowMs) return false;
  return true;
}

function lexicalScore(entry: ProjectMemoryEntry, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0.5;
  const documentTokens = tokenize(`${entry.kind} ${entry.tags.join(' ')} ${entry.content}`);
  if (documentTokens.length === 0) return 0;
  const documentCounts = new Map<string, number>();
  for (const token of documentTokens) {
    documentCounts.set(token, (documentCounts.get(token) ?? 0) + 1);
  }
  const uniqueQuery = [...new Set(queryTokens)];
  const matched = uniqueQuery.filter((token) => documentCounts.has(token));
  const coverage = matched.length / uniqueQuery.length;
  const frequency = matched.reduce(
    (total, token) => total + Math.min(3, documentCounts.get(token) ?? 0),
    0,
  ) / (uniqueQuery.length * 3);
  return clamp01(coverage * 0.8 + frequency * 0.2);
}

function tokenize(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('en-US')
    .split(/[^\p{Letter}\p{Number}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function normalizeWeights(
  partial: Partial<MemoryRetrievalWeights> | undefined,
  hasVectorScores: boolean,
): MemoryRetrievalWeights {
  const configured = { ...DEFAULT_RETRIEVAL_WEIGHTS, ...partial };
  const effective = {
    ...configured,
    vector: hasVectorScores ? configured.vector : 0,
    lexical: hasVectorScores
      ? configured.lexical
      : configured.lexical + configured.vector,
  };
  for (const [name, weight] of Object.entries(effective)) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`Memory retrieval weight ${name} must be finite and non-negative`);
    }
  }
  const total = effective.lexical + effective.recency + effective.confidence + effective.vector;
  if (total <= 0) throw new Error('At least one memory retrieval weight must be positive');
  return {
    lexical: effective.lexical / total,
    recency: effective.recency / total,
    confidence: effective.confidence / total,
    vector: effective.vector / total,
  };
}

function checksumPayload(payload: MemoryJournalEvent): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function fitTextToTokenBudget(text: string, maxTokens: number, marker: string): string {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error('maxTokens must be a positive finite number');
  }
  if (estimateTokensDensityAware(text) <= maxTokens) return text;

  const markerTokens = estimateTokensDensityAware(marker);
  if (markerTokens >= maxTokens) {
    return truncateTextToTokenBudget(marker, maxTokens);
  }
  const availableTokens = Math.max(0, maxTokens - markerTokens);
  const estimatedTokens = estimateTokensDensityAware(text);
  let charBudget = Math.floor((text.length / estimatedTokens) * availableTokens);
  let result = `${text.slice(0, charBudget).trimEnd()}${marker}`;
  while (charBudget > 0 && estimateTokensDensityAware(result) > maxTokens) {
    charBudget = Math.max(0, charBudget - Math.max(1, Math.ceil(charBudget * 0.05)));
    result = `${text.slice(0, charBudget).trimEnd()}${marker}`;
  }
  return result;
}

function truncateTextToTokenBudget(text: string, maxTokens: number): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokensDensityAware(text.slice(0, middle)) <= maxTokens) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return text.slice(0, low);
}

function assertMemoryKind(value: unknown): MemoryKind {
  if (typeof value !== 'string' || !MEMORY_KINDS.has(value as MemoryKind)) {
    throw new Error(`Unsupported memory kind: ${String(value)}`);
  }
  return value as MemoryKind;
}

function assertMemoryStatus(value: unknown): MemoryStatus {
  if (typeof value !== 'string' || !MEMORY_STATUSES.has(value as MemoryStatus)) {
    throw new Error(`Unsupported memory status: ${String(value)}`);
  }
  return value as MemoryStatus;
}

function assertMemorySourceType(value: unknown): MemorySourceType {
  if (typeof value !== 'string' || !MEMORY_SOURCE_TYPES.has(value as MemorySourceType)) {
    throw new Error(`Unsupported memory source type: ${String(value)}`);
  }
  return value as MemorySourceType;
}

function normalizeContent(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Memory content must be a non-empty string');
  }
  return value.trim();
}

function normalizeIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value.length > 512) throw new Error(`${field} exceeds 512 characters`);
  return value.trim();
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('confidence must be a finite number between 0 and 1');
  }
  return value;
}

function normalizeIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be a valid ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function normalizeStringList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return normalizeStringList(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
