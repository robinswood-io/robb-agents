import { describe, expect, test } from 'bun:test';
import { inspectFormat, inspectJson } from '../format-quality';

describe('format quality', () => {
  test('rejects malformed JSON, comments and duplicate nested keys', () => {
    expect(inspectJson('x.json', '{"a": 1,}').length).toBeGreaterThan(0);
    expect(inspectJson('x.json', '{/*comment*/"a": 1}').length).toBeGreaterThan(0);
    expect(inspectJson('x.json', '{"a": {"b": 1, "b": 2}}').map(issue => issue.rule))
      .toContain('json/duplicate-key');
    expect(inspectJson('x.json', '{"a": {"b": 1}, "c": {"b": 2}}')).toEqual([]);
  });
  test('allows JSONC only for TypeScript configurations', () => {
    expect(inspectJson('packages/core/tsconfig.json', '{/*comment*/"strict": true,}')).toEqual([]);
    expect(inspectJson('tsconfig.build.json', '{/*comment*/"strict": true,}')).toEqual([]);
    expect(inspectJson('settings.json', '{/*comment*/"strict": true,}').length).toBeGreaterThan(0);
  });
  test('rejects duplicate YAML keys and unknown tags', async () => {
    expect((await inspectFormat('x.yml', 'a: 1\na: 2')).length).toBeGreaterThan(0);
    expect((await inspectFormat('x.yml', 'a: !unknown value')).length).toBeGreaterThan(0);
  });
  test('checks CSS semantics and accepts actual Tailwind directives', async () => {
    expect((await inspectFormat('x.css', 'a { colro: red; }')).length).toBeGreaterThan(0);
    expect((await inspectFormat('x.css', '@mistyped { a { color: red; } }')).length).toBeGreaterThan(0);
    expect(await inspectFormat('x.css', '@theme { --color-primary: red; }')).toEqual([]);
  });
  test('checks HTML accessibility and element validity', async () => {
    const document = '<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body><img src="x.png"></body></html>';
    expect((await inspectFormat('x.html', document)).some(issue => issue.rule === 'html/wcag/h37')).toBe(true);
  });
});
