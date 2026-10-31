/**
 * Project Memory v2
 *
 * Local-first, append-only structured memory for a project. MEMORY.md remains
 * supported as a human-editable legacy source; this journal adds machine
 * readable provenance, temporal validity, confidence, lifecycle, and retrieval.
 */
import { existsSync, readFileSync } from "fs";
import { getProjectMemoryJournalPath } from './journal-lock.ts';
import { parseStoredRecord } from './journal-parse.ts';
import type { LoadMemoryJournalOptions, LoadedProjectMemoryJournal, MemoryJournalIssue, ProjectMemoryEntry } from './memory-schema.ts';
import { deriveRelationshipStatuses, memoryWorkspaceIdentity } from './retrieval-ranking.ts';

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
  const workspaceIdentity = memoryWorkspaceIdentity(
    workspaceRootPath,
    options?.legacyWorkspaceRootPath,
  );
  const workspaceKey = workspaceIdentity.canonicalKey;
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
    const storedEntry = parsed.record.payload.entry;
    const scope = storedEntry.scope;
    // Reject a foreign entry before latest-by-id or relationship resolution;
    // otherwise it could shadow/revoke a local entry with the same identifier.
    if (scope && (scope.projectSlug !== projectSlug
      || (scope.workspaceKey && !workspaceIdentity.acceptedKeys.has(scope.workspaceKey)))) continue;
    // Journals written before physical-root identity used the exact lexical
    // workspace path as their scope key. Accept that one legacy key only when
    // the caller supplied that same path, and normalize the in-memory view so
    // current retrieval filters and the next lifecycle append use the physical
    // identity. A copied journal from another path remains foreign.
    const entry = scope?.workspaceKey && scope.workspaceKey !== workspaceKey
      ? { ...storedEntry, scope: { ...scope, workspaceKey } }
      : storedEntry;
    latestById.set(entry.id, entry);
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
