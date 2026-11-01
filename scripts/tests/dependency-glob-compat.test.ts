import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as asar from '@electron/asar';
import { glob, globSync } from 'glob';
import { Minimatch, minimatch } from 'minimatch';

const require = createRequire(import.meta.url);
const temporary: string[] = [];
interface MatchOptions { cwd: string; dot?: boolean; ignore?: string[] }
type LegacyGlob = ((pattern: string, options: MatchOptions,
  callback: (error: Error | null, matches: string[]) => void) => void) & {
    sync: (pattern: string, options: MatchOptions) => string[];
  };
function isLegacyGlob(value: unknown): value is LegacyGlob {
  return typeof value === 'function' && 'sync' in value && typeof value.sync === 'function';
}
function isMinimatch(value: unknown): value is typeof minimatch {
  return typeof value === 'function' && 'Minimatch' in value && typeof value.Minimatch === 'function';
}
type ArchiveApi = Pick<typeof asar, 'createPackage' | 'listPackage' | 'extractFile'>;
function isAsar(value: unknown): value is ArchiveApi {
  return typeof value === 'object' && value !== null &&
    'createPackage' in value && typeof value.createPackage === 'function' &&
    'listPackage' in value && typeof value.listPackage === 'function' &&
    'extractFile' in value && typeof value.extractFile === 'function';
}
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'robb-glob-compat-'));
  temporary.push(root);
  for (const name of ['input', 'input/nested', 'input/ignored']) mkdirSync(join(root, name));
  for (const name of ['one.txt', 'one.js', '.hidden.txt', 'nested/two.txt', 'ignored/skip.txt']) {
    writeFileSync(join(root, 'input', name), 'synthetic:' + name);
  }
  return root;
}
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('secure glob dependency compatibility', () => {
  it('preserves callable CommonJS and modern named imports', () => {
    const legacy: unknown = require('minimatch');
    if (!isMinimatch(legacy)) throw new Error('Legacy callable API is missing');
    expect(legacy('src/file.ts', '**/*.ts')).toBe(true);
    expect(legacy('src/file.js', '**/*.ts')).toBe(false);
    expect(legacy.defaults({ nocase: true })('README.MD', '*.md')).toBe(true);
    expect(legacy.braceExpand('{a,b}.txt')).toEqual(['a.txt', 'b.txt']);
    expect(new legacy.Minimatch('*.txt').match('one.txt')).toBe(true);
    expect(minimatch('.hidden.txt', '*.txt')).toBe(false);
    expect(minimatch('.hidden.txt', '*.txt', { dot: true })).toBe(true);
    expect(minimatch('file.js', '!*.ts')).toBe(true);
    expect(minimatch('nested/file.ts', 'nested\\*.ts', { windowsPathsNoEscape: true })).toBe(true);
  });
  it('bounds the advisory preprocessing amplification while retaining matching', () => {
    const matcher = new Minimatch('**/../'.repeat(20) + 'x', { optimizationLevel: 2, braceExpandMax: 16 });
    expect(matcher.globParts.length).toBeLessThanOrEqual(16);
    expect(matcher.match('x')).toBe(false);
    expect(new Minimatch('src/**/*.ts', { optimizationLevel: 2 }).match('src/file.ts')).toBe(true);
  });
  it('keeps legacy callback/sync and modern async/sync file selection equivalent', async () => {
    const root = fixture();
    const legacy: unknown = createRequire(require.resolve('rimraf'))('glob');
    if (!isLegacyGlob(legacy)) throw new Error('Legacy glob callback/sync API is missing');
    const options = { cwd: join(root, 'input'), ignore: ['ignored/**'] };
    const expected = ['nested/two.txt', 'one.txt'];
    const result = await new Promise<string[]>((resolve, reject) => {
      legacy('**/*.txt', options, (error, matches) => { if (error) reject(error); else resolve(matches); });
    });
    expect(result.sort()).toEqual(expected);
    expect(legacy.sync('**/*.txt', options).sort()).toEqual(expected);
    expect((await glob('**/*.txt', options)).sort()).toEqual(expected);
    expect(globSync('**/*.txt', options).sort()).toEqual(expected);
    expect(legacy.sync('*.txt', { ...options, dot: true }).sort()).toEqual(['.hidden.txt', 'one.txt']);
  });
  it('packs and reads synthetic Electron archives through both installed asar generations', async () => {
    const root = fixture();
    const legacy: unknown = createRequire(require.resolve('app-builder-lib'))('@electron/asar');
    if (!isAsar(legacy)) throw new Error('Installer asar API is missing');
    for (const [index, api] of [asar, legacy].entries()) {
      const archive = join(root, `fixture-${index}.asar`);
      await api.createPackage(join(root, 'input'), archive);
      expect(api.listPackage(archive, { isPack: false }).map((name) => name.replaceAll('\\', '/'))).toContain('/nested/two.txt');
      expect(api.extractFile(archive, 'nested/two.txt').toString()).toBe('synthetic:nested/two.txt');
    }
  });
});
