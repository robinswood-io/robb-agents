import { expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setBundledAssetsRoot } from '../utils/paths.ts';
import { getBundledDocs } from './index.ts';

it('assembles complete documentation in declared order and rejects incomplete sections', () => {
  const root = mkdtempSync(join(tmpdir(), 'robb-doc-parts-'));
  const docs = join(root, 'resources', 'docs');
  const errors: string[] = [];
  const error = spyOn(console, 'error').mockImplementation((message: unknown) => {
    errors.push(String(message));
  });
  try {
    for (const name of ['guide', 'broken', 'invalid']) mkdirSync(join(docs, name), { recursive: true });
    writeFileSync(join(docs, 'plain.md'), 'Unchanged plain document\n');
    writeFileSync(join(docs, 'guide', 'index.json'), JSON.stringify(['b.md', 'a.md']));
    writeFileSync(join(docs, 'guide', 'a.md'), 'Second section\n');
    writeFileSync(join(docs, 'guide', 'b.md'), 'First section\n');
    writeFileSync(join(docs, 'broken', 'index.json'), JSON.stringify(['first.md', 'missing.md']));
    writeFileSync(join(docs, 'broken', 'first.md'), 'This partial document must not be exposed');
    writeFileSync(join(docs, 'invalid', 'index.json'), JSON.stringify(['../../secret.md']));
    writeFileSync(join(root, 'resources', 'secret.md'), 'Outside the document directory');
    setBundledAssetsRoot(root);
    const result = getBundledDocs();
    expect(result['plain.md']).toBe('Unchanged plain document\n');
    expect(result['guide.md']).toBe('First section\nSecond section\n');
    expect(Object.hasOwn(result, 'broken.md')).toBe(false);
    expect(Object.hasOwn(result, 'invalid.md')).toBe(false);
    expect(errors).toHaveLength(2);
    expect(errors.some(message => message.includes('broken'))).toBe(true);
    expect(errors.some(message => message.includes('invalid'))).toBe(true);
  } finally {
    error.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
