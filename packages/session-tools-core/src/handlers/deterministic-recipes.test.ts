import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleTransformData } from './transform-data.ts';
import { TransformDataSchema } from '../tool-defs.ts';
import type { SessionToolContext } from '../context.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'deterministic-recipes-'));
  const session = join(root, 'session');
  const data = join(session, 'data');
  mkdirSync(data, { recursive: true });
  const ctx = { sessionPath: session, dataPath: data } as SessionToolContext;
  return { root, session, data, ctx, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('transform_data deterministic recipes through the actual handler/schema', () => {
  it('batches projection, reports individual failures, and resumes only unchanged successful inputs', async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.session, 'first.json'), JSON.stringify({ data: [{ id: 'a', amount: 4, private: 'omit' }] }));
      writeFileSync(join(f.session, 'second.json'), '{invalid json');
      const args = TransformDataSchema.parse({ recipe: { name: 'json-records-v1', recordsPath: ['data'], select: ['id', 'amount'] }, inputFiles: ['first.json', 'second.json', 'missing.json'], outputFile: 'report.json' });
      const first = await handleTransformData(f.ctx, args);
      expect(first.isError).toBe(true);
      let report = JSON.parse(readFileSync(join(f.data, 'report.json'), 'utf8'));
      expect(report.succeeded).toBe(1);
      expect(report.failed).toBe(2);
      expect(report.files[0].rows).toEqual([{ id: 'a', amount: 4 }]);
      expect(report.files[0].inputSha256).toMatch(/^[a-f0-9]{64}$/);
      writeFileSync(join(f.session, 'second.json'), JSON.stringify({ data: [{ id: 'b', amount: 7 }] }));
      writeFileSync(join(f.session, 'missing.json'), JSON.stringify({ data: [{ id: 'c', amount: 1 }] }));
      const second = await handleTransformData(f.ctx, args);
      expect(second.isError).toBe(false);
      report = JSON.parse(readFileSync(join(f.data, 'report.json'), 'utf8'));
      expect(report.succeeded).toBe(3);
      expect(report.failed).toBe(0);
      expect(report.reused).toBe(1);
      writeFileSync(join(f.session, 'first.json'), JSON.stringify({ data: [{ id: 'a', amount: 9 }] }));
      await handleTransformData(f.ctx, args);
      report = JSON.parse(readFileSync(join(f.data, 'report.json'), 'utf8'));
      expect(report.reused).toBe(2);
      expect(report.files[0].rows[0].amount).toBe(9);
      expect(report.files[0].reused).toBe(false);
    } finally { f.cleanup(); }
  });

  it('rejects forged rows even with a consistent public checksum, and invalidates a changed recipe', async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.session, 'input.json'), JSON.stringify([{ id: 'a', amount: 2 }, { id: 'b', amount: 3 }]));
      const args = TransformDataSchema.parse({ recipe: { name: 'json-records-v1', select: ['id'] }, inputFiles: ['input.json'], outputFile: 'report.json' });
      await handleTransformData(f.ctx, args);
      const cacheDir = join(f.data, '.transform-recipes');
      const path = join(cacheDir, readdirSync(cacheDir)[0]!);
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      receipt.data = '[{"id":"WRONG"}]';
      receipt.sha256 = createHash('sha256').update(receipt.data).digest('hex');
      writeFileSync(path, JSON.stringify(receipt));
      await handleTransformData(f.ctx, args);
      let report = JSON.parse(readFileSync(join(f.data, 'report.json'), 'utf8'));
      expect(report.reused).toBe(0);
      expect(report.files[0].rows).toEqual([{ id: 'a' }, { id: 'b' }]);
      await handleTransformData(f.ctx, { ...args, recipe: { name: 'json-records-v1', filter: { field: 'id', equals: 'b' }, select: ['amount'] } });
      report = JSON.parse(readFileSync(join(f.data, 'report.json'), 'utf8'));
      expect(report.reused).toBe(0);
      expect(report.files[0].rows).toEqual([{ amount: 3 }]);
    } finally { f.cleanup(); }
  });

  it('recomputes legacy unauthenticated receipts and resumes only the new authenticated result', async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.session, 'input.json'), '[{"id":"original"}]');
      const args = TransformDataSchema.parse({ recipe: { name: 'json-records-v1' }, inputFiles: ['input.json'], outputFile: 'report.json' });
      await handleTransformData(f.ctx, args);
      const cacheDir = join(f.data, '.transform-recipes');
      const path = join(cacheDir, readdirSync(cacheDir)[0]!);
      const legacy = JSON.parse(readFileSync(path, 'utf8'));
      delete legacy.mac;
      writeFileSync(path, JSON.stringify(legacy));
      await handleTransformData(f.ctx, args);
      let report = JSON.parse(readFileSync(join(f.data, 'report.json'), 'utf8'));
      expect(report.reused).toBe(0);
      expect(report.files[0].rows).toEqual([{ id: 'original' }]);
      await handleTransformData(f.ctx, args);
      report = JSON.parse(readFileSync(join(f.data, 'report.json'), 'utf8'));
      expect(report.reused).toBe(1);
    } finally { f.cleanup(); }
  });

  it('does not authenticate another process receipt and never persists the signing key', async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.session, 'input.json'), '[{"id":"original"}]');
      const args = TransformDataSchema.parse({ recipe: { name: 'json-records-v1' }, inputFiles: ['input.json'], outputFile: 'report.json' });
      await handleTransformData(f.ctx, args);
      const modulePath = fileURLToPath(new URL('./deterministic-recipes.ts', import.meta.url));
      const source = `import {runDeterministicRecipe} from ${JSON.stringify(modulePath)}; const report = runDeterministicRecipe(${JSON.stringify([join(f.session, 'input.json')])}, ${JSON.stringify(join(f.data, 'child-report.json'))}, ${JSON.stringify(f.data)}, {name:'json-records-v1'}); process.stdout.write(JSON.stringify({reused:report.reused}));`;
      const child = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: f.root }, timeout: 15_000 });
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ reused: 0 });
      // The child published a valid receipt for its own host process only.
      await handleTransformData(f.ctx, args);
      expect(JSON.parse(readFileSync(join(f.data, 'report.json'), 'utf8')).reused).toBe(0);
      const cacheDir = join(f.data, '.transform-recipes');
      const receipt = JSON.parse(readFileSync(join(cacheDir, readdirSync(cacheDir)[0]!), 'utf8'));
      expect(Object.keys(receipt).sort()).toEqual(['data', 'key', 'mac', 'sha256']);
      expect(receipt.mac).toMatch(/^[a-f0-9]{64}$/);
    } finally { f.cleanup(); }
  });

  it('aggregates observed numeric data and rejects strings rather than silently changing totals', async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.session, 'input.json'), JSON.stringify([{ status: 'paid', amount: 2 }, { status: 'paid', amount: 5 }, { status: 'pending', amount: 3 }]));
      const args = TransformDataSchema.parse({ recipe: { name: 'json-records-v1', aggregate: { groupBy: 'status', sums: ['amount'] } }, inputFiles: ['input.json'], outputFile: 'report.json' });
      expect((await handleTransformData(f.ctx, args)).isError).toBe(false);
      const report = JSON.parse(readFileSync(join(f.data, 'report.json'), 'utf8'));
      expect(report.files[0].rows).toEqual([{ group: 'paid', count: 2, sums: { amount: 7 } }, { group: 'pending', count: 1, sums: { amount: 3 } }]);
      writeFileSync(join(f.session, 'input.json'), JSON.stringify([{ status: 'paid', amount: '10' }]));
      expect((await handleTransformData(f.ctx, args)).isError).toBe(true);
      expect(JSON.parse(readFileSync(join(f.data, 'report.json'), 'utf8')).files[0].error).toContain('Non-numeric');
      writeFileSync(join(f.session, 'input.json'), '[{"status":"paid","amount":9007199254740993}]');
      expect((await handleTransformData(f.ctx, args)).isError).toBe(true);
      expect(JSON.parse(readFileSync(join(f.data, 'report.json'), 'utf8')).files[0].error).toContain('unsafe integer');
    } finally { f.cleanup(); }
  });

  it('preserves file containment for recipes and refuses mixed script/recipe execution', async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.root, 'outside.json'), '[]');
      writeFileSync(join(f.session, 'inside.json'), '[]');
      const recipe = { name: 'json-records-v1' } as const;
      expect((await handleTransformData(f.ctx, { recipe, inputFiles: [join(f.root, 'outside.json')], outputFile: 'report.json' })).isError).toBe(true);
      expect((await handleTransformData(f.ctx, { recipe, language: 'node', script: 'throw Error("must never run")', inputFiles: ['inside.json'], outputFile: 'report.json' })).isError).toBe(true);
      if (process.platform !== 'win32') {
        symlinkSync(f.root, join(f.data, '.transform-recipes'), 'dir');
        const result = await handleTransformData(f.ctx, { recipe, inputFiles: ['inside.json'], outputFile: 'report.json' });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain('cache escapes');
      }
    } finally { f.cleanup(); }
  });
});
