import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { estimateTokensDensityAware } from '../../utils/large-response.ts';
import {
  appendProjectMemoryEntry,
  forgetProjectMemoryEntry,
  getProjectMemoryJournalPath,
  loadProjectMemoryJournal,
  loadProjectMemoryV2Context,
  retrieveProjectMemories,
} from '../memory-v2.ts';
import {
  createProject,
  getProjectMemoryPath,
  loadProjectMemory,
} from '../storage.ts';

let tempDir: string;
let workspaceRoot: string;
let projectSlug: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'memory-v2-test-'));
  workspaceRoot = join(tempDir, 'workspace');
  projectSlug = createProject(workspaceRoot, { name: 'Memory v2 Test' }).slug;
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('Memory v2 journal', () => {
  it('persists structured provenance, confidence, temporal validity, and fsynced events', () => {
    const now = new Date('2026-07-24T10:00:00.000Z');
    const entry = appendProjectMemoryEntry(
      workspaceRoot,
      projectSlug,
      {
        id: 'mem_runtime',
        kind: 'decision',
        content: 'Use Bun for shared package tests.',
        tags: ['runtime', 'tests', 'runtime'],
        provenance: {
          sourceType: 'user',
          sourceId: 'session_42',
          actorId: 'thibault',
        },
        confidence: 0.95,
        validUntil: '2027-01-01T00:00:00.000Z',
      },
      now,
    );

    expect(entry.tags).toEqual(['runtime', 'tests']);
    expect(entry.provenance).toEqual({
      sourceType: 'user',
      sourceId: 'session_42',
      actorId: 'thibault',
      capturedAt: now.toISOString(),
    });
    expect(entry.confidence).toBe(0.95);
    expect(entry.validFrom).toBe(now.toISOString());

    const loaded = loadProjectMemoryJournal(workspaceRoot, projectSlug);
    expect(loaded.validEventCount).toBe(1);
    expect(loaded.issues).toEqual([]);
    expect(loaded.entries).toEqual([entry]);
    expect(readFileSync(getProjectMemoryJournalPath(workspaceRoot, projectSlug), 'utf8'))
      .toEndWith('\n');
  });

  it('reports checksum corruption and tolerates only an incomplete trailing append', () => {
    appendProjectMemoryEntry(
      workspaceRoot,
      projectSlug,
      {
        id: 'mem_verified',
        kind: 'fact',
        content: 'The verified runtime is Bun.',
        provenance: { sourceType: 'tool', sourceId: 'test-command' },
      },
      new Date('2026-07-24T10:00:00.000Z'),
    );
    const journalPath = getProjectMemoryJournalPath(workspaceRoot, projectSlug);
    const validLine = readFileSync(journalPath, 'utf8');
    writeFileSync(journalPath, validLine.replace('verified runtime', 'modified runtime'));
    appendFileSync(journalPath, '{"payload":');

    const loaded = loadProjectMemoryJournal(workspaceRoot, projectSlug);
    expect(loaded.entries).toEqual([]);
    expect(loaded.validEventCount).toBe(0);
    expect(loaded.issues.map((issue) => issue.code)).toEqual([
      'checksum_mismatch',
      'trailing_partial_record',
    ]);
    expect(() => loadProjectMemoryJournal(
      workspaceRoot,
      projectSlug,
      { strict: true },
    )).toThrow('Memory journal validation failed at line 1');
  });

  it('repairs a torn tail before the next append without corrupting the new record', () => {
    appendProjectMemoryEntry(workspaceRoot, projectSlug, {
      id: 'mem_before_torn_tail',
      kind: 'fact',
      content: 'First committed record.',
      provenance: { sourceType: 'tool', sourceId: 'recovery-test' },
    });
    const journalPath = getProjectMemoryJournalPath(workspaceRoot, projectSlug);
    appendFileSync(journalPath, '{"payload":');

    appendProjectMemoryEntry(workspaceRoot, projectSlug, {
      id: 'mem_after_torn_tail',
      kind: 'fact',
      content: 'Second committed record.',
      provenance: { sourceType: 'tool', sourceId: 'recovery-test' },
    });

    const loaded = loadProjectMemoryJournal(workspaceRoot, projectSlug, { strict: true });
    expect(loaded.issues).toEqual([]);
    expect(loaded.entries.map((entry) => entry.id)).toEqual([
      'mem_before_torn_tail',
      'mem_after_torn_tail',
    ]);
    expect(loaded.validEventCount).toBe(2);
  });

  it('preserves a complete checksummed tail that only lacks its newline', () => {
    appendProjectMemoryEntry(workspaceRoot, projectSlug, {
      id: 'mem_missing_delimiter',
      kind: 'fact',
      content: 'Complete record without its final delimiter.',
      provenance: { sourceType: 'tool', sourceId: 'delimiter-test' },
    });
    const journalPath = getProjectMemoryJournalPath(workspaceRoot, projectSlug);
    const completeLine = readFileSync(journalPath, 'utf8').trimEnd();
    writeFileSync(journalPath, completeLine);

    appendProjectMemoryEntry(workspaceRoot, projectSlug, {
      id: 'mem_after_delimiter_repair',
      kind: 'fact',
      content: 'Record appended after delimiter recovery.',
      provenance: { sourceType: 'tool', sourceId: 'delimiter-test' },
    });

    const loaded = loadProjectMemoryJournal(workspaceRoot, projectSlug, { strict: true });
    expect(loaded.issues).toEqual([]);
    expect(loaded.entries.map((entry) => entry.id)).toEqual([
      'mem_missing_delimiter',
      'mem_after_delimiter_repair',
    ]);
    expect(readFileSync(journalPath, 'utf8')).toEndWith('\n');
  });

  it('recovers a stale writer lock before appending', () => {
    const journalPath = getProjectMemoryJournalPath(workspaceRoot, projectSlug);
    writeFileSync(`${journalPath}.lock`, JSON.stringify({
      pid: -1,
      createdAt: '2026-07-24T00:00:00.000Z',
    }));

    appendProjectMemoryEntry(workspaceRoot, projectSlug, {
      id: 'mem_after_stale_lock',
      kind: 'fact',
      content: 'Append succeeded after stale lock recovery.',
      provenance: { sourceType: 'tool', sourceId: 'lock-test' },
    });

    expect(existsSync(`${journalPath}.lock`)).toBe(false);
    expect(loadProjectMemoryJournal(workspaceRoot, projectSlug, { strict: true })
      .entries.map((entry) => entry.id)).toEqual(['mem_after_stale_lock']);
  });

  it('derives superseded and contradicted lifecycle without rewriting prior records', () => {
    const base = {
      provenance: { sourceType: 'session' as const, sourceId: 'session_1' },
      confidence: 0.9,
    };
    appendProjectMemoryEntry(workspaceRoot, projectSlug, {
      ...base,
      id: 'mem_old',
      kind: 'fact',
      content: 'The API uses port 3000.',
    });
    appendProjectMemoryEntry(workspaceRoot, projectSlug, {
      ...base,
      id: 'mem_new',
      kind: 'fact',
      content: 'The API uses port 4000.',
      supersedesIds: ['mem_old'],
    });
    appendProjectMemoryEntry(workspaceRoot, projectSlug, {
      ...base,
      id: 'mem_conflict',
      kind: 'observation',
      content: 'A legacy deployment still exposes port 3000.',
      contradictsIds: ['mem_old'],
    });

    const loaded = loadProjectMemoryJournal(workspaceRoot, projectSlug);
    const status = Object.fromEntries(
      loaded.entries.map((entry) => [entry.id, entry.status]),
    );
    expect(status).toEqual({
      mem_old: 'contradicted',
      mem_new: 'active',
      mem_conflict: 'active',
    });
    expect(loaded.validEventCount).toBe(3);
  });

  it('does not apply a future supersession before its validFrom date', () => {
    appendProjectMemoryEntry(
      workspaceRoot,
      projectSlug,
      {
        id: 'mem_current_policy',
        kind: 'constraint',
        content: 'Current retention is 90 days.',
        provenance: { sourceType: 'user' },
      },
      new Date('2026-07-01T00:00:00.000Z'),
    );
    appendProjectMemoryEntry(
      workspaceRoot,
      projectSlug,
      {
        id: 'mem_future_policy',
        kind: 'constraint',
        content: 'Retention changes to 30 days in August.',
        provenance: { sourceType: 'user' },
        validFrom: '2026-08-01T00:00:00.000Z',
        supersedesIds: ['mem_current_policy'],
      },
      new Date('2026-07-01T00:00:00.000Z'),
    );

    const july = loadProjectMemoryJournal(workspaceRoot, projectSlug, {
      now: new Date('2026-07-24T00:00:00.000Z'),
    });
    expect(july.entries.find((entry) => entry.id === 'mem_current_policy')?.status)
      .toBe('active');

    const august = loadProjectMemoryJournal(workspaceRoot, projectSlug, {
      now: new Date('2026-08-02T00:00:00.000Z'),
    });
    expect(august.entries.find((entry) => entry.id === 'mem_current_policy')?.status)
      .toBe('superseded');
  });

  it('honors temporal validity, TTL expiry, and explicit append-only forgetting', () => {
    const capturedAt = new Date('2026-07-01T00:00:00.000Z');
    appendProjectMemoryEntry(
      workspaceRoot,
      projectSlug,
      {
        id: 'mem_ttl',
        kind: 'observation',
        content: 'Temporary incident workaround.',
        provenance: { sourceType: 'session' },
        ttlDays: 2,
      },
      capturedAt,
    );
    appendProjectMemoryEntry(
      workspaceRoot,
      projectSlug,
      {
        id: 'mem_future',
        kind: 'goal',
        content: 'Start the migration in August.',
        provenance: { sourceType: 'user' },
        validFrom: '2026-08-01T00:00:00.000Z',
      },
      capturedAt,
    );
    appendProjectMemoryEntry(
      workspaceRoot,
      projectSlug,
      {
        id: 'mem_forget',
        kind: 'preference',
        content: 'Prefer the legacy dashboard.',
        provenance: { sourceType: 'user' },
      },
      capturedAt,
    );
    forgetProjectMemoryEntry(
      workspaceRoot,
      projectSlug,
      'mem_forget',
      new Date('2026-07-02T00:00:00.000Z'),
    );

    const loaded = loadProjectMemoryJournal(workspaceRoot, projectSlug);
    const results = retrieveProjectMemories(loaded.entries, {
      now: new Date('2026-07-24T00:00:00.000Z'),
    });
    expect(results).toEqual([]);
    expect(loaded.entries.find((entry) => entry.id === 'mem_forget')?.status)
      .toBe('forgotten');
    expect(loaded.validEventCount).toBe(4);
  });
});

describe('Memory v2 retrieval and legacy compatibility', () => {
  it('ranks lexical relevance plus recency and accepts optional vector scores', () => {
    const oldRelevant = appendProjectMemoryEntry(
      workspaceRoot,
      projectSlug,
      {
        id: 'mem_auth',
        kind: 'procedure',
        content: 'Rotate OAuth refresh tokens after every authentication.',
        tags: ['oauth', 'security'],
        provenance: { sourceType: 'session' },
        confidence: 0.9,
      },
      new Date('2026-06-01T00:00:00.000Z'),
    );
    const recentUnrelated = appendProjectMemoryEntry(
      workspaceRoot,
      projectSlug,
      {
        id: 'mem_ui',
        kind: 'decision',
        content: 'Use the indigo color theme.',
        tags: ['ui'],
        provenance: { sourceType: 'user' },
        confidence: 0.9,
      },
      new Date('2026-07-23T00:00:00.000Z'),
    );
    const entries = [oldRelevant, recentUnrelated];

    const lexical = retrieveProjectMemories(entries, {
      query: 'OAuth authentication security',
      now: new Date('2026-07-24T00:00:00.000Z'),
    });
    expect(lexical[0]?.entry.id).toBe('mem_auth');
    expect(lexical[0]?.scoreBreakdown.lexical).toBeGreaterThan(
      lexical[1]?.scoreBreakdown.lexical ?? 0,
    );

    const semantic = retrieveProjectMemories(entries, {
      query: 'OAuth authentication security',
      now: new Date('2026-07-24T00:00:00.000Z'),
      vectorScores: { mem_auth: 0, mem_ui: 1 },
      weights: { lexical: 0.1, recency: 0.05, confidence: 0.05, vector: 0.8 },
    });
    expect(semantic[0]?.entry.id).toBe('mem_ui');
    expect(semantic[0]?.scoreBreakdown.vector).toBe(1);
  });

  it('combines structured memory with MEMORY.md and respects the total prompt budget', () => {
    writeFileSync(
      getProjectMemoryPath(workspaceRoot, projectSlug),
      '# Human notes\n\nKeep this hand-authored compatibility note.',
    );
    appendProjectMemoryEntry(
      workspaceRoot,
      projectSlug,
      {
        id: 'mem_decision',
        kind: 'decision',
        content: 'Use a local-first append-only memory journal.',
        provenance: { sourceType: 'user', sourceId: 'session_memory' },
        confidence: 1,
      },
      new Date('2026-07-24T10:00:00.000Z'),
    );

    const combined = loadProjectMemory(workspaceRoot, projectSlug, 250);
    expect(combined).toContain('# Structured project memory');
    expect(combined).toContain('local-first append-only memory journal');
    expect(combined).toContain('# Legacy MEMORY.md');
    expect(combined).toContain('hand-authored compatibility note');
    expect(estimateTokensDensityAware(combined ?? '')).toBeLessThanOrEqual(250);

    const structuredOnly = loadProjectMemoryV2Context(
      workspaceRoot,
      projectSlug,
      { query: 'append-only journal', maxTokens: 100 },
    );
    expect(structuredOnly).toContain('mem_decision');
    expect(estimateTokensDensityAware(structuredOnly ?? '')).toBeLessThanOrEqual(100);
  });

  it('keeps truncation markers inside very small context budgets', () => {
    writeFileSync(
      getProjectMemoryPath(workspaceRoot, projectSlug),
      'Legacy memory '.repeat(100),
    );
    appendProjectMemoryEntry(workspaceRoot, projectSlug, {
      id: 'mem_small_budget',
      kind: 'decision',
      content: 'Structured memory '.repeat(100),
      provenance: { sourceType: 'user' },
    });

    const combined = loadProjectMemory(workspaceRoot, projectSlug, 1);
    const structured = loadProjectMemoryV2Context(
      workspaceRoot,
      projectSlug,
      { maxTokens: 1 },
    );
    expect(estimateTokensDensityAware(combined ?? '')).toBeLessThanOrEqual(1);
    expect(estimateTokensDensityAware(structured ?? '')).toBeLessThanOrEqual(1);
  });
});
