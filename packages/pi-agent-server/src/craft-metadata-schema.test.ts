import { describe, expect, it } from 'bun:test';
import { createEditToolDefinition } from '@earendil-works/pi-coding-agent';
import { allowCraftMetadataProperties, normalizeForPiTool, stripCraftMetadata } from './craft-metadata-schema.ts';

describe('Craft metadata schema compatibility for Pi tools', () => {
  it('widens a strict Edit-like schema with optional Craft metadata properties', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' },
            },
            required: ['oldText', 'newText'],
          },
        },
      },
      required: ['path', 'edits'],
    };

    const widened = allowCraftMetadataProperties(schema);

    expect(widened).not.toBe(schema);
    expect(widened.additionalProperties).toBe(false);
    expect(widened.required).toEqual(schema.required);
    expect(widened.required).not.toContain('_displayName');
    expect(widened.required).not.toContain('_intent');
    expect(widened.properties._displayName).toBeDefined();
    expect(widened.properties._intent).toBeDefined();
    expect(widened.properties.path).toBe(schema.properties.path);
    expect(widened.properties.edits).toBe(schema.properties.edits);
  });

  it('widens the actual Pi Edit tool schema without making metadata required', () => {
    const editTool = createEditToolDefinition('/tmp');
    const widened = allowCraftMetadataProperties(editTool.parameters, 'Edit');
    const widenedSchema = widened as {
      additionalProperties?: unknown;
      properties: Record<string, unknown>;
      required?: string[];
    };

    expect(widenedSchema.additionalProperties).toBe(false);
    expect(widenedSchema.properties._displayName).toBeDefined();
    expect(widenedSchema.properties._intent).toBeDefined();
    expect(widenedSchema.required ?? []).not.toContain('_displayName');
    expect(widenedSchema.required ?? []).not.toContain('_intent');
    expect(widenedSchema.properties.file_path).toBeDefined();
    expect(widenedSchema.properties.old_string).toBeDefined();
    expect(widenedSchema.properties.new_string).toBeDefined();
    expect((widened as { anyOf?: unknown[] }).anyOf).toEqual([
      { required: ['path', 'edits'] },
      { required: ['file_path', 'old_string', 'new_string'] },
    ]);
  });

  it('normalizes the legacy Craft Edit shape for the strict Pi implementation', () => {
    expect(normalizeForPiTool('Edit', {
      file_path: '/tmp/example.ts',
      old_string: 'before',
      new_string: 'after',
    })).toEqual({
      path: '/tmp/example.ts',
      edits: [{ oldText: 'before', newText: 'after' }],
    });
  });

  it('preserves native multi-edit arrays while removing permission aliases', () => {
    const edits = [
      { oldText: 'a', newText: 'b' },
      { oldText: 'c', newText: 'd' },
    ];
    expect(normalizeForPiTool('Edit', {
      path: '/tmp/example.ts',
      file_path: '/tmp/example.ts',
      old_string: 'a',
      new_string: 'b',
      edits,
    })).toEqual({ path: '/tmp/example.ts', edits });
  });

  it('preserves upstream metadata properties if Pi defines them later', () => {
    const upstreamDisplayName = { type: 'string', description: 'upstream display name' };
    const upstreamIntent = { type: 'string', description: 'upstream intent' };
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        _displayName: upstreamDisplayName,
        _intent: upstreamIntent,
        path: { type: 'string' },
      },
      required: ['path'],
    };

    const widened = allowCraftMetadataProperties(schema);

    expect(widened.properties._displayName).toBe(upstreamDisplayName);
    expect(widened.properties._intent).toBe(upstreamIntent);
  });

  it('returns unknown schema shapes unchanged', () => {
    expect(allowCraftMetadataProperties(undefined)).toBeUndefined();
    expect(allowCraftMetadataProperties('schema')).toBe('schema');

    const noProperties = { type: 'string' };
    expect(allowCraftMetadataProperties(noProperties)).toBe(noProperties);
  });

  it('strips Craft metadata before upstream Pi tool execution', () => {
    const input = {
      _displayName: 'Edit Lines',
      _intent: 'Add punctuation',
      path: 'random',
      edits: [{ oldText: 'a', newText: 'b' }],
    };

    const clean = stripCraftMetadata(input);

    expect(clean).toEqual({
      path: 'random',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
    expect(clean).not.toHaveProperty('_displayName');
    expect(clean).not.toHaveProperty('_intent');
    expect(input).toHaveProperty('_displayName', 'Edit Lines');
    expect(input).toHaveProperty('_intent', 'Add punctuation');
  });

  it('returns the same input object when no metadata is present', () => {
    const input = { path: 'random' };
    expect(stripCraftMetadata(input)).toBe(input);
  });
});
