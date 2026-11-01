import { describe, it, expect } from "bun:test";
import { extractRefs, interpolateRefs } from "./refs.ts";

describe('refs', () => {
  it('extracts node, field, and param references', () => {
    const refs = extractRefs('use ${nodes.audit.output} and ${nodes.design.output.score} with ${params.env}');
    expect(refs).toHaveLength(3);
    expect(refs[0]).toMatchObject({ kind: 'node', nodeId: 'audit' });
    expect(refs[1]).toMatchObject({ kind: 'node', nodeId: 'design', field: 'score' });
    expect(refs[2]).toMatchObject({ kind: 'param', name: 'env' });
  });

  it('interpolates text, fields, and params; leaves unknown refs raw', () => {
    const out = interpolateRefs(
      'A=${nodes.a.output} B=${nodes.a.output.score} P=${params.env} M=${nodes.missing.output}',
      { nodeOutputs: { a: { text: 'hello', params: { score: 7 } } }, params: { env: 'prod' } },
    );
    expect(out).toBe('A=hello B=7 P=prod M=${nodes.missing.output}');
  });

  it('supports an onMissing fallback', () => {
    const out = interpolateRefs('X=${nodes.ghost.output}', { nodeOutputs: {} }, { onMissing: () => '<none>' });
    expect(out).toBe('X=<none>');
  });
});
