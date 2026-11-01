/**
 * Project Memory v2
 *
 * Local-first, append-only structured memory for a project. MEMORY.md remains
 * supported as a human-editable legacy source; this journal adds machine
 * readable provenance, temporal validity, confidence, lifecycle, and retrieval.
 */
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readSync, writeSync } from "fs";
import type { MemoryJournalEvent, MemoryProvenance, ProjectMemoryEntry, StoredMemoryJournalRecord } from './memory-schema.ts';
import { MEMORY_V2_SCHEMA_VERSION, assertMemoryKind, assertMemorySourceType, assertMemoryStatus, isRecord, normalizeConfidence, normalizeContent, normalizeIdentifier, normalizeIsoTimestamp, parseStringList } from './memory-schema.ts';
import { checksumPayload, normalizeMemoryScope } from './retrieval-ranking.ts';

/**
 * Recover a torn final append before accepting a new event.
 *
 * The journal is append-only for committed records. A non-newline-terminated
 * tail is not a committed record, so startup-style WAL recovery truncates only
 * that fragment and fsyncs the repair before the next O_APPEND write.
 */
export function repairIncompleteJournalTail(path: string): void {
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

export function parseStoredRecord(
  value: unknown,
):
  | { ok: true; record: StoredMemoryJournalRecord }
  | { ok: false; code: 'invalid_record' | 'checksum_mismatch'; message: string } {
  if (!isRecord(value) || !isRecord(value["payload"]) || typeof value["checksum"] !== 'string') {
    return { ok: false, code: 'invalid_record', message: 'Missing payload or checksum' };
  }

  const payload = value["payload"];
  if (
    payload["schemaVersion"] !== MEMORY_V2_SCHEMA_VERSION ||
    typeof payload["eventId"] !== 'string' ||
    payload["eventType"] !== 'put' ||
    typeof payload["recordedAt"] !== 'string'
  ) {
    return { ok: false, code: 'invalid_record', message: 'Unsupported journal event shape' };
  }

  let entry: ProjectMemoryEntry;
  try {
    normalizeIsoTimestamp(payload["recordedAt"], 'recordedAt');
    entry = parseProjectMemoryEntry(payload["entry"]);
  } catch (error) {
    return {
      ok: false,
      code: 'invalid_record',
      message: error instanceof Error ? error.message : 'Invalid memory entry',
    };
  }

  const event: MemoryJournalEvent = {
    schemaVersion: MEMORY_V2_SCHEMA_VERSION,
    eventId: payload["eventId"],
    eventType: 'put',
    recordedAt: payload["recordedAt"],
    entry,
  };
  if (checksumPayload(event) !== value["checksum"]) {
    return { ok: false, code: 'checksum_mismatch', message: 'Journal checksum mismatch' };
  }

  return {
    ok: true,
    record: { payload: event, checksum: value["checksum"] },
  };
}

function parseProjectMemoryEntry(value: unknown): ProjectMemoryEntry {
  if (!isRecord(value)) throw new Error('Memory entry must be an object');
  if (!isRecord(value["provenance"])) throw new Error('Memory provenance must be an object');

  const provenance: MemoryProvenance = {
    sourceType: assertMemorySourceType(value["provenance"]["sourceType"]),
    ...(typeof value["provenance"]["sourceId"] === 'string'
      ? { sourceId: normalizeIdentifier(value["provenance"]["sourceId"], 'provenance.sourceId') }
      : {}),
    ...(typeof value["provenance"]["uri"] === 'string' ? { uri: value["provenance"]["uri"] } : {}),
    ...(typeof value["provenance"]["actorId"] === 'string'
      ? { actorId: normalizeIdentifier(value["provenance"]["actorId"], 'provenance.actorId') }
      : {}),
    capturedAt: normalizeIsoTimestamp(value["provenance"]["capturedAt"], 'provenance.capturedAt'),
  };
  const validFrom = normalizeIsoTimestamp(value["validFrom"], 'validFrom');
  const validUntil = typeof value["validUntil"] === 'string'
    ? normalizeIsoTimestamp(value["validUntil"], 'validUntil')
    : undefined;
  if (validUntil && Date.parse(validUntil) <= Date.parse(validFrom)) {
    throw new Error('validUntil must be after validFrom');
  }

  return {
    id: normalizeIdentifier(value["id"], 'id'),
    kind: assertMemoryKind(value["kind"]),
    content: normalizeContent(value["content"]),
    tags: parseStringList(value["tags"], 'tags'),
    provenance,
    confidence: normalizeConfidence(value["confidence"]),
    createdAt: normalizeIsoTimestamp(value["createdAt"], 'createdAt'),
    updatedAt: normalizeIsoTimestamp(value["updatedAt"], 'updatedAt'),
    validFrom,
    ...(validUntil ? { validUntil } : {}),
    ...(typeof value["expiresAt"] === 'string'
      ? { expiresAt: normalizeIsoTimestamp(value["expiresAt"], 'expiresAt') }
      : {}),
    status: assertMemoryStatus(value["status"]),
    supersedesIds: parseStringList(value["supersedesIds"], 'supersedesIds'),
    contradictsIds: parseStringList(value["contradictsIds"], 'contradictsIds'),
    ...(value["scope"] !== undefined ? { scope: normalizeMemoryScope(value["scope"]) } : {}),
  };
}
