import { describe, it, expect } from "bun:test";
import { parseTaskSpec, nodeDeps, nodeTitle } from "./schema.ts";
import { CHAIN } from "./testing/schema-fixture.ts";

describe('schema', () => {
  it('parses a valid chain and applies defaults', () => {
    const r = parseTaskSpec(CHAIN);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.runner).toBe('conduct');
    expect(r.data.nodes[0]!.kind).toBe('session');
    expect(nodeDeps(r.data.nodes[1]!)).toEqual(['audit']);
    expect(nodeTitle(r.data.nodes[0]!)).toBe('audit'); // title falls back to id
  });

  it('normalizes the legacy `type` alias onto `kind`', () => {
    const r = parseTaskSpec({
      id: 'x',
      title: 'X',
      goal: 'g',
      nodes: [{ id: 'dyn', type: 'orchestrator', prompt: 'expand' }],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.nodes[0]!.kind).toBe('orchestrator');
    expect((r.data.nodes[0] as Record<string, unknown>)["type"]).toBeUndefined();
  });

  it('requires a prompt on session nodes', () => {
    const r = parseTaskSpec({ id: 'x', title: 'X', goal: 'g', nodes: [{ id: 'a' }] });
    expect(r.success).toBe(false);
  });

  it.each(['judge', 'verify'] as const)('requires a prompt on executable %s nodes', (kind) => {
    expect(parseTaskSpec({
      id: `missing-${kind}`, title: kind, goal: 'g', nodes: [{ id: kind, kind }],
    }).success).toBe(false);
    expect(parseTaskSpec({
      id: `valid-${kind}`, title: kind, goal: 'g', nodes: [{ id: kind, kind, prompt: 'Review the evidence.' }],
    }).success).toBe(true);
  });

  it('accepts an optional acceptance_criteria rubric', () => {
    const r = parseTaskSpec({ ...CHAIN, acceptance_criteria: 'The implementation must pass all tests.' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.acceptance_criteria).toBe('The implementation must pass all tests.');
  });

  it('accepts max_iterations at the cap and at zero, rejects above the cap', () => {
    expect(parseTaskSpec({ ...CHAIN, max_iterations: 10 }).success).toBe(true);
    expect(parseTaskSpec({ ...CHAIN, max_iterations: 0 }).success).toBe(true);
    expect(parseTaskSpec({ ...CHAIN, max_iterations: 11 }).success).toBe(false);
  });

  it('applies bounded reflective-memory and stagnation defaults', () => {
    const result = parseTaskSpec({ ...CHAIN, autonomy: {} });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.autonomy).toEqual({
      reflection_memory_entries: 3,
      reflection_output_chars: 1_500,
      stagnation_limit: 2,
    });
    expect(parseTaskSpec({ ...CHAIN, autonomy: { reflection_memory_entries: 9 } }).success).toBe(false);
    expect(parseTaskSpec({ ...CHAIN, autonomy: { reflection_output_chars: 4_001 } }).success).toBe(false);
    expect(parseTaskSpec({ ...CHAIN, autonomy: { stagnation_limit: 6 } }).success).toBe(false);
  });

  it('accepts optional task-level sources and skills, rejecting empty slugs', () => {
    const r = parseTaskSpec({ ...CHAIN, sources: ['github', 'linear'], skills: ['commit'] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.sources).toEqual(['github', 'linear']);
    expect(r.data.skills).toEqual(['commit']);
    expect(parseTaskSpec({ ...CHAIN, sources: [''] }).success).toBe(false);
  });

  it('accepts shared and per-node retry policies with multiple failure classes', () => {
    const result = parseTaskSpec({
      ...CHAIN,
      defaults: { retry: { limit: 2, when: ['error', 'empty'] } },
      nodes: [
        { id: 'audit', prompt: 'Audit', retry: { limit: 1, when: 'invalid' } },
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.defaults?.retry?.when).toEqual(['error', 'empty']);
    expect(result.data.nodes[0]?.retry?.when).toBe('invalid');
  });

  it('models mission deliverables, budget, deadline, and high-impact approval policy', () => {
    const mission = {
      inputs: [{ name: 'brief', sensitivity: 'confidential' }],
      deliverables: [{ name: 'report', format: 'markdown', path: 'reports/final.md' }],
      budget: { max_tokens: 20_000, max_cost: 12, currency: 'EUR' },
      deadline: '2026-08-01T12:00:00+02:00',
      policy: {
        impact_level: 'high',
        require_high_impact_approval: true,
        replay_external_mutations: false,
        owner: 'operator@example.test',
      },
    } as const;
    const accepted = parseTaskSpec({
      ...CHAIN,
      mission,
      nodes: [{ id: 'publish', prompt: 'Publish', effect: 'external-mutation', approval: true }],
    });
    expect(accepted.success).toBe(true);
    if (!accepted.success) return;
    expect(accepted.data.mission?.budget?.currency).toBe('EUR');
    expect(accepted.data.nodes[0]?.effect).toBe('external-mutation');

    const rejected = parseTaskSpec({
      ...CHAIN,
      mission,
      nodes: [{ id: 'publish', prompt: 'Publish', effect: 'external-mutation' }],
    });
    expect(rejected.success).toBe(false);
  });

  it('rejects duplicate node ids', () => {
    const r = parseTaskSpec({
      id: 'x',
      title: 'X',
      goal: 'g',
      nodes: [
        { id: 'a', prompt: 'p' },
        { id: 'a', prompt: 'q' },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an invalid slug id', () => {
    const r = parseTaskSpec({ id: 'Bad Id', title: 'X', goal: 'g', nodes: [{ id: 'a', prompt: 'p' }] });
    expect(r.success).toBe(false);
  });
});
