import { describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectContextFileDiscovery } from '../project-context-files.ts';
import { getSystemPromptAsync, invalidateContextFileCache } from '../system.ts';

function entry(name: string, type: 'file' | 'directory' | 'symlink' = 'file') {
  return { name, isFile: () => type === 'file', isDirectory: () => type === 'directory' };
}

describe('bounded asynchronous project context discovery', () => {
  it('preserves root instructions and case-insensitive nested files without following symlinks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'robb-context-'));
    try {
      await mkdir(join(directory, 'package'));
      await mkdir(join(directory, 'node_modules'));
      await Promise.all([
        writeFile(join(directory, 'AGENTS.md'), 'root'),
        writeFile(join(directory, 'claude.md'), 'root'),
        writeFile(join(directory, 'package', 'Agents.md'), 'nested'),
        writeFile(join(directory, 'node_modules', 'AGENTS.md'), 'excluded'),
        symlink(directory, join(directory, 'package', 'loop')),
      ]);
      const scanner = new ProjectContextFileDiscovery();
      expect(await scanner.discover(directory)).toEqual({
        files: ['AGENTS.md', 'claude.md', 'package/Agents.md'], complete: true,
      });
      const prompt = await getSystemPromptAsync('', undefined, undefined, directory, 'default', undefined, false);
      expect(prompt).toContain('- AGENTS.md (root)');
      expect(prompt).toContain('- claude.md (root)');
      expect(prompt).toContain('- package/Agents.md');
      expect(prompt).not.toContain('node_modules/AGENTS.md');
    } finally {
      invalidateContextFileCache(directory);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('bounds directories while traversing, even when there are no matching files', async () => {
    const scanned: string[] = [];
    const scanner = new ProjectContextFileDiscovery({
      maxDirectories: 8,
      readDirectory: async function* (path) {
        scanned.push(path);
        for (let i = 0; i < 1_000; i++) yield entry(`child-${i}`, 'directory');
      },
    });
    expect(await scanner.discover('/synthetic')).toEqual({ files: [], complete: false });
    expect(scanned).toHaveLength(8);
  });

  it('stops at the file, entry and depth budgets instead of walking the remainder', async () => {
    let visits = 0;
    const fileScanner = new ProjectContextFileDiscovery({
      maxFiles: 3,
      readDirectory: async function* (path) {
        visits++;
        yield entry('AGENTS.md');
        if (path === '/synthetic') for (let i = 0; i < 100; i++) yield entry(`child-${i}`, 'directory');
      },
    });
    const files = await fileScanner.discover('/synthetic');
    expect(files.files).toHaveLength(3);
    expect(files.files[0]).toBe('AGENTS.md');
    expect(files.complete).toBe(false);
    expect(visits).toBe(3);

    let entries = 0;
    const entryScanner = new ProjectContextFileDiscovery({
      maxEntries: 5,
      readDirectory: async function* () {
        for (let i = 0; i < 100; i++) { entries++; yield entry(`file-${i}`); }
      },
    });
    expect((await entryScanner.discover('/synthetic')).complete).toBe(false);
    expect(entries).toBe(6);

    let deepest = 0;
    const depthScanner = new ProjectContextFileDiscovery({
      maxDepth: 2,
      readDirectory: async function* (path) {
        deepest = Math.max(deepest, path.split('/').length - 2);
        yield entry('nested', 'directory');
      },
    });
    expect((await depthScanner.discover('/synthetic')).complete).toBe(false);
    expect(deepest).toBe(2);
  });

  it('keeps the event loop available and returns by its deadline when a directory read stalls', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let closed = false;
    const scanner = new ProjectContextFileDiscovery({
      timeoutMs: 20,
      readDirectory: async function* () {
        try { await gate; yield entry('late.md'); }
        finally { closed = true; }
      },
    });
    let heartbeat = false;
    setTimeout(() => { heartbeat = true; }, 0);
    const first = scanner.discover('/synthetic');
    expect(scanner.discover('/synthetic')).toBe(first);
    const result = await first;
    expect(heartbeat).toBe(true);
    expect(result).toEqual({ files: [], complete: false });
    scanner.invalidate('/synthetic');
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(closed).toBe(true);
    expect(result.files).toEqual([]);
    expect(scanner.getCached('/synthetic')).toBeUndefined();
  });

  it('does not accumulate stalled OS reads after deadlines or cache invalidation', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    const scanner = new ProjectContextFileDiscovery({
      maxConcurrentScans: 2, timeoutMs: 10,
      readDirectory: async function* () { reads++; await gate; yield entry('AGENTS.md'); },
    });
    await Promise.all([scanner.discover('/one'), scanner.discover('/two')]);
    scanner.invalidate();
    expect(await scanner.discover('/three')).toEqual({ files: [], complete: false });
    expect(reads).toBe(2);
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    scanner.invalidate('/three');
    expect((await scanner.discover('/three')).files).toEqual(['AGENTS.md']);
    expect(reads).toBe(3);
  });

  it('deduplicates scans, bounds the cache and never restores an invalidated result', async () => {
    let reads = 0;
    const scanner = new ProjectContextFileDiscovery({
      maxCacheEntries: 2,
      readDirectory: async function* () { reads++; yield entry('AGENTS.md'); },
    });
    const pending = scanner.discover('/one');
    scanner.invalidate('/one');
    await pending;
    expect(scanner.getCached('/one')).toBeUndefined();
    await scanner.discover('/one');
    await scanner.discover('/one');
    expect(reads).toBe(2);
    await scanner.discover('/two');
    await scanner.discover('/three');
    expect(scanner.getCached('/one')).toBeUndefined();
    expect(scanner.getCached('/two')?.files).toEqual(['AGENTS.md']);
  });

  it('describes unreadable discovery as partial so agents still check applicable instructions', async () => {
    const scanner = new ProjectContextFileDiscovery({
      readDirectory: async function* () { throw new Error('EACCES'); },
    });
    expect(await scanner.discover('/unavailable')).toEqual({ files: [], complete: false });
    const prompt = await getSystemPromptAsync('', undefined, undefined, '/nonexistent/robb-context-fixture', 'default', undefined, false);
    expect(prompt).toContain('check applicable AGENTS.md and CLAUDE.md instructions');
    expect(prompt).toContain('this index is not exhaustive');
    invalidateContextFileCache('/nonexistent/robb-context-fixture');
  });
});
