import { describe, it, expect } from "bun:test";
import { validateTaskSpec, validateTaskInput, TASK_CAPS } from "./validate.ts";
import { parsed } from "./testing/schema-fixture.ts";

describe('validate', () => {
  it('accepts a valid chain with no errors or warnings', () => {
    const res = validateTaskSpec(parsed());
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.warnings).toHaveLength(0);
  });

  it('flags dangling depends_on', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', depends_on: ['ghost'] }],
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.message.includes('unknown node "ghost"'))).toBe(true);
  });

  it('flags an unresolved node reference', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'see ${nodes.ghost.output}' }],
    });
    expect(res.errors.some((e) => e.message.includes('unknown node "ghost"'))).toBe(true);
  });

  it('warns when a referenced node is not listed in depends_on', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'a', prompt: 'p' },
        { id: 'b', prompt: 'uses ${nodes.a.output}' }, // no depends_on
      ],
    });
    expect(res.valid).toBe(true);
    expect(res.warnings.some((w) => w.message.includes('does not list it in depends_on'))).toBe(true);
  });

  it('errors on an undeclared param reference but accepts a declared one', () => {
    const bad = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'env is ${params.env}' }],
    });
    expect(bad.errors.some((e) => e.message.includes('undeclared task param "env"'))).toBe(true);

    const ok = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      params: [{ name: 'env' }],
      nodes: [{ id: 'a', prompt: 'env is ${params.env}' }],
    });
    expect(ok.errors).toHaveLength(0);
  });

  it('warns when a reference reads a structured output field (not populated in v1)', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'a', prompt: 'p' },
        { id: 'b', depends_on: ['a'], prompt: 'uses ${nodes.a.output.score}' },
      ],
    });
    expect(res.valid).toBe(true);
    expect(res.warnings.some((w) => w.message.includes('structured output field'))).toBe(true);
  });

  it('detects a dependency cycle', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'a', prompt: 'p', depends_on: ['b'] },
        { id: 'b', prompt: 'q', depends_on: ['a'] },
      ],
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.message.includes('cycle'))).toBe(true);
  });

  it('rejects a self-dependency', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', depends_on: ['a'] }],
    });
    expect(res.errors.some((e) => e.message.includes('depends on itself'))).toBe(true);
  });

  it('errors when loop.max exceeds the cap', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', loop: { until: 'DONE', max: TASK_CAPS.maxLoopIterations + 1 } }],
    });
    expect(res.errors.some((e) => e.message.includes('exceeds the cap'))).toBe(true);
  });

  it('warns on an unknown model', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', model: 'gpt-imaginary-9' }],
    });
    expect(res.warnings.some((w) => w.message.includes('not a known built-in model'))).toBe(true);
  });

  it('errors when the node count exceeds the cap', () => {
    const nodes = Array.from({ length: TASK_CAPS.maxNodes + 1 }, (_, i) => ({ id: `n${i}`, prompt: 'p' }));
    const res = validateTaskInput({ id: 'x', title: 'X', goal: 'g', nodes });
    expect(res.errors.some((e) => e.message.includes('exceeding the cap'))).toBe(true);
  });
});
