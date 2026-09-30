import { describe, expect, it } from 'bun:test';
import { getSessionToolProxyDefs } from './session-tool-defs.ts';

describe('Pi completion criteria tool schema', () => {
  it('passes concrete criterion fields to the Pi proxy instead of an opaque object', () => {
    const tool = getSessionToolProxyDefs().find(tool => tool.name === 'mcp__session__set_completion_criteria');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object', required: ['criteria'], properties: { criteria: {
        type: 'array', minItems: 1, maxItems: 16, items: {
          type: 'object', required: ['id', 'description', 'toolName', 'input', 'checks'],
          properties: { toolName: { type: 'string' }, input: { type: 'object' }, checks: { type: 'array' } },
        },
      } },
    });
    expect(tool?.description).toContain('checks:[{path,equals}]');
    expect(tool?.description).toContain('Exact argument shape:');
  });
});
