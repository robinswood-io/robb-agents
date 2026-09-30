import { describe, expect, it } from 'bun:test';
import { handleUpdatePlan } from './update-plan';
import { getToolDefsAsJsonSchema, SESSION_TOOL_DEFS } from '../tool-defs';
import type { SessionToolContext } from '../context';

const ctx = { sessionId: 'progress-test' } as SessionToolContext;
describe('live plan tool', () => {
  it('is available through the shared registry and Pi MCP schema without approval', () => {
    const def = SESSION_TOOL_DEFS.find(tool => tool.name === 'update_plan')!;
    expect(def.safeMode).toBe('allow');
    expect(def.executionMode).toBe('registry');
    expect(def.handler).toBe(handleUpdatePlan);
    expect(def.description).toContain('when it materially helps');
    expect(def.description).toContain('not after every tool call');
    expect(def.description).toContain('Skip it for simple tasks, direct answers, and bounded reviews');
    expect(def.description).not.toContain('Use before multi-step work');
    const schema = getToolDefsAsJsonSchema({ prefix: 'mcp__session__' }).find(tool => tool.name === 'mcp__session__update_plan')!;
    expect(JSON.stringify(schema)).toContain('in_progress');
    expect(JSON.stringify(schema)).toContain('explanation');
  });
  it('confirms the full state in a nonempty transcript result without external callbacks', async () => {
    const input = { explanation: 'Le rapport est créé.', plan: [
      { step: 'Créer le rapport', status: 'completed' },
      { step: 'Vérifier le rendu', status: 'in_progress' },
      { step: 'Livrer le rapport', status: 'pending' },
    ] };
    const result = await handleUpdatePlan(ctx, input);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual(input);
    expect(await handleUpdatePlan(ctx, input)).toEqual(result);
  });
  it('rejects malformed steps and multiple active steps instead of confirming them', async () => {
    for (const plan of [[{ step: '', status: 'pending' }], [{ step: 'Test', status: 'done' }],
      [{ step: 'One', status: 'in_progress' }, { step: 'Two', status: 'in_progress' }]]) {
      expect((await handleUpdatePlan(ctx, { plan })).isError).toBe(true);
    }
  });
});
