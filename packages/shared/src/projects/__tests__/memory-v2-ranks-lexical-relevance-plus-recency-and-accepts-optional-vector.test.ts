import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { estimateTokensDensityAware } from "../../utils/large-response.ts";
import { appendProjectMemoryEntry, loadProjectMemoryV2Context, retrieveProjectMemories } from "../memory-v2.ts";
import { createProject, getProjectMemoryPath, loadProjectMemory } from "../storage.ts";

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
