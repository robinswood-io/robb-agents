import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { getSessionToolDefs, getToolDefsAsJsonSchema } from './tool-defs.ts';

describe('canonical session tool JSON Schema export', () => {
  const canonical = getSessionToolDefs({ includeDeveloperFeedback: true });
  const exported = new Map(getToolDefsAsJsonSchema({ includeDeveloperFeedback: true }).map(tool => [tool.name, tool]));

  it.each(canonical.map(tool => [tool.name, tool] as const))('%s advertises all fields and required inputs', (name, definition) => {
    const schema = exported.get(name)!.inputSchema;
    const fields = definition.inputSchema.shape;
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties as object).sort()).toEqual(Object.keys(fields).sort());
    const required = Object.entries(fields).filter(([, field]) => !z.safeParse(field, undefined).success).map(([key]) => key).sort();
    expect(((schema.required as string[] | undefined) ?? []).slice().sort()).toEqual(required);
    expect(schema.$schema).toBeUndefined();
  });

  it('exposes spawn roles and exact permission enums without display aliases', () => {
    expect(exported.get('spawn_session')!.inputSchema).toMatchObject({ properties: {
      role: { type: 'string', enum: ['worker', 'reviewer'] },
      permissionMode: { type: 'string', enum: ['safe', 'ask', 'allow-all'] },
      attachments: { type: 'array', items: { type: 'object', required: ['path'] } },
    } });
    const description = exported.get('spawn_session')!.description;
    expect(description).toContain('role');
    expect(description).toContain("The provider always remains the parent's provider");
    expect(description).toContain('host selects the child model and reasoning from the assignment difficulty');
    expect(description).not.toContain('Omitted fields inherit from the spawning session');
  });
});
