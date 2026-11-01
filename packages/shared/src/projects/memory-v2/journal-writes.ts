import { randomUUID } from "crypto";
import { appendMemoryJournalSnapshot } from './journal-lock.ts';
import { loadProjectMemoryJournal } from './journal-read.ts';
import type { CreateProjectMemoryEntryInput, LoadMemoryJournalOptions, MemoryStatus, ProjectMemoryEntry } from './memory-schema.ts';
import { assertMemoryKind, assertMemorySourceType, assertMemoryStatus, normalizeConfidence, normalizeContent, normalizeIdentifier, normalizeIsoTimestamp, normalizeStringList } from './memory-schema.ts';
import { memoryWorkspaceIdentity, normalizeMemoryScope } from './retrieval-ranking.ts';

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
  if (input.scope && input.scope.projectSlug !== projectSlug) throw new Error('Memory scope must match the current project');
  const workspaceIdentity = memoryWorkspaceIdentity(workspaceRootPath);
  const workspaceKey = workspaceIdentity.canonicalKey;
  if (input.scope?.workspaceKey && !workspaceIdentity.acceptedKeys.has(input.scope.workspaceKey)) throw new Error('Memory scope must match the current workspace');
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
      ? new Date(Date.parse(createdAt) + input.ttlDays * 86_400_000).toISOString()
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
    scope: normalizeMemoryScope({ ...input.scope, projectSlug, workspaceKey }),
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
  options?: Pick<LoadMemoryJournalOptions, 'legacyWorkspaceRootPath'>,
): ProjectMemoryEntry {
  const loaded = loadProjectMemoryJournal(workspaceRootPath, projectSlug, {
    strict: true,
    ...(options?.legacyWorkspaceRootPath !== undefined ? { legacyWorkspaceRootPath: options?.legacyWorkspaceRootPath } : {}),
  });
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
  options?: Pick<LoadMemoryJournalOptions, 'legacyWorkspaceRootPath'>,
): ProjectMemoryEntry {
  return setProjectMemoryStatus(workspaceRootPath, projectSlug, entryId, 'forgotten', now, options);
}
